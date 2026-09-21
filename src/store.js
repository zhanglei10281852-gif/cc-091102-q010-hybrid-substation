import { Journal } from './journal.js';
import { KeyedMutex } from './mutex.js';

// 容量扫描：候选窗口 [startsMs, endsMs) 叠加后，任一瞬时的并发占用是否超过 capacity。
// 返回 null 表示安全；否则返回违例瞬间正在占用该资源的 commandId 列表（即阻断方）。
export function capacityBreach(intervals, startsMs, endsMs, capacity) {
  const events = [];
  for (const iv of intervals) {
    if (iv.endsMs <= startsMs || iv.startsMs >= endsMs) continue; // 半开区间，首尾相接不算冲突
    events.push({ t: Math.max(iv.startsMs, startsMs), d: 1, id: iv.commandId });
    events.push({ t: Math.min(iv.endsMs, endsMs), d: -1, id: iv.commandId });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d); // 同一时刻先处理结束再处理开始
  const active = new Set();
  for (const event of events) {
    if (event.d === 1) active.add(event.id);
    else active.delete(event.id);
    if (active.size + 1 > capacity) return [...active].sort();
  }
  return null;
}

export class Store {
  constructor(config, { journal = null, now = () => Date.now() } = {}) {
    this.config = config;
    this.journal = journal;
    this.now = now;
    this.mutex = new KeyedMutex();
    this.windows = new Map(); // resource -> Map(commandId -> {startsAt, endsAt}) 已落定窗口
    this.holds = new Map(); // resource -> Map(commandId -> {startsAt, endsAt, expiresAt}) 临时占用
    this.reservations = new Map(); // commandId -> 预约记录（approved/cancelled）
    this.results = new Map(); // commandId -> {fingerprint, result} 幂等结论
    this.inflight = new Map(); // commandId -> {fingerprint, promise} 在途命令（单飞）
    this.holdFingerprints = new Map(); // commandId -> 占用日志携带的指纹（恢复时用）
    this.sweeper = null;
    for (const name of Object.keys(config.resources)) {
      this.windows.set(name, new Map());
      this.holds.set(name, new Map());
    }
  }

  // 打开存储：可选地重放运行日志并做恢复收尾
  static async open(config, { journalPath = null, now } = {}) {
    const journal = journalPath ? await Journal.create(journalPath) : null;
    const store = new Store(config, { journal, now });
    if (journal) {
      for (const event of await Journal.load(journalPath)) store.applyEvent(event);
      store.recover();
    }
    return store;
  }

  async flushJournal() {
    await this.journal?.flush();
  }

