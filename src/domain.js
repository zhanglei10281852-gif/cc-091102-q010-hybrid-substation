import { createHash } from 'node:crypto';

export const conflictKinds = ['calendar-overlap', 'rolling-quota', 'protected-period', 'dependency-conflict'];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'validation';
    this.httpStatus = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.code = 'not-found';
    this.httpStatus = 404;
  }
}

export class StateError extends Error {
  constructor(message) {
    super(message);
    this.code = 'state-conflict';
    this.httpStatus = 409;
  }
}

export class MismatchError extends Error {
  constructor(commandId) {
    super(`command-id-mismatch:${commandId}`);
    this.code = 'command-id-mismatch';
    this.httpStatus = 409;
  }
}

// 写入点（占用登记/窗口落库）失败：已补偿，未记录结论，调用方可安全重试
export class StoreWriteError extends Error {
  constructor(point, cause) {
    super(`store-write-failed:${point}`);
    this.code = 'store-write';
    this.httpStatus = 500;
    this.cause = cause;
  }
}

class CommandTimeout extends Error {
  constructor() {
    super('command-timeout');
    this.code = 'command-timeout';
  }
}

const COMMAND_ID_PATTERN = /^[\w][\w.-]{0,127}$/;
const MAX_RESOURCES_PER_COMMAND = 32;

export function validateCommand(store, command) {
  if (!command || typeof command !== 'object') throw new ValidationError('command-must-be-object');
  const { commandId, resources, startsAt, endsAt } = command;
  if (typeof commandId !== 'string' || !COMMAND_ID_PATTERN.test(commandId)) {
    throw new ValidationError(`invalid-command-id:${String(commandId)}`);
  }
  if (!Array.isArray(resources) || resources.length === 0) throw new ValidationError('resources-required');
  if (resources.length > MAX_RESOURCES_PER_COMMAND) throw new ValidationError('too-many-resources');
  const unique = [...new Set(resources)];
  for (const resource of unique) {
    if (typeof resource !== 'string' || !resource) throw new ValidationError('invalid-resource');
    if (!store.config.resources[resource]) throw new ValidationError(`unknown-resource:${resource}`);
  }
  const startsMs = Date.parse(startsAt);
  const endsMs = Date.parse(endsAt);
  if (!Number.isFinite(startsMs) || !Number.isFinite(endsMs)) throw new ValidationError('invalid-window-time');
  if (startsMs >= endsMs) throw new ValidationError('window-start-must-precede-end');
  if (endsMs <= store.now()) throw new ValidationError('window-ends-in-past');
  if (endsMs - startsMs > (store.config.maxWindowMs ?? Infinity)) throw new ValidationError('window-too-long');
  // 资源名按字典序排序：这是全局稳定锁序，交叉争抢因此不会死锁
  return {
    commandId,
    resources: unique.sort(),
    startsAt: new Date(startsMs).toISOString(),
    endsAt: new Date(endsMs).toISOString(),
    startsMs,
    endsMs,
  };
}

