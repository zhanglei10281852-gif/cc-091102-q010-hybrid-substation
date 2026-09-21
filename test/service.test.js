import test from 'node:test';
import assert from 'node:assert/strict';

import { Store, LockTimeoutError } from '../src/store.js';
import {
  createReservationService,
  normalizeCommand,
  commonConclusionAcrossViews,
  conflictKinds,
  HttpError,
} from '../src/domain.js';

const fixtureWindow = {
  commandId: 'OUTAGE-61',
  resources: ['wind-farm-2', 'solar-site-4', 'substation-a'],
  startsAt: '2026-10-08T01:00:00+08:00',
  endsAt: '2026-10-08T05:00:00+08:00',
};

function makeService(store = new Store(), options = {}) {
  return createReservationService(store, { lockTimeoutMs: 200, retryDelayMs: 1, ...options });
}

function windowsOf(store, commandId) {
  const result = {};
  for (const resource of ['wind-farm-2', 'solar-site-4', 'substation-a']) {
    result[resource] = store.listWindows(resource).filter((w) => w.commandId === commandId);
  }
  return result;
}

test('冲突类别常量保持四类', () => {
  assert.deepEqual(conflictKinds, [
    'calendar-overlap',
    'rolling-quota',
    'protected-period',
    'dependency-conflict',
  ]);
});

test('受理成功：三个资源视图同时落定，结论一致', async () => {
  const store = new Store();
  const service = makeService(store);
  const result = await service.reserve(fixtureWindow);

  assert.equal(result.decision, 'approved');
  assert.equal(result.state, 'approved');
  const windows = windowsOf(store, 'OUTAGE-61');
  assert.equal(windows['wind-farm-2'].length, 1);
  assert.equal(windows['solar-site-4'].length, 1);
  assert.equal(windows['substation-a'].length, 1);
  assert.deepEqual(commonConclusionAcrossViews(store, 'OUTAGE-61'), {
    commandId: 'OUTAGE-61',
    consistent: true,
    state: 'approved',
    presentOn: ['solar-site-4', 'substation-a', 'wind-farm-2'],
    missingOn: [],
  });
});

test('输入校验：时间倒置 400，未知资源 404', () => {
  assert.throws(
    () => normalizeCommand({ ...fixtureWindow, endsAt: fixtureWindow.startsAt }),
    HttpError,
  );
  assert.throws(
    () => normalizeCommand({ ...fixtureWindow, resources: ['wind-farm-2', 'ghost'] }),
    (err) => err.status === 404 && err.code === 'unknown-resource',
  );
});

test('联锁依赖不完整：直接拒绝并指明缺失的联锁资源', async () => {
  const service = makeService();
  const result = await service.reserve({
    commandId: 'PARTIAL-1',
    resources: ['substation-a'],
    startsAt: '2026-10-08T01:00:00+08:00',
    endsAt: '2026-10-08T05:00:00+08:00',
  });
  assert.equal(result.decision, 'rejected');
  const missing = result.blockers.map((b) => b.resource).sort();
  assert.deepEqual(missing, ['solar-site-4', 'wind-farm-2']);
  assert.ok(result.blockers.every((b) => b.kind === 'dependency-conflict'));
});

test('容量冲突：失败方拿到具体阻断资源与冲突命令', async () => {
  const store = new Store();
  const service = makeService(store);
  await service.reserve(fixtureWindow);
  const second = await service.reserve({
    ...fixtureWindow,
    commandId: 'OUTAGE-62',
  });
  assert.equal(second.decision, 'rejected');
  const resources = [...new Set(second.blockers.map((b) => b.resource))].sort();
  assert.deepEqual(resources, ['solar-site-4', 'substation-a', 'wind-farm-2']);
  // 三个资源都报容量重叠，且每个重叠 blocker 指明冲突命令。
  const overlaps = second.blockers.filter((b) => b.kind === 'calendar-overlap');
  assert.deepEqual(
    [...new Set(overlaps.map((b) => b.resource))].sort(),
    ['solar-site-4', 'substation-a', 'wind-farm-2'],
  );
  assert.ok(overlaps.every((b) => b.conflictingCommand === 'OUTAGE-61'));
  // 升压站每日配额为 1，同一天第二次还会附带滚动配额阻断。
  assert.ok(second.blockers.some((b) => b.resource === 'substation-a' && b.kind === 'rolling-quota'));
  // 失败方没有任何窗口残留。
  assert.equal(store.getCommand('OUTAGE-62'), null);
  assert.deepEqual(commonConclusionAcrossViews(store, 'OUTAGE-61').consistent, true);
});

test('滚动配额阻断（升压站每日最多1次）', async () => {
  const service = makeService();
  await service.reserve(fixtureWindow);
  const result = await service.reserve({
    commandId: 'OUTAGE-63',
    resources: ['wind-farm-2', 'solar-site-4', 'substation-a'],
    startsAt: '2026-10-09T01:00:00+08:00',
    endsAt: '2026-10-09T05:00:00+08:00',
  });
  assert.equal(result.decision, 'rejected');
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].resource, 'substation-a');
  assert.equal(result.blockers[0].kind, 'rolling-quota');
});

