// 联锁停电预约领域服务。
//
// 并发正确性：
//  - 所有命令按资源名全局稳定排序后逐个加锁，不存在“持有 A 等 B、持有 B 等 A”的环；
//    锁再带 TTL 与获取超时，进程在加锁途中死亡也不会留下悬挂窗口。
//  - 评估、落盘在全部锁内同步完成（中间无 await），两个计划交叉争抢要么先后通过，
//    要么超时方拿到具体阻断资源。
//  - 任一写入点中断：提交阶段删除已写窗口补偿；取消阶段还原已删窗口补偿。
//  - commandId 是幂等键：批准/取消结论永久重放，网络重试不会产生第二组窗口；
//    冲突拒绝不持久化（阻断条件可能解除），503 锁等待为瞬时错误可安全重试。

import { catalog } from './catalog.js';
import { LockTimeoutError } from './store.js';

export const conflictKinds = ['calendar-overlap', 'rolling-quota', 'protected-period', 'dependency-conflict'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, code, details = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const iso = (ms) => new Date(ms).toISOString();

export function normalizeCommand(input) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'invalid-command', { reason: 'body-must-be-object' });
  }
  const { commandId, resources, startsAt, endsAt } = input;
  if (typeof commandId !== 'string' || !commandId.trim()) {
    throw new HttpError(400, 'invalid-command', { field: 'commandId' });
  }
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new HttpError(400, 'invalid-command', { field: 'resources' });
  }
  if (!resources.every((r) => typeof r === 'string')) {
    throw new HttpError(400, 'invalid-command', { field: 'resources' });
  }
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (Number.isNaN(start)) throw new HttpError(400, 'invalid-command', { field: 'startsAt' });
  if (Number.isNaN(end)) throw new HttpError(400, 'invalid-command', { field: 'endsAt' });
  if (start >= end) throw new HttpError(400, 'invalid-command', { field: 'range', reason: 'endsAt-must-be-after-startsAt' });

  const sorted = [...new Set(resources)].sort();
  const unknown = sorted.filter((r) => !catalog.resources[r]);
  if (unknown.length) throw new HttpError(404, 'unknown-resource', { resources: unknown });

  return { commandId: commandId.trim(), resources: sorted, start, end };
}

// ---- 冲突评估 ---------------------------------------------------------------

function dependencyBlockers(command) {
  const blockers = [];
  for (const group of catalog.lockGroups) {
    const hit = group.filter((r) => command.resources.includes(r));
    if (hit.length > 0 && hit.length < group.length) {
      for (const resource of group) {
        if (!hit.includes(resource)) {
          blockers.push({ resource, kind: 'dependency-conflict', lockGroup: group, requested: hit });
        }
      }
    }
  }
  return blockers;
}

function evaluateConflicts(store, command) {
  const blockers = dependencyBlockers(command);

  for (const resource of command.resources) {
    const spec = catalog.resources[resource];
    const overlapping = store.windowsOverlapping(resource, command.start, command.end);

    // 容量：把新窗口并入后做扫描线，区间内最大并发不得超过容量。
    const events = [
      { t: command.start, d: 1 },
      { t: command.end, d: -1 },
    ];
    for (const w of overlapping) {
      events.push({ t: w.start, d: 1 }, { t: w.end, d: -1 });
    }
    // 同一时刻先收尾后开工：首尾相接不算重叠，不会误判容量。
    events.sort((a, b) => a.t - b.t || a.d - b.d);
    let current = 0;
    let peak = 0;
    for (const e of events) {
      current += e.d;
      if (current > peak) peak = current;
    }
    if (peak > spec.capacity) {
      for (const w of overlapping) {
        blockers.push({ resource, kind: 'calendar-overlap', conflictingCommand: w.commandId });
      }
    }

    if (spec.rollingQuota) {
      const { windowMs, maxCount } = spec.rollingQuota;
      const recent = store
        .listWindows(resource)
        .filter((w) => w.start >= command.start - windowMs && w.start < command.end);
      if (recent.length + 1 > maxCount) {
        blockers.push({
          resource,
          kind: 'rolling-quota',
          maxCount,
          windowMs,
          withinWindow: recent.map((w) => w.commandId),
        });
      }
    }

    for (const period of spec.protectedPeriods ?? []) {
      if (command.start < period.end && command.end > period.start) {
        blockers.push({ resource, kind: 'protected-period', reason: period.reason });
      }
    }
  }
  return blockers;
}

// ---- 加锁 -------------------------------------------------------------------

async function acquireAll(store, resources, commandId, options) {
  const { lockTimeoutMs, retryDelayMs, sleep: doSleep } = options;
  const deadline = store.now() + lockTimeoutMs;
  const held = [];
  try {
    for (const resource of resources) {
      while (!store.tryLock(resource, commandId)) {
        if (store.now() >= deadline) {
          const blockers = resources
            .slice(resources.indexOf(resource))
            .map((r) => store.blockerOf(r))
            .filter(Boolean);
          throw new LockTimeoutError(
            blockers.length ? blockers : [{ resource, commandId: null, expiresAt: null }],
          );
        }
        await doSleep(retryDelayMs);
      }
      held.push(resource);
    }
    return held;
  } catch (err) {
    // 超时或加锁写入点中断：立即释放已取得的锁，TTL 仅作进程死亡时的兜底。
    for (const heldResource of held) store.unlock(heldResource, commandId);
    throw err;
  }
}

// ---- 服务 -------------------------------------------------------------------