  startSweeper(intervalMs = this.config.sweepIntervalMs ?? 5_000) {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.purgeExpiredHolds(), intervalMs);
    this.sweeper.unref?.();
  }

  stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  // 回收到期占用。正常流程里占用只存在毫秒级，TTL 是崩溃/异常路径的安全网。
  purgeExpiredHolds(onlyResource = null) {
    const now = this.now();
    let purged = 0;
    for (const [resource, holds] of this.holds) {
      if (onlyResource && resource !== onlyResource) continue;
      for (const [commandId, hold] of holds) {
        if (Date.parse(hold.expiresAt) <= now) {
          holds.delete(commandId);
          purged += 1;
        }
      }
    }
    return purged;
  }

  intervalsFor(resource, excludeCommandId = null) {
    const out = [];
    for (const [commandId, w] of this.windows.get(resource) ?? []) {
      if (commandId === excludeCommandId) continue;
      out.push({ commandId, startsMs: Date.parse(w.startsAt), endsMs: Date.parse(w.endsAt) });
    }
    for (const [commandId, h] of this.holds.get(resource) ?? []) {
      if (commandId === excludeCommandId) continue;
      out.push({ commandId, startsMs: Date.parse(h.startsAt), endsMs: Date.parse(h.endsAt) });
    }
    return out;
  }

  // 状态相关冲突检查。调用方必须已持有该资源的锁，检查与后续占用写入是原子的。
  checkResource(resource, command) {
    this.purgeExpiredHolds(resource);
    const conflicts = [];
    const capacity = this.config.resources[resource]?.capacity ?? 1;
    const intervals = this.intervalsFor(resource, command.commandId);
    const blockers = capacityBreach(intervals, command.startsMs, command.endsMs, capacity);
    if (blockers) conflicts.push({ kind: 'calendar-overlap', resource, blockingCommandIds: blockers });
    const quota = this.config.rollingQuota;
    if (quota) {
      const from = command.startsMs - quota.windowMs;
      const to = command.startsMs + quota.windowMs;
      const count = intervals.filter((iv) => iv.startsMs > from && iv.startsMs < to).length;
      if (count + 1 > quota.max) {
        conflicts.push({ kind: 'rolling-quota', resource, count, max: quota.max, windowMs: quota.windowMs });
      }
    }
    return conflicts;
  }

  applyHold(resource, command, expiresAt) {
    this.holds.get(resource).set(command.commandId, {
      startsAt: command.startsAt,
      endsAt: command.endsAt,
      expiresAt,
    });
  }

  releaseHold(resource, commandId) {
    this.holds.get(resource)?.delete(commandId);
  }

  async journalHolds(command, expiresAt, fingerprint) {
    await this.journal?.append({
      op: 'holds',
      commandId: command.commandId,
      resources: command.resources,
      startsAt: command.startsAt,
      endsAt: command.endsAt,
      expiresAt,
      fingerprint,
    });
  }

  // 落库：先写日志，再把窗口一次性写入全部资源视图（同步完成，读者不会看到半成品）
  async commit(record, fingerprint) {
    await this.journal?.append({ op: 'commit', record, fingerprint });
    record.fingerprint = fingerprint;
    for (const resource of record.resources) {
      this.windows.get(resource).set(record.commandId, { startsAt: record.startsAt, endsAt: record.endsAt });
    }
    this.reservations.set(record.commandId, record);
  }

  async cancelRecord(record) {
    const cancelledAt = new Date(this.now()).toISOString();
    await this.journal?.append({ op: 'cancel', commandId: record.commandId, cancelledAt });
    record.state = 'cancelled';
    record.cancelledAt = cancelledAt;
    for (const resource of record.resources) this.windows.get(resource)?.delete(record.commandId);
    return record;
  }

  // 结论落内存即可靠返回；日志是崩溃后的兜底，失败不阻塞
  recordResult(commandId, fingerprint, result) {
    this.results.set(commandId, { fingerprint, result });
    if (this.journal) this.journal.append({ op: 'result', commandId, fingerprint, result }).catch(() => {});
  }

  getCalendar(resource, { from = null, to = null } = {}) {
    this.purgeExpiredHolds(resource);
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const inRange = (w) => Date.parse(w.startsAt) < toMs && Date.parse(w.endsAt) > fromMs;
    const windows = [];
    for (const [commandId, w] of this.windows.get(resource) ?? []) {
      if (inRange(w)) windows.push({ commandId, ...w });
    }
    const holds = [];
    for (const [commandId, h] of this.holds.get(resource) ?? []) {
      if (inRange(h)) holds.push({ commandId, ...h });
    }
    return { resource, capacity: this.config.resources[resource]?.capacity ?? 1, windows, holds };
  }

  stats() {
    let holds = 0;
    let approved = 0;
    let cancelled = 0;
    for (const h of this.holds.values()) holds += h.size;
    for (const record of this.reservations.values()) {
      if (record.state === 'approved') approved += 1;
      else if (record.state === 'cancelled') cancelled += 1;
    }
    return { resources: this.windows.size, reservations: this.reservations.size, approved, cancelled, holds };
  }

  // 容量不变量：任一资源在任一瞬时的占用（窗口+占用）不得超过容量。供测试与自检使用。
  assertCapacityInvariant() {
    for (const [resource, cfg] of Object.entries(this.config.resources)) {
      const events = [];
      for (const iv of this.intervalsFor(resource)) {
        events.push([iv.startsMs, 1], [iv.endsMs, -1]);
      }
      events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let current = 0;
      let peak = 0;
      for (const [, d] of events) {
        current += d;
        if (current > peak) peak = current;
      }
      if (peak > (cfg.capacity ?? 1)) {
        throw new Error(`capacity-invariant-violation:${resource}:${peak}`);
      }
    }
    return true;
  }

  applyEvent(event) {
    switch (event.op) {
      case 'holds':
        if (event.fingerprint) this.holdFingerprints.set(event.commandId, event.fingerprint);
        for (const resource of event.resources) {
          this.holds.get(resource)?.set(event.commandId, {
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            expiresAt: event.expiresAt,
          });
        }
        break;
      case 'commit': {
        const record = event.record;
        if (event.fingerprint) record.fingerprint = event.fingerprint;
        this.reservations.set(record.commandId, record);
        for (const resource of record.resources) {
          this.windows.get(resource)?.set(record.commandId, { startsAt: record.startsAt, endsAt: record.endsAt });
          this.holds.get(resource)?.delete(record.commandId);
        }
        break;
      }
      case 'cancel': {
        const record = this.reservations.get(event.commandId);
        if (record) {
          record.state = 'cancelled';
          record.cancelledAt = event.cancelledAt;
          for (const resource of record.resources) this.windows.get(resource)?.delete(event.commandId);
        }
        break;
      }
      case 'result':
        this.results.set(event.commandId, { fingerprint: event.fingerprint, result: event.result });
        break;
      default:
        break;
    }
  }

  // 恢复收尾：到期占用回收；悬挂占用补偿并留下 recovery 结论；
  // 已提交但缺少结论的预约补齐 approved 结论，保证重试能读到首次结果。
  recover() {
    const report = { purgedHolds: 0, compensatedHolds: [], finalizedResults: [] };
    report.purgedHolds = this.purgeExpiredHolds();
    const dangling = new Map(); // commandId -> resources[]
    for (const [resource, holds] of this.holds) {
      for (const commandId of holds.keys()) {
        if (this.reservations.get(commandId)?.state === 'approved') {
          holds.delete(commandId); // 已被落定窗口取代
          continue;
        }
        if (!dangling.has(commandId)) dangling.set(commandId, []);
        dangling.get(commandId).push(resource);
      }
    }
    for (const [commandId, resources] of dangling) {
      for (const resource of resources) this.holds.get(resource).delete(commandId);
      if (!this.results.has(commandId)) {
        const fingerprint = this.holdFingerprints.get(commandId) ?? null;
        this.results.set(commandId, {
          fingerprint,
          result: {
            state: 'rejected',
            commandId,
            reason: 'recovery',
            detail: '命令在写入点之间中断，已取得占用已补偿',
            resources: resources.sort(),
          },
        });
        report.compensatedHolds.push(commandId);
      }
      this.holdFingerprints.delete(commandId);
    }
    for (const record of this.reservations.values()) {
      if (record.state === 'approved' && !this.results.has(record.commandId)) {
        this.results.set(record.commandId, {
          fingerprint: record.fingerprint ?? null,
          result: {
            state: 'approved',
            commandId: record.commandId,
            resources: record.resources,
            startsAt: record.startsAt,
            endsAt: record.endsAt,
          },
        });
        report.finalizedResults.push(record.commandId);
      }
    }
    return report;
  }
}