test('保护期阻断', async () => {
  const service = makeService();
  const result = await service.reserve({
    commandId: 'OUTAGE-64',
    resources: ['wind-farm-2', 'solar-site-4', 'substation-a'],
    startsAt: '2026-10-02T01:00:00+08:00',
    endsAt: '2026-10-02T03:00:00+08:00',
  });
  assert.equal(result.decision, 'rejected');
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].kind, 'protected-period');
  assert.equal(result.blockers[0].resource, 'substation-a');
});

test('相同命令重试：读取首次批准结果，窗口不重复', async () => {
  const store = new Store();
  const service = makeService(store);
  const first = await service.reserve(fixtureWindow);
  const second = await service.reserve(fixtureWindow);
  assert.equal(first.retried, false);
  assert.equal(second.retried, true);
  assert.equal(second.commandId, 'OUTAGE-61');
  for (const resource of fixtureWindow.resources) {
    assert.equal(store.listWindows(resource).filter((w) => w.commandId === 'OUTAGE-61').length, 1);
  }
});

test('取消：三个视图同时移除，取消结论幂等重放', async () => {
  const store = new Store();
  const service = makeService(store);
  await service.reserve(fixtureWindow);
  const cancelled = await service.cancel('OUTAGE-61', 'plan-changed');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.releasedWindows, 3);
  assert.deepEqual(commonConclusionAcrossViews(store, 'OUTAGE-61'), {
    commandId: 'OUTAGE-61',
    consistent: true,
    state: 'cancelled',
    presentOn: [],
  });
  const again = await service.cancel('OUTAGE-61');
  assert.equal(again.retried, true);
  // 取消后的 commandId 不可再受理。
  await assert.rejects(() => service.reserve(fixtureWindow), (err) => err.status === 409);
});

test('查询不存在的命令返回 404', async () => {
  const service = makeService();
  assert.throws(() => service.get('NOPE'), (err) => err.status === 404);
});

test('稳定加锁顺序：客户端反向提交不影响内序', async () => {
  const store = new Store();
  const service = makeService(store);
  const result = await service.reserve({ ...fixtureWindow, resources: [...fixtureWindow.resources].reverse() });
  assert.equal(result.decision, 'approved');
  assert.deepEqual(result.resources, ['solar-site-4', 'substation-a', 'wind-farm-2']);
});

test('交叉争抢不死锁：两个相反顺序的同窗口计划恰好一个通过，且都能结束', async () => {
  const store = new Store();
  const service = makeService(store);
  const payloadA = {
    commandId: 'RACE-A',
    resources: ['wind-farm-1', 'solar-site-3'],
    startsAt: '2026-11-01T01:00:00+08:00',
    endsAt: '2026-11-01T03:00:00+08:00',
  };
  const payloadB = { ...payloadA, commandId: 'RACE-B', resources: ['solar-site-3', 'wind-farm-1'] };

  const outcomes = await Promise.allSettled([service.reserve(payloadA), service.reserve(payloadB)]);
  const fulfilled = outcomes.map((o) => o.value);
  const approved = fulfilled.filter((r) => r.decision === 'approved');
  const rejected = fulfilled.filter((r) => r.decision === 'rejected');
  assert.equal(approved.length, 1);
  assert.equal(rejected.length, 1);
  // 失败方知道被谁、在哪个资源挡住。
  assert.ok(rejected[0].blockers.some((b) => b.conflictingCommand === approved[0].commandId));
  // 容量未被突破：每个资源只有一条窗口。
  assert.equal(store.listWindows('wind-farm-1').length, 1);
  assert.equal(store.listWindows('solar-site-3').length, 1);
  // 锁全部释放。
  assert.equal(store.locks.size, 0);
});

test('并发洪峰下容量绝不被短暂突破', async () => {
  const store = new Store();
  const service = makeService(store);
  const requests = Array.from({ length: 8 }, (_, i) => ({
    commandId: `FLOOD-${i}`,
    resources: ['wind-farm-1'],
    startsAt: '2026-11-02T01:00:00+08:00',
    endsAt: '2026-11-02T03:00:00+08:00',
  }));
  const results = await Promise.all(requests.map((r) => service.reserve(r)));
  assert.equal(results.filter((r) => r.decision === 'approved').length, 1);
  assert.equal(results.filter((r) => r.decision === 'rejected').length, 7);
  assert.equal(store.listWindows('wind-farm-1').length, 1);
});

