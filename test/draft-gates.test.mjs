// test/draft-gates.test.mjs — auto-profile S1 draft 落库前的闸评估（纯函数 + fake 依赖）。
// 不依赖 index.mjs apply：直接构造 ctx/store/catalog/getEscapeSet 驱动
// assessDraftProfile，断言各闸 verdict 与 ok。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessDraftProfile } from '../lib/core/draft-gates.mjs';

function makeDeps() {
  const ctx = {
    get: (name) => (name === 'agentPresets'
      ? { list: async () => [{ id: 'standard', trust: 'system' }, { id: 'code', trust: 'system' }] }
      : undefined),
  };
  const store = { profiles: new Map() };
  const catalog = { getSnapshot: async () => ({ models: [{ id: 'm1', provider: 'p1' }], presets: [] }) };
  const getEscapeSet = () => [];
  return { ctx, store, catalog, getEscapeSet };
}

test('assessDraftProfile：合法 draft 全闸通过', async () => {
  const deps = makeDeps();
  const draft = { config: { id: 'prof-1', preset: 'standard', model: 'm1', provider: 'p1' }, name: 'n', description: '' };
  const r = await assessDraftProfile({ ...deps, draft });
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.verdict), ['pass', 'pass', 'pass', 'pass']);
  assert.equal(r.clean.id, 'prof-1');
  assert.equal(r.clean.tokenTier, 'balanced');
});

test('assessDraftProfile：白名单闸拒绝非 system 预设', async () => {
  const deps = makeDeps();
  const draft = { config: { id: 'prof-2', preset: 'evil' }, name: 'n', description: '' };
  const r = await assessDraftProfile({ ...deps, draft });
  assert.equal(r.ok, false);
  const wl = r.checks.find((c) => c.name === 'whitelist');
  assert.equal(wl.verdict, 'fail');
  assert.match(wl.reason, /不在 system-trust 白名单/);
});

test('assessDraftProfile：目录闸拒绝未知 model', async () => {
  const deps = makeDeps();
  const draft = { config: { id: 'prof-3', model: 'missing' }, name: 'n', description: '' };
  const r = await assessDraftProfile({ ...deps, draft });
  assert.equal(r.ok, false);
  const cat = r.checks.find((c) => c.name === 'catalog');
  assert.equal(cat.verdict, 'fail');
  assert.match(cat.reason, /不在当前模型目录/);
});

test('assessDraftProfile：id 冲突拒绝', async () => {
  const deps = makeDeps();
  deps.store.profiles.set('prof-1', { id: 'prof-1' });
  const draft = { config: { id: 'prof-1', preset: 'standard' }, name: 'n', description: '' };
  const r = await assessDraftProfile({ ...deps, draft });
  assert.equal(r.ok, false);
  const id = r.checks.find((c) => c.name === 'id');
  assert.equal(id.verdict, 'fail');
  assert.match(id.reason, /已存在/);
});

test('assessDraftProfile：draft 非对象 → 单条 fail', async () => {
  const deps = makeDeps();
  const r = await assessDraftProfile({ ...deps, draft: null });
  assert.equal(r.ok, false);
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].name, 'draft');
  assert.equal(r.checks[0].verdict, 'fail');
});
