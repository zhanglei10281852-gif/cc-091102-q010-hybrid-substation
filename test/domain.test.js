import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.js';
import { Journal } from '../src/journal.js';
import { cancelGroup, getReservation, recover, reserveGroup } from '../src/domain.js';

function testConfig(overrides = {}) {
  return {
    resources: { 'res-a': { capacity: 1 }, 'res-b': { capacity: 1 }, 'res-c': { capacity: 1 } },
    dependencies: {},
    protectedPeriods: [],
    rollingQuota: null,
    commandTimeoutMs: 500,
    holdTtlMs: 10_000,
    sweepIntervalMs: 1_000,
    maxWindowMs: 30 * 24 * 3600_000,
    ...overrides,
  };
}

const iso = (ms) => new Date(ms).toISOString();
const cmd = (commandId, resources, startsMs, endsMs) => ({
  commandId,
  resources,
  startsAt: iso(startsMs),
  endsAt: iso(endsMs),
});

test('一次预约在三个资源视图落定同一窗口', async () => {
  const store = new Store(testConfig());
  const t0 = Date.now() + 3600_000;
  const result = await reserveGroup(store, cmd('OUTAGE-100', ['res-c', 'res-a', 'res-b'], t0, t0 + 3600_000));
  assert.equal(result.state, 'approved');
  for (const resource of ['res-a', 'res-b', 'res-c']) {
    const calendar = store.getCalendar(resource);
    assert.equal(calendar.windows.length, 1);
    assert.equal(calendar.windows[0].commandId, 'OUTAGE-100');
    assert.equal(calendar.windows[0].startsAt, result.startsAt);
    assert.equal(calendar.windows[0].endsAt, result.endsAt);
  }
  store.assertCapacityInvariant();
});

test('冲突时整组拒绝并指明阻断资源，其余资源不留痕迹', async () => {
  const store = new Store(testConfig());
  const t0 = Date.now() + 3600_000;
  await reserveGroup(store, cmd('OUTAGE-1', ['res-a', 'res-b'], t0, t0 + 3600_000));
  const rejected = await reserveGroup(store, cmd('OUTAGE-2', ['res-a', 'res-c'], t0 + 1800_000, t0 + 5400_000));
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.reason, 'conflict');
  const overlap = rejected.conflicts.find((c) => c.kind === 'calendar-overlap');
  assert.equal(overlap.resource, 'res-a');
  assert.deepEqual(overlap.blockingCommandIds, ['OUTAGE-1']);
  assert.equal(store.getCalendar('res-c').windows.length, 0);
  assert.equal(store.getCalendar('res-c').holds.length, 0);
  store.assertCapacityInvariant();
});

test('联锁依赖缺失时拒绝并列出缺失资源', async () => {
  const store = new Store(testConfig({ dependencies: { 'res-c': ['res-a', 'res-b'] } }));
  const t0 = Date.now() + 3600_000;
  const rejected = await reserveGroup(store, cmd('OUTAGE-3', ['res-c'], t0, t0 + 3600_000));
  assert.equal(rejected.state, 'rejected');
  const dep = rejected.conflicts.find((c) => c.kind === 'dependency-conflict');
  assert.equal(dep.resource, 'res-c');
  assert.deepEqual(dep.missing, ['res-a', 'res-b']);
  const ok = await reserveGroup(store, cmd('OUTAGE-4', ['res-c', 'res-b', 'res-a'], t0, t0 + 3600_000));
  assert.equal(ok.state, 'approved');
});

test('保电时段内禁止安排窗口', async () => {
  const t0 = Date.now() + 3600_000;
  const store = new Store(
    testConfig({ protectedPeriods: [{ name: '保电', startsAt: iso(t0), endsAt: iso(t0 + 3600_000) }] }),
  );
  const rejected = await reserveGroup(store, cmd('OUTAGE-5', ['res-a'], t0 + 600_000, t0 + 2 * 3600_000));
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.conflicts[0].kind, 'protected-period');
  assert.equal(rejected.conflicts[0].period, '保电');
  const ok = await reserveGroup(store, cmd('OUTAGE-6', ['res-a'], t0 + 2 * 3600_000, t0 + 3 * 3600_000));
  assert.equal(ok.state, 'approved');
});

test('滚动配额超限被拒绝', async () => {
  const store = new Store(testConfig({ rollingQuota: { windowMs: 7 * 24 * 3600_000, max: 2 } }));
  const t0 = Date.now() + 3600_000;
  assert.equal((await reserveGroup(store, cmd('Q1', ['res-a'], t0, t0 + 3600_000))).state, 'approved');
  assert.equal((await reserveGroup(store, cmd('Q2', ['res-a'], t0 + 2 * 3600_000, t0 + 3 * 3600_000))).state, 'approved');
  const third = await reserveGroup(store, cmd('Q3', ['res-a'], t0 + 4 * 3600_000, t0 + 5 * 3600_000));
  assert.equal(third.state, 'rejected');
  assert.equal(third.conflicts[0].kind, 'rolling-quota');
  assert.equal(third.conflicts[0].resource, 'res-a');
});

