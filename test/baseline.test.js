import test from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises';
test('预约样例覆盖全部关联资源', async () => { const item=JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url))); assert.equal(item.resources.length,3); assert.ok(Date.parse(item.endsAt)>Date.parse(item.startsAt)); });