export function createReservationService(store, options = {}) {
  const settings = {
    lockTimeoutMs: options.lockTimeoutMs ?? 5000,
    retryDelayMs: options.retryDelayMs ?? 10,
    sleep: options.sleep ?? sleep,
  };
  // 不变量：一次获取的等待上限必须小于锁 TTL——否则等待后续资源时，
  // 已持有的锁会先过期并被旁人拿走，串行化保证被破坏。
  if (settings.lockTimeoutMs >= store.lockTtlMs) {
    throw new Error('misconfigured-locks: lockTimeoutMs must be smaller than store.lockTtlMs');
  }

  function present(record, extra = {}) {
    return {
      commandId: record.commandId,
      state: record.state,
      resources: record.resources,
      startsAt: iso(record.start),
      endsAt: iso(record.end),
      ...(record.cancelReason ? { cancelReason: record.cancelReason } : {}),
      ...extra,
    };
  }

  return {
    /** 受理预约：返回 approved（三个视图同时落定）或 rejected（附全部阻断资源）。 */
    async reserve(rawCommand) {
      const command = normalizeCommand(rawCommand);
      const { commandId } = command;

      const prior = store.getCommand(commandId);
      if (prior) {
        if (prior.state === 'approved') return { decision: 'approved', ...present(prior), retried: true };
        throw new HttpError(409, 'command-finalized', { state: prior.state });
      }

      // 联锁依赖不完整无需加锁，直接给出缺哪些资源。
      const dependencyOnly = dependencyBlockers(command);
      if (dependencyOnly.length) {
        return { decision: 'rejected', commandId, resources: command.resources, blockers: dependencyOnly };
      }

      await acquireAll(store, command.resources, commandId, settings);
      try {
        const blockers = evaluateConflicts(store, command);
        if (blockers.length) {
          return { decision: 'rejected', commandId, resources: command.resources, blockers };
        }

        const record = { ...command, state: 'approved' };
        try {
          store.commitWindows(command);
          store.saveCommand(record);
        } catch (err) {
          // 任一写入点中断（窗口落盘或结论落盘）：静默补偿已写窗口，
          // 不落任何结论，同命令重试可重新受理。
          store.removeWindows(commandId, command.resources, { silent: true });
          throw new HttpError(503, 'commit-failed', { cause: String(err?.message ?? err) });
        }
        return { decision: 'approved', ...present(record), retried: false };
      } finally {
        for (const resource of command.resources) store.unlock(resource, commandId);
      }
    },

    /** 取消预约：同样按稳定顺序加锁，删除失败则还原，取消结论幂等重放。 */
    async cancel(commandId, reason = 'planner-cancelled') {
      const prior = store.getCommand(commandId);
      if (!prior) throw new HttpError(404, 'command-not-found', { commandId });
      if (prior.state === 'cancelled') return { ...present(prior), retried: true };
      if (prior.state !== 'approved') throw new HttpError(409, 'command-finalized', { state: prior.state });

      const resources = [...prior.resources].sort();
      await acquireAll(store, resources, commandId, settings);
      try {
        // 先完整快照：删除点中途崩溃时据此还原，保证“批准”结论与三个视图一致。
        const backup = store.peekWindows(commandId, resources);
        try {
          store.removeWindows(commandId, resources);
          store.saveCommand({ ...prior, state: 'cancelled', cancelReason: reason });
        } catch (err) {
          store.restoreWindows(backup);
          throw new HttpError(503, 'cancel-failed', { cause: String(err?.message ?? err) });
        }
        const record = store.getCommand(commandId);
        return { ...present(record), retried: false, releasedWindows: backup.length };
      } finally {
        for (const resource of resources) store.unlock(resource, commandId);
      }
    },

    get(commandId) {
      const record = store.getCommand(commandId);
      if (!record) throw new HttpError(404, 'command-not-found', { commandId });
      return present(record);
    },

    /** 三个资源视图 + 命令结论；每个命令在其所涉视图里结论必须一致。 */
    views() {
      const resources = {};
      for (const resource of Object.keys(catalog.resources).sort()) {
        resources[resource] = store.listWindows(resource).map((w) => ({
          commandId: w.commandId,
          startsAt: iso(w.start),
          endsAt: iso(w.end),
        }));
      }
      const commands = {};
      for (const [id, record] of store.commands) commands[id] = present(record);
      return { at: iso(store.now()), resources, commands };
    },

    /** 崩溃/超时对账：释放过期锁，按命令结论把三个资源视图修到一致。 */
    recover() {
      const releasedLocks = store.recoverStaleLocks();
      const windows = store.reconcileWindows();
      return { at: iso(store.now()), releasedLocks, ...windows };
    },
  };
}

/**
 * 校验某命令在全部所涉资源视图里只有一个共同结论：
 * 批准则每个视图都有窗口，取消/拒绝则一个视图都不能有。
 */
export function commonConclusionAcrossViews(store, commandId) {
  const record = store.getCommand(commandId);
  if (!record) return { commandId, consistent: false, reason: 'no-record' };
  const presentOn = record.resources.filter((r) =>
    store.listWindows(r).some((w) => w.commandId === commandId),
  );
  if (record.state === 'approved') {
    return {
      commandId,
      consistent: presentOn.length === record.resources.length,
      state: record.state,
      presentOn,
      missingOn: record.resources.filter((r) => !presentOn.includes(r)),
    };
  }
  return { commandId, consistent: presentOn.length === 0, state: record.state, presentOn };
}

// 兼容基线命名：startup 恢复清理悬挂锁。
export function recover(store) {
  return createReservationService(store).recover();
}
