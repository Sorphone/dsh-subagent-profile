// test/description-contract.test.mjs — description 落库契约：
//   校验纯函数（空/短/无场景词 → fail-loud 文案断言；含场景词 → 通过）；
//   内置 profile 描述含场景词；/add 写路径（新建/编辑严格、未传保留存量不校验）；
//   draft 应用路径 fail-loud。存量读取（loadProfiles）不迁移不校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertProfileDescription,
  DESCRIPTION_SCENARIO_WORDS,
  BUILTIN_SEEDS,
  createProfileStore,
} from '../lib/core/profiles-store.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

const FAIL_TEXT = /description 需写明适用场景（如：查资料\/周报汇总、多文件重构、只读审计），当前描述不含可用场景词/;

// ---- 校验纯函数：三态 ------------------------------------------------------------------

test('assertProfileDescription：空 / 短 / 无场景词 → fail-loud（文案定稿）', () => {
  for (const bad of ['', '   ', '写代码', '这是一段足够长但没有场景词的描述文本', null, undefined, 42]) {
    assert.throws(() => assertProfileDescription(bad), FAIL_TEXT, `必须拒绝：${String(bad)}`);
  }
});

test('assertProfileDescription：≥10 字符 + 含场景词 → 通过（返回 trim 文本）', () => {
  assert.equal(assertProfileDescription('  查资料与周报汇总的轻量任务方案  '), '查资料与周报汇总的轻量任务方案');
  assert.equal(assertProfileDescription('多文件重构与修复场景，适合标准编码'), '多文件重构与修复场景，适合标准编码');
  assert.equal(assertProfileDescription('只读审计类任务适用方案'), '只读审计类任务适用方案');
});

test('词表常量：任一场景词命中即通过', () => {
  for (const word of DESCRIPTION_SCENARIO_WORDS) {
    assert.doesNotThrow(() => assertProfileDescription(`适合${word}场景的派发方案描述`), `词表词「${word}」必须命中`);
  }
});

test('内置 profile 描述：全部含场景词且过契约（swap-standard / researcher）', () => {
  for (const seed of BUILTIN_SEEDS) {
    assert.doesNotThrow(() => assertProfileDescription(seed.description), `${seed.id} 内置描述必须含场景词`);
  }
});

// ---- store.saveProfile：新建/编辑严格 ---------------------------------------------------

test('store.saveProfile：带 description 键的保存过契约（不合格不落 Map）', () => {
  const iso = makeIsolatedDshHome();
  try {
    const store = createProfileStore({ dshHome: iso.dir, logger: { warn() {} } });
    assert.throws(() => store.saveProfile({ id: 'bad', description: '无场景词描述' }), FAIL_TEXT);
    assert.equal(store.profiles.has('bad'), false, '校验失败不得落 Map');
    store.saveProfile({ id: 'good', description: '查资料与汇总场景的方案', persisted: true });
    assert.equal(store.profiles.get('good').description, '查资料与汇总场景的方案');
    // 不带 description 键（如运行时注册）不校验。
    store.saveProfile({ id: 'nodesc', preset: 'standard' });
    assert.ok(store.profiles.has('nodesc'));
  } finally { iso.restore(); iso.teardown(); }
});