export function fingerprintOf(command) {
  const normalized = {
    commandId: command.commandId,
    resources: [...command.resources].sort(),
    startsAt: new Date(command.startsMs ?? command.startsAt).toISOString(),
    endsAt: new Date(command.endsMs ?? command.endsAt).toISOString(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// 与存储状态无关的静态冲突：联锁依赖缺失、保电时段相交
function staticConflicts(config, command) {
  const conflicts = [];
  const included = new Set(command.resources);
  for (const resource of command.resources) {
    const required = config.dependencies?.[resource] ?? [];
    const missing = required.filter((dep) => !included.has(dep));
    if (missing.length > 0) conflicts.push({ kind: 'dependency-conflict', resource, missing });
  }
  for (const period of config.protectedPeriods ?? []) {
    const scope = period.resources ?? command.resources;
    const affected = command.resources.filter((r) => scope.includes(r));
    if (affected.length === 0) continue;
    if (Date.parse(period.startsAt) < command.endsMs && Date.parse(period.endsAt) > command.startsMs) {
      for (const resource of affected) {
        conflicts.push({
          kind: 'protected-period',
          resource,
          period: period.name,
          periodStartsAt: period.startsAt,
          periodEndsAt: period.endsAt,
        });
      }
    }
  }
  return conflicts;
}

// 受理预约。commandId 是幂等键：相同命令重试读取首次结果，在途命令单飞。
export async function reserveGroup(store, rawCommand) {
  const command = validateCommand(store, rawCommand);
  const fingerprint = fingerprintOf(command);
  const prior = store.results.get(command.commandId);
  if (prior) {
    if (prior.fingerprint && prior.fingerprint !== fingerprint) throw new MismatchError(command.commandId);
    if (!prior.fingerprint) prior.fingerprint = fingerprint; // 恢复出的结论补登指纹
    return prior.result;
  }
  const inflight = store.inflight.get(command.commandId);
  if (inflight) {
    if (inflight.fingerprint !== fingerprint) throw new MismatchError(command.commandId);
    return inflight.promise;
  }
  const promise = execute(store, command, fingerprint);
  store.inflight.set(command.commandId, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    store.inflight.delete(command.commandId);
  }
}

async function execute(store, command, fingerprint) {
  const { commandId, resources } = command;
  const config = store.config;
  const staticHits = staticConflicts(config, command);
  if (staticHits.length > 0) {
    const result = { state: 'rejected', commandId, reason: 'conflict', conflicts: staticHits };
    store.recordResult(commandId, fingerprint, result);
    return result;
  }
  const deadline = store.now() + (config.commandTimeoutMs ?? 5_000);
  const releases = [];
  let holdsApplied = false;
  const compensate = () => {
    if (!holdsApplied) return;
    for (const resource of resources) store.releaseHold(resource, commandId);
    holdsApplied = false;
  };
  try {
    // 按稳定顺序逐把取锁；任一把等待超时都会走到下面的超时补偿
    for (const resource of resources) {
      releases.push(await store.mutex.acquire(resource, Math.max(0, deadline - store.now())));
    }
    // 全部锁在手：容量检查与占用写入原子完成，容量不会被短暂突破
    const conflicts = [];
    for (const resource of resources) conflicts.push(...store.checkResource(resource, command));
    if (conflicts.length > 0) {
      const result = { state: 'rejected', commandId, reason: 'conflict', conflicts };
      store.recordResult(commandId, fingerprint, result);
      return result;
    }
    const expiresAt = new Date(store.now() + (config.holdTtlMs ?? 30_000)).toISOString();
    for (const resource of resources) store.applyHold(resource, command, expiresAt);
    holdsApplied = true;
    try {
      await store.journalHolds(command, expiresAt, fingerprint);
    } catch (cause) {
      compensate();
      throw new StoreWriteError('holds', cause);
    }
    if (store.now() > deadline) throw new CommandTimeout();
    const record = {
      commandId,
      resources,
      startsAt: command.startsAt,
      endsAt: command.endsAt,
      state: 'approved',
      createdAt: new Date(store.now()).toISOString(),
    };
    try {
      await store.commit(record, fingerprint);
    } catch (cause) {
      compensate();
      throw new StoreWriteError('commit', cause);
    }
    compensate(); // 占用已被落定窗口取代
    const result = { state: 'approved', commandId, resources, startsAt: command.startsAt, endsAt: command.endsAt };
    store.recordResult(commandId, fingerprint, result);
    return result;
  } catch (err) {
    if (err instanceof CommandTimeout || err?.code === 'lock-timeout') {
      compensate();
      const result = { state: 'rejected', commandId, reason: 'timeout' };
      store.recordResult(commandId, fingerprint, result);
      return result;
    }
    compensate();
    throw err;
  } finally {
    for (let i = releases.length - 1; i >= 0; i -= 1) releases[i]();
  }
}

// 取消已定窗口：三个资源视图同时释放；重复取消返回同一结论
export async function cancelGroup(store, commandId) {
  if (typeof commandId !== 'string' || !commandId) throw new ValidationError('command-id-required');
  const record = store.reservations.get(commandId);
  if (!record) {
    if (store.results.has(commandId)) throw new StateError(`cannot-cancel:${store.results.get(commandId).result.state}`);
    throw new NotFoundError(`unknown-command:${commandId}`);
  }
  if (record.state === 'cancelled') return cancelView(record);
  if (record.state !== 'approved') throw new StateError(`cannot-cancel:${record.state}`);
  const deadline = store.now() + (store.config.commandTimeoutMs ?? 5_000);
  const releases = [];
  try {
    for (const resource of record.resources) {
      releases.push(await store.mutex.acquire(resource, Math.max(0, deadline - store.now())));
    }
    await store.cancelRecord(record);
    return cancelView(record);
  } finally {
    for (let i = releases.length - 1; i >= 0; i -= 1) releases[i]();
  }
}

function cancelView(record) {
  return {
    state: 'cancelled',
    commandId: record.commandId,
    resources: record.resources,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    createdAt: record.createdAt ?? null,
    cancelledAt: record.cancelledAt ?? null,
  };
}

export function getReservation(store, commandId) {
  const record = store.reservations.get(commandId);
  const entry = store.results.get(commandId);
  if (!record && !entry) throw new NotFoundError(`unknown-command:${commandId}`);
  if (record) {
    return {
      commandId,
      state: record.state,
      resources: record.resources,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      createdAt: record.createdAt ?? null,
      cancelledAt: record.cancelledAt ?? null,
    };
  }
  return entry.result;
}

// 故障恢复：回收到期占用、补偿悬挂占用、补齐缺失结论
export function recover(store) {
  return store.recover();
}