test('交叉争抢不死锁且只有一个共同结论', async () => {
  for (let round = 0; round < 10; round += 1) {
    const store = new Store(testConfig());
    const t0 = Date.now() + 3600_000;
    const [r1, r2] = await Promise.all([
      reserveGroup(store, cmd(`X1-${round}`, ['res-a', 'res-b'], t0, t0 + 3600_000)),
      reserveGroup(store, cmd(`X2-${round}`, ['res-b', 'res-a'], t0, t0 + 3600_000)),
    ]);
    assert.deepEqual([r1.state, r2.state].sort(), ['approved', 'rejected']);
    const loser = r1.state === 'rejected' ? r1 : r2;
    assert.equal(loser.conflicts[0].kind, 'calendar-overlap');
    store.assertCapacityInvariant();
  }
});

test('占用登记写入点中断：补偿已取得的部分，修复后可重试', async () => {
  const journal = {
    appended: [],
    fail: true,
    async append(event) {
      this.appended.push(event);
      if (this.fail && event.op === 'holds') throw new Error('disk-on-fire');
    },
    async flush() {},
  };
  const store = new Store(testConfig(), { journal });
  const t0 = Date.now() + 3600_000;
  const command = cmd('W1', ['res-a', 'res-b'], t0, t0 + 3600_000);
  await assert.rejects(reserveGroup(store, command), /store-write-failed:holds/);
  assert.equal(store.stats().holds, 0);
  assert.equal(store.results.has('W1'), false);
  store.assertCapacityInvariant();
  journal.fail = false;
  const retry = await reserveGroup(store, command);
  assert.equal(retry.state, 'approved');
});

test('窗口落库写入点中断：同样补偿，容量完整', async () => {
  const journal = {
    async append(event) {
      if (event.op === 'commit') throw new Error('disk-on-fire');
    },
    async flush() {},
  };
  const store = new Store(testConfig(), { journal });
  const t0 = Date.now() + 3600_000;
  await assert.rejects(reserveGroup(store, cmd('W2', ['res-a', 'res-b'], t0, t0 + 3600_000)), /store-write-failed:commit/);
  assert.equal(store.stats().holds, 0);
  assert.equal(store.stats().reservations, 0);
  store.assertCapacityInvariant();
});

test('锁等待超时：不留悬挂窗口，重试读取首次结果', async () => {
  const store = new Store(testConfig({ commandTimeoutMs: 60 }));
  const release = await store.mutex.acquire('res-a', 1_000);
  const t0 = Date.now() + 3600_000;
  const command = cmd('T1', ['res-a'], t0, t0 + 3600_000);
  const result = await reserveGroup(store, command);
  assert.equal(result.state, 'rejected');
  assert.equal(result.reason, 'timeout');
  release();
  assert.equal(store.stats().holds, 0);
  store.assertCapacityInvariant();
  const again = await reserveGroup(store, command);
  assert.deepEqual(again, result);
  const fresh = await reserveGroup(store, cmd('T2', ['res-a'], t0, t0 + 3600_000));
  assert.equal(fresh.state, 'approved');
});

test('写入超过截止时间同样按超时补偿', async () => {
  const journal = {
    async append() {
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    async flush() {},
  };
  const store = new Store(testConfig({ commandTimeoutMs: 10 }), { journal });
  const t0 = Date.now() + 3600_000;
  const result = await reserveGroup(store, cmd('T3', ['res-a'], t0, t0 + 3600_000));
  assert.equal(result.state, 'rejected');
  assert.equal(result.reason, 'timeout');
  assert.equal(store.stats().holds, 0);
  store.assertCapacityInvariant();
});

test('相同命令重试读取首次结果，阻断解除后依然如此', async () => {
  const store = new Store(testConfig());
  const t0 = Date.now() + 3600_000;
  const command = cmd('I1', ['res-a', 'res-b'], t0, t0 + 3600_000);
  const first = await reserveGroup(store, command);
  assert.equal(first.state, 'approved');
  assert.deepEqual(await reserveGroup(store, command), first);
  const duplicates = await Promise.all(Array.from({ length: 5 }, () => reserveGroup(store, command)));
  for (const duplicate of duplicates) assert.deepEqual(duplicate, first);
  assert.equal(store.getCalendar('res-a').windows.length, 1);

  const clash = cmd('I3', ['res-a'], t0 + 1800_000, t0 + 2700_000);
  const rejected = await reserveGroup(store, clash);
  assert.equal(rejected.state, 'rejected');
  await cancelGroup(store, 'I1');
  assert.deepEqual(await reserveGroup(store, clash), rejected); // 首次结果不变
  const fresh = await reserveGroup(store, cmd('I4', ['res-a'], t0 + 1800_000, t0 + 2700_000));
  assert.equal(fresh.state, 'approved');

  await assert.rejects(
    reserveGroup(store, { ...clash, endsAt: iso(t0 + 3600_000) }),
    /command-id-mismatch/,
  );
});

test('并发冲击下容量不被短暂突破', async () => {
  const store = new Store(testConfig({ resources: { 'res-a': { capacity: 2 } } }));
  const t0 = Date.now() + 3600_000;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => reserveGroup(store, cmd(`C${i}`, ['res-a'], t0, t0 + 3600_000))),
  );
  assert.equal(results.filter((r) => r.state === 'approved').length, 2);
  assert.equal(results.filter((r) => r.state === 'rejected').length, 8);
  assert.equal(store.getCalendar('res-a').windows.length, 2);
  store.assertCapacityInvariant();
});

