// test/drafts-store.test.mjs — auto-profile S1 draft 容器（host 侧）。
// 纯 store + /draft /drafts /draft/remove 路由；draft 独立于生产 profiles。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftsStore } from '../lib/core/drafts-store.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

test('drafts store：add/list/get/remove 与落盘重载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-drafts-'));
  try {
    const a = createDraftsStore({ dshHome: dir });
    const res = a.add({ id: 'd1', source: 'dispatch', config: { id: 'prof-1' }, name: 'n1', description: '', createdAt: 1 });
    assert.equal(res.persisted, true);
    assert.equal(a.list().length, 1);
    assert.equal(a.get('d1').name, 'n1');
    const b = createDraftsStore({ dshHome: dir });
    assert.equal(b.get('d1').id, 'd1', '落盘后新实例可读');
    const removed = b.remove('d1');
    assert.equal(removed.removed, true);
    assert.equal(b.list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('POST /draft + GET /drafts + POST /draft/remove', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeRouteHarness();
    const { ctx } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const handler = routes[0].handler;
    const add = await callRoute(handler, 'POST', '/draft', { source: 'dispatch', config: { id: 'prof-x', model: 'm1' }, name: '我的方案', description: 'desc' });
    assert.equal(add.code, 200);
    assert.equal(add.json.ok, true);
    assert.equal(add.json.persisted, true);
    assert.equal(add.json.draft.config.id, 'prof-x');
    const list = await callRoute(handler, 'GET', '/drafts');
    assert.equal(list.json.drafts.length, 1);
    const id = list.json.drafts[0].id;
    const rem = await callRoute(handler, 'POST', '/draft/remove', { id });
    assert.equal(rem.json.ok, true);
    const list2 = await callRoute(handler, 'GET', '/drafts');
    assert.equal(list2.json.drafts.length, 0);
  } finally { iso.restore(); iso.teardown(); }
});
