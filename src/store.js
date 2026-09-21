// 内存存储：每资源一把互斥锁（稳定顺序获取、带 TTL）、按资源的窗口日历、
// 命令结论表（commandId 幂等的唯一事实源）。
// faults 钩子用于在锁/提交/取消/落盘任一写入点注入中断，验证补偿与恢复。

export class LockTimeoutError extends Error {
  constructor(blockers) {
    super(`lock-timeout:${blockers.map((b) => b.resource).join(',')}`);
    this.code = 'lock-timeout';
    this.status = 503;
    this.blockers = blockers;
  }
}

export class Store {
  constructor({ now, lockTtlMs = 10_000, faults = {} } = {}) {
    this._now = now;
    this.lockTtlMs = lockTtlMs;
    this.faults = faults;
    /** @type {Map<string, {commandId:string, expiresAt:number}>} */
    this.locks = new Map();
    /** @type {Map<string, Array<{commandId:string, start:number, end:number}>>} */
    this.windows = new Map();
    /** @type {Map<string, object>} */
    this.commands = new Map();
  }

  now() {
    return this._now ? this._now() : Date.now();
  }

  // ---- 锁 -----------------------------------------------------------------

  _expireLocks() {
    const now = this.now();
    for (const [resource, lock] of this.locks) {
      if (lock.expiresAt <= now) this.locks.delete(resource);
    }
  }

  /**
   * 尝试获取资源锁。同一 commandId 重入成功（故障后原命令重试）；
   * 被其他命令持有返回 null（调用方据此等待或超时）。
   */
  tryLock(resource, commandId) {
    this.faults.lock?.(resource, commandId);
    this._expireLocks();
    const existing = this.locks.get(resource);
    if (existing && existing.commandId !== commandId) return null;
    this.locks.set(resource, { commandId, expiresAt: this.now() + this.lockTtlMs });
    return { resource, commandId };
  }

  unlock(resource, commandId) {
    // 解锁失败不得掩盖主流程结论：残留锁由 TTL + recoverStaleLocks 兜底。
    const existing = this.locks.get(resource);
    if (existing && existing.commandId === commandId) this.locks.delete(resource);
  }

  blockerOf(resource) {
    this._expireLocks();
    const lock = this.locks.get(resource);
    return lock ? { resource, commandId: lock.commandId, expiresAt: lock.expiresAt } : null;
  }

  /** 启动/定时恢复：释放所有已超时的锁，返回被清理的资源。 */
  recoverStaleLocks() {
    const now = this.now();
    const expired = [];
    for (const [resource, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        expired.push({ resource, commandId: lock.commandId });
        this.locks.delete(resource);
      }
    }
    return expired;
  }

  /** 管理兜底：无条件清锁（对应基线 recover 语义，正常流程不应使用）。 */
  clearAllHolds() {
    const held = [...this.locks.keys()];
    this.locks.clear();
    return held;
  }

  // ---- 命令结论 -------------------------------------------------------------

  getCommand(commandId) {
    return this.commands.get(commandId) ?? null;
  }

  saveCommand(record) {
    this.faults.save?.(record);
    this.commands.set(record.commandId, { ...record, savedAt: this.now() });
  }

  // ---- 窗口日历（按资源分视图）----------------------------------------------

  listWindows(resource) {
    return this.windows.get(resource) ?? [];
  }

  listAllWindows() {
    return this.windows;
  }

  windowsOverlapping(resource, start, end, excludeCommandId = null) {
    return this.listWindows(resource).filter(
      (w) =>
        w.commandId !== excludeCommandId &&
        start < w.end &&
        end > w.start,
    );
  }

  /** 幂等提交：同一 commandId 已存在的窗口跳过，保证中断重试可收敛。 */
  commitWindows(command) {
    for (const resource of command.resources) {
      const list = this.windows.get(resource) ?? [];
      if (!list.some((w) => w.commandId === command.commandId)) {
        list.push({ commandId: command.commandId, start: command.start, end: command.end });
        list.sort((a, b) => a.start - b.start);
        this.windows.set(resource, list);
      }
      // 写入点故障钩子：可能在部分资源已写后抛出，由领域层做补偿。
      this.faults.write?.(resource, command);
    }
  }

  /** 快照某命令在给定资源上的窗口（取消前备份，失败时据此还原）。 */
  peekWindows(commandId, resources) {
    const entries = [];
    for (const resource of resources) {
      for (const w of this.listWindows(resource)) {
        if (w.commandId === commandId) entries.push({ resource, ...w });
      }
    }
    return entries;
  }

  /** 删除某命令在给定资源上的窗口。 */
  removeWindows(commandId, resources, { silent = false } = {}) {
    for (const resource of resources) {
      const list = this.listWindows(resource);
      this.windows.set(
        resource,
        list.filter((w) => w.commandId !== commandId),
      );
      // 补偿路径（silent）不再触发故障钩子，避免补偿本身再次失败。
      if (!silent) this.faults.write?.(resource, { commandId, phase: 'cancel' });
    }
  }

  restoreWindows(entries) {
    for (const entry of entries) {
      const { resource, ...window } = entry;
      const list = this.windows.get(resource) ?? [];
      if (!list.some((w) => w.commandId === window.commandId)) {
        list.push(window);
        list.sort((a, b) => a.start - b.start);
        this.windows.set(resource, list);
      }
    }
  }

  /**
   * 故障对账，按命令结论修复三个资源视图：
   *  - 批准命令：窗口必须在全部所涉资源上（补齐取消/提交中途崩溃造成的缺失）；
   *  - 取消命令或无结论命令：窗口一个都不能留（清除提交中途的孤儿窗口）。
   */
  reconcileWindows() {
    const report = { pruned: [], repaired: [] };

    // 先清除/收集：只保留批准命令的窗口。
    for (const [resource, list] of this.windows) {
      const kept = [];
      for (const w of list) {
        const rec = this.commands.get(w.commandId);
        if (rec && rec.state === 'approved') kept.push(w);
        else report.pruned.push({ resource, ...w });
      }
      this.windows.set(resource, kept);
    }

    // 再补齐：批准命令在每个所涉资源上都应有窗口。
    for (const record of this.commands.values()) {
      if (record.state !== 'approved') continue;
      for (const resource of record.resources) {
        const list = this.windows.get(resource) ?? [];
        if (!list.some((w) => w.commandId === record.commandId)) {
          list.push({ commandId: record.commandId, start: record.start, end: record.end });
          list.sort((a, b) => a.start - b.start);
          this.windows.set(resource, list);
          report.repaired.push({ resource, commandId: record.commandId });
        }
      }
    }
    return report;
  }
}