test('取消释放全部资源视图且可幂等重试', async () => {
  const store = new Store(testConfig());
  const t0 = Date.now() + 3600_000;
  await reserveGroup(store, cmd('K1', ['res-a', 'res-b'], t0, t0 + 3600_000));
  const cancelled = await cancelGroup(store, 'K1');
  assert.equal(cancelled.state, 'cancelled');
  for (const resource of ['res-a', 'res-b']) assert.equal(store.getCalendar(resource).windows.length, 0);
  assert.equal((await cancelGroup(store, 'K1')).state, 'cancelled');
  const follow = await reserveGroup(store, cmd('K2', ['res-a'], t0, t0 + 3600_000));
  assert.equal(follow.state, 'approved');
  await assert.rejects(cancelGroup(store, 'NOPE'), /unknown-command/);
  const rejected = await reserveGroup(store, cmd('K3', ['res-a'], t0, t0 + 3600_000));
  assert.equal(rejected.state, 'rejected');
  await assert.rejects(cancelGroup(store, 'K3'), /cannot-cancel/);
});

test('故障恢复：已提交状态重建，悬挂占用补偿并留下恢复结论', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hybrid-journal-'));
  try {
    const journalPath = join(dir, 'journal.jsonl');
    const t0 = Date.now() + 3600_000;
    const store1 = await Store.open(testConfig(), { journalPath });
    assert.equal((await reserveGroup(store1, cmd('R1', ['res-a', 'res-b'], t0, t0 + 3600_000))).state, 'approved');
    // 模拟崩溃：R2 的占用已落日志，进程在落库写入点前消失
    const crashed = cmd('R2', ['res-c'], t0, t0 + 3600_000);
    const original = store1.journal.append.bind(store1.journal);
    store1.journal.append = (event) => (event.op === 'commit' ? Promise.reject(new Error('crash')) : original(event));
    await assert.rejects(reserveGroup(store1, crashed), /store-write-failed:commit/);
    await store1.flushJournal();

    // 冷启动：重放日志并恢复
    const journal = await Journal.create(journalPath);
    const store2 = new Store(testConfig(), { journal });
    for (const event of await Journal.load(journalPath)) store2.applyEvent(event);
    const report = store2.recover();
    assert.deepEqual(report.compensatedHolds, ['R2']);

    assert.equal(getReservation(store2, 'R1').state, 'approved');
    assert.equal(store2.getCalendar('res-a').windows.length, 1);
    assert.equal(store2.getCalendar('res-c').holds.length, 0);
    const r2 = getReservation(store2, 'R2');
    assert.equal(r2.state, 'rejected');
    assert.equal(r2.reason, 'recovery');
    // 重试 R2 读到恢复结论；容量未被占用，新命令可以落定
    const replay = await reserveGroup(store2, crashed);
    assert.equal(replay.state, 'rejected');
    assert.equal(replay.reason, 'recovery');
    assert.equal((await reserveGroup(store2, cmd('R3', ['res-c'], t0, t0 + 3600_000))).state, 'approved');
    store2.assertCapacityInvariant();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('到期占用被清扫，不留悬挂窗口', async () => {
  let now = Date.now();
  const store = new Store(testConfig({ holdTtlMs: 1_000 }), { now: () => now });
  const startsAt = iso(now + 3600_000);
  const endsAt = iso(now + 2 * 3600_000);
  store.applyHold('res-a', { commandId: 'E1', startsAt, endsAt }, iso(now + 1_000));
  assert.equal(store.getCalendar('res-a').holds.length, 1);
  now += 2_000; // 时钟越过占用期限
  assert.equal(store.getCalendar('res-a').holds.length, 0);
  store.applyHold('res-a', { commandId: 'E2', startsAt, endsAt }, iso(now + 1_000));
  now += 2_000;
  const report = recover(store);
  assert.equal(report.purgedHolds, 1);
  store.assertCapacityInvariant();
});