test('锁等待超时：503 并指明持锁命令，已取得的锁立即释放', async () => {
  let clock = 1_000_000;
  const store = new Store({ now: () => clock, lockTtlMs: 60_000 });
  // 模拟另一事务持有 wind-farm-1（崩溃在中途，尚未到期）。
  store.locks.set('wind-farm-1', { commandId: 'ZOMBIE', expiresAt: clock + 60_000 });
  const service = makeService(store, {
    lockTimeoutMs: 30,
    retryDelayMs: 2,
    sleep: async (ms) => { clock += ms; },
  });

  await assert.rejects(
    service.reserve({
      commandId: 'TIMEOUT-1',
      resources: ['wind-farm-1', 'solar-site-3'],
      startsAt: '2026-11-03T01:00:00+08:00',
      endsAt: '2026-11-03T03:00:00+08:00',
    }),
    (err) => {
      assert.ok(err instanceof LockTimeoutError);
      assert.equal(err.code, 'lock-timeout');
      assert.ok(err.blockers.some((b) => b.resource === 'wind-farm-1' && b.commandId === 'ZOMBIE'));
      return true;
    },
  );
  // 自己先拿到的 solar-site-3 必须释放，只剩僵尸锁等待 TTL 兜底。
  assert.equal(store.locks.size, 1);
  assert.ok(store.locks.has('wind-farm-1'));
  // 超时不留下悬挂窗口或命令结论。
  assert.equal(store.listWindows('solar-site-3').length, 0);
  assert.equal(store.getCommand('TIMEOUT-1'), null);
});

test('提交在第二个资源写入点中断：补偿已写部分，重试成功', async () => {
  const store = new Store({
    faults: {
      write: (resource) => {
        if (resource === 'substation-a') throw new Error('disk-reset');
      },
    },
  });
  const service = makeService(store);
  await assert.rejects(service.reserve(fixtureWindow), (err) => err.code === 'commit-failed');
  // 补偿后三个视图都没有半截窗口，锁也全部释放。
  for (const resource of fixtureWindow.resources) {
    assert.equal(store.listWindows(resource).length, 0);
  }
  assert.equal(store.locks.size, 0);
  // 同一命令重试 -> 首次结论未持久化，可重新受理。
  store.faults.write = null;
  const retry = await service.reserve(fixtureWindow);
  assert.equal(retry.decision, 'approved');
  assert.equal(retry.retried, false);
});

test('取消在中途写入点中断：已删窗口还原，命令仍为批准且视图一致', async () => {
  const store = new Store();
  const service = makeService(store);
  await service.reserve(fixtureWindow);
  store.faults.write = (resource, ctx) => {
    if (ctx.phase === 'cancel' && resource === 'substation-a') throw new Error('disk-reset');
  };
  await assert.rejects(service.cancel('OUTAGE-61'), (err) => err.code === 'cancel-failed');
  assert.equal(store.getCommand('OUTAGE-61').state, 'approved');
  assert.equal(commonConclusionAcrossViews(store, 'OUTAGE-61').consistent, true);
  assert.equal(store.locks.size, 0);
  // 故障解除后取消可以完成。
  store.faults.write = null;
  const done = await service.cancel('OUTAGE-61');
  assert.equal(done.state, 'cancelled');
});

test('加锁写入点中断：已取得的锁被补偿释放', async () => {
  const store = new Store({
    faults: { lock: (resource) => { if (resource === 'substation-a') throw new Error('lock-store-down'); } },
  });
  const service = makeService(store);
  await assert.rejects(service.reserve(fixtureWindow), /lock-store-down/);
  assert.equal(store.locks.size, 0);
});

test('recover：释放过期锁、剪孤儿窗口、补齐批准命令缺失的视图', async () => {
  let clock = Date.parse('2026-10-08T00:00:00+08:00');
  const store = new Store({ now: () => clock });
  const service = makeService(store);
  await service.reserve(fixtureWindow);

  // 1) 模拟崩溃：一把过期锁。
  store.locks.set('wind-farm-1', { commandId: 'DEAD', expiresAt: clock - 1 });
  // 2) 模拟提交中途死亡：无命令结论的孤儿窗口。
  if (!store.windows.has('wind-farm-1')) store.windows.set('wind-farm-1', []);
  store.windows.get('wind-farm-1').push({
    commandId: 'ORPHAN',
    start: clock + 7200_000,
    end: clock + 10800_000,
  });
  // 3) 模拟取消中途死亡：批准命令在一个视图上缺窗口。
  store.windows.set('substation-a', []);

  const report = service.recover();
  assert.deepEqual(report.releasedLocks.map((l) => l.resource), ['wind-farm-1']);
  assert.deepEqual(report.pruned.map((p) => p.commandId), ['ORPHAN']);
  assert.deepEqual(report.repaired.map((p) => `${p.resource}:${p.commandId}`), [
    'substation-a:OUTAGE-61',
  ]);
  assert.equal(commonConclusionAcrossViews(store, 'OUTAGE-61').consistent, true);

  // 再跑一次对账应当幂等、无新动作。
  const again = service.recover();
  assert.equal(again.releasedLocks.length, 0);
  assert.equal(again.pruned.length, 0);
  assert.equal(again.repaired.length, 0);
});

test('视图接口对每个命令给出跨资源一致结论', async () => {
  const store = new Store();
  const service = makeService(store);
  await service.reserve(fixtureWindow);
  const views = service.views();
  for (const resource of fixtureWindow.resources) {
    assert.deepEqual(views.resources[resource].map((w) => w.commandId), ['OUTAGE-61']);
  }
  assert.equal(views.commands['OUTAGE-61'].state, 'approved');
});
