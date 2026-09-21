import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createHandler } from '../src/server.js';
import { Store } from '../src/store.js';

function testConfig() {
  return {
    resources: { 'res-a': { capacity: 1 }, 'res-b': { capacity: 1 }, 'res-c': { capacity: 1 } },
    dependencies: { 'res-c': ['res-a', 'res-b'] },
    protectedPeriods: [],
    rollingQuota: null,
    commandTimeoutMs: 500,
    holdTtlMs: 10_000,
    sweepIntervalMs: 1_000,
    maxWindowMs: 30 * 24 * 3600_000,
  };
}

const iso = (ms) => new Date(ms).toISOString();

async function withServer(store, fn) {
  const server = createServer(createHandler(store));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

const post = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('HTTP 接口：受理、幂等重试、查询、取消、健康检查', async () => {
  const store = new Store(testConfig());
  await withServer(store, async (base) => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.service, 'hybrid-substation-window');
    assert.equal(health.status, 'running');

    const t0 = Date.now() + 3600_000;
    const body = { commandId: 'HTTP-1', resources: ['res-b', 'res-a'], startsAt: iso(t0), endsAt: iso(t0 + 3600_000) };
    const created = await post(base, '/reservations', body);
    assert.equal(created.status, 200);
    assert.equal((await created.json()).state, 'approved');

    const retry = await post(base, '/reservations', body);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).state, 'approved');

    const clash = await post(base, '/reservations', { ...body, commandId: 'HTTP-2' });
    assert.equal(clash.status, 409);
    const clashBody = await clash.json();
    assert.equal(clashBody.state, 'rejected');
    assert.equal(clashBody.conflicts[0].kind, 'calendar-overlap');
    assert.deepEqual(clashBody.conflicts[0].blockingCommandIds, ['HTTP-1']);

    const got = await fetch(`${base}/reservations/HTTP-1`).then((r) => r.json());
    assert.equal(got.state, 'approved');

    const calendar = await fetch(`${base}/resources/res-a/calendar`).then((r) => r.json());
    assert.equal(calendar.windows.length, 1);
    assert.equal(calendar.windows[0].commandId, 'HTTP-1');

    const cancelled = await fetch(`${base}/reservations/HTTP-1/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).state, 'cancelled');
    const again = await fetch(`${base}/reservations/HTTP-1/cancel`, { method: 'POST' });
    assert.equal((await again.json()).state, 'cancelled');
    const after = await fetch(`${base}/resources/res-a/calendar`).then((r) => r.json());
    assert.equal(after.windows.length, 0);

    assert.equal((await fetch(`${base}/reservations/NOPE`)).status, 404);
    assert.equal((await fetch(`${base}/resources/nowhere/calendar`)).status, 404);
    const bad = await fetch(`${base}/reservations`, { method: 'POST', body: '{oops' });
    assert.equal(bad.status, 400);
    const invalid = await post(base, '/reservations', { commandId: 'X', resources: ['nowhere'], startsAt: iso(t0), endsAt: iso(t0 + 1) });
    assert.equal(invalid.status, 400);

    const recovered = await fetch(`${base}/admin/recover`, { method: 'POST' });
    assert.equal(recovered.status, 200);
  });
});

test('HTTP 接口：联锁依赖缺失返回 409 与缺失资源', async () => {
  const store = new Store(testConfig());
  await withServer(store, async (base) => {
    const t0 = Date.now() + 3600_000;
    const response = await post(base, '/reservations', {
      commandId: 'HTTP-3',
      resources: ['res-c'],
      startsAt: iso(t0),
      endsAt: iso(t0 + 3600_000),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.conflicts[0].kind, 'dependency-conflict');
    assert.deepEqual(body.conflicts[0].missing, ['res-a', 'res-b']);
  });
});
