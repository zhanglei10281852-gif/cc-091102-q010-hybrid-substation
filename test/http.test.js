import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpServer } from '../src/server.js';

function startServer() {
  const server = createHttpServer(undefined, { lockTimeoutMs: 100, retryDelayMs: 1 });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function call(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

const command = {
  commandId: 'HTTP-1',
  resources: ['wind-farm-2', 'solar-site-4', 'substation-a'],
  startsAt: '2026-12-08T01:00:00+08:00',
  endsAt: '2026-12-08T05:00:00+08:00',
};

test('健康与资源目录', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const health = await call(base, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'running');

  const resources = await call(base, 'GET', '/resources');
  assert.equal(resources.status, 200);
  assert.ok(resources.body.resources.includes('substation-a'));
});

test('预约 -> 查询 -> 重试 -> 三视图一致', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const created = await call(base, 'POST', '/reservations', command);
  assert.equal(created.status, 201);
  assert.equal(created.body.decision, 'approved');

  const fetched = await call(base, 'GET', '/reservations/HTTP-1');
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.state, 'approved');

  const retry = await call(base, 'POST', '/reservations', command);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.retried, true);

  const views = await call(base, 'GET', '/views');
  for (const resource of command.resources) {
    assert.deepEqual(views.body.resources[resource].map((w) => w.commandId), ['HTTP-1']);
  }
});

test('冲突预约返回 409 与具体阻断资源', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  await call(base, 'POST', '/reservations', command);
  const conflict = await call(base, 'POST', '/reservations', { ...command, commandId: 'HTTP-2' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.decision, 'rejected');
  assert.ok(conflict.body.blockers.length >= 3);
  assert.ok(conflict.body.blockers.every((b) => b.resource && b.kind));
});

test('联锁依赖缺失返回 dependency-conflict', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const result = await call(base, 'POST', '/reservations', {
    commandId: 'HTTP-3',
    resources: ['substation-a'],
    startsAt: '2026-12-09T01:00:00+08:00',
    endsAt: '2026-12-09T05:00:00+08:00',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.decision, 'rejected');
  assert.deepEqual(
    result.body.blockers.map((b) => b.resource).sort(),
    ['solar-site-4', 'wind-farm-2'],
  );
});

test('取消接口释放窗口，重复取消重放', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  await call(base, 'POST', '/reservations', command);
  const cancelled = await call(base, 'POST', '/reservations/HTTP-1/cancel', { reason: 'shift' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.state, 'cancelled');

  const views = await call(base, 'GET', '/views');
  for (const resource of command.resources) {
    assert.equal(views.body.resources[resource].length, 0);
  }

  const again = await call(base, 'POST', '/reservations/HTTP-1/cancel', {});
  assert.equal(again.status, 200);
  assert.equal(again.body.retried, true);
});

test('错误路径：坏 JSON 400、未知命令 404、未知资源 404', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const badJson = await fetch(`${base}/reservations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(badJson.status, 400);

  const missing = await call(base, 'GET', '/reservations/NO-SUCH');
  assert.equal(missing.status, 404);

  const unknown = await call(base, 'POST', '/reservations', {
    ...command,
    commandId: 'HTTP-X',
    resources: ['nope'],
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'unknown-resource');
});

test('恢复接口可调用并返回对账报告', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const recovered = await call(base, 'POST', '/admin/recover', {});
  assert.equal(recovered.status, 200);
  assert.ok(Array.isArray(recovered.body.releasedLocks));
  assert.ok(Array.isArray(recovered.body.pruned));
  assert.ok(Array.isArray(recovered.body.repaired));
});