test('存量读取宽容：persisted 文件里无场景词描述照常载入（不迁移不校验）', () => {
  const iso = makeIsolatedDshHome();
  try {
    mkdirSync(iso.dir, { recursive: true });
    writeFileSync(join(iso.dir, 'subagent-profiles.json'), JSON.stringify({ version: 2, allowFailOpen: false, profiles: [{ id: 'legacy', name: 'L', description: '旧描述' }] }), 'utf8');
    const store = createProfileStore({ dshHome: iso.dir, logger: { warn() {}, info() {} } });
    store.loadProfiles();
    assert.equal(store.profiles.get('legacy')?.description, '旧描述', '存量描述原样载入');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- /add 写路径（新建/编辑严格，未传保留存量）-----------------------------------------

function makeRoutes() {
  const routes = [];
  const webServer = { register(config) { routes.push(config); return () => {}; } };
  return { webServer, routes };
}
async function post(handler, path, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method: 'POST',
    url: `http://localhost${path}`,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://127.0.0.1:12545', 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-subagent-profile' },
    on(event, fn) { (listeners[event] ??= []).push(fn); },
    destroy() {},
  };
  const res = {
    state: { code: null, data: '' },
    writeHead(code) { this.state.code = code; },
    end(text) { this.state.data = text; },
  };
  const bodyText = JSON.stringify(body);
  const p = handler(req, res);
  if (bodyText.length > 0) for (const fn of listeners.data) fn(Buffer.from(bodyText));
  for (const fn of listeners.end) fn();
  await p;
  return { code: res.state.code, json: res.state.data ? JSON.parse(res.state.data) : null };
}

async function get(handler, path) {
  const res = {
    state: { code: null, data: '' },
    writeHead(code) { this.state.code = code; },
    end(text) { this.state.data = text; },
  };
  const req = {
    method: 'GET',
    url: `http://localhost${path}`,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    on() {},
    destroy() {},
  };
  const p = handler(req, res);
  await p;
  return { code: res.state.code, json: res.state.data ? JSON.parse(res.state.data) : null };
}

test('/add：description 不合格（空/短/无场景词）→ 400 + 契约文案；含场景词 → 200', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeRoutes();
    const { ctx } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const handler = routes[0].handler;
    for (const bad of ['', '太短', '没有场景词的一段较长描述文本']) {
      const resp = await post(handler, '/subagent-profiles/add', { id: 'n1', name: 'N', description: bad });
      assert.equal(resp.code, 400, `description=${JSON.stringify(bad)} 必须 400`);
      assert.match(resp.json.error, FAIL_TEXT);
    }
    const ok = await post(handler, '/subagent-profiles/add', { id: 'n2', name: 'N2', description: '查资料与汇总的测试方案' });
    assert.equal(ok.code, 200, '含场景词描述必须落库');
    assert.equal(ok.json.id, 'n2');
  } finally { iso.restore(); iso.teardown(); }
});

test('/add：未传 description 保留存量值（存量宽容，不校验）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    mkdirSync(iso.dir, { recursive: true });
    writeFileSync(join(iso.dir, 'subagent-profiles.json'), JSON.stringify({ version: 2, allowFailOpen: false, profiles: [{ id: 'legacy', name: 'L', description: '旧描述' }] }), 'utf8');
    const { webServer, routes } = makeRoutes();
    const { ctx } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const handler = routes[0].handler;
    // 只改 name、不带 description：不得被契约拦截。
    const resp = await post(handler, '/subagent-profiles/add', { id: 'legacy', name: '新名字' });
    assert.equal(resp.code, 200, '未传 description 的编辑不得触发契约');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- draft 应用路径：fail-loud ----------------------------------------------------------

test('draft 应用：description 不合格 → fail-loud（500 + 日志含契约文案）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeRoutes();
    const { ctx, records } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const handler = routes[0].handler;
    const created = await post(handler, '/subagent-profiles/draft', { config: { id: 'd1' }, name: 'D1', description: '' });
    assert.equal(created.code, 200);
    const applied = await post(handler, '/subagent-profiles/draft/apply', { id: created.json.draft.id });
    assert.equal(applied.code, 500, '契约失败必须 fail-loud（500，不静默落库）');
    assert.ok(records.logs.error.some((args) => String(args).includes('description 需写明适用场景')), '日志必须含契约文案');
    // 失败不得留下半个 profile。
    const list = await get(handler, '/subagent-profiles/list');
    assert.equal(list.json.profiles.some((p) => p.id === 'd1'), false, '失败不得落库');
  } finally { iso.restore(); iso.teardown(); }
});

test('sanity: persisted 文件在契约失败后未被创建（fail-loud 不留半成品）', () => {
  const iso = makeIsolatedDshHome();
  try {
    const store = createProfileStore({ dshHome: iso.dir, logger: { warn() {} } });
    try { store.saveProfile({ id: 'x', description: '不合格描述' }); } catch { /* 预期 */ }
    assert.equal(existsSync(join(iso.dir, 'subagent-profiles.json')), false);
  } finally { iso.restore(); iso.teardown(); }
});
