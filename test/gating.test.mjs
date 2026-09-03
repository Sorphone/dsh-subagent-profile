// test/gating.test.mjs — 系统提示门控（门控拆分后口径）：
//   * dispatch:profiles 挂 profileSectionGate（能力判据）：enabled + schemas 含
//     dispatch 即注入，任何可派发会话可见（非 orchestrator-v2 亦可）；schemas 明确
//     不含 dispatch → 必空（否决）。
//   * orchestrator:mode / dispatch:budget 挂 orchestrationGate
//     （模式判据，与 0.4.0 一致）：enabled + 否决 + composedPreset ===
//     'orchestrator-v2'；无 agentPresets 保守不注入。禁止成对放宽共享 gate。
//   * evolution:advice 模型侧恒空（下架，不挂注入门控）——注册结构与
//     恒空断言见 evolution-advice.test.mjs。
//
// 快照口径：section.text(context) 收到 `{ agent, scope, signal }`；dispatch 工具由
// host 行注册，对每个 agent 恒可见（缺省 toolSchemas=[{name:'dispatch'}]）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// 取 apply() 注册的四个 section 的 text 回调。
function sectionsOf(records) {
  const names = ['dispatch:profiles', 'orchestrator:mode', 'evolution:advice', 'dispatch:budget'];
  const out = {};
  for (const name of names) {
    const section = records.sectionCalls.find((s) => s.name === name);
    assert.ok(section, `${name} section must be registered`);
    out[name] = section;
  }
  return out;
}

// 经 HTTP /set-enabled 把插件置为禁用：该路由同步改写 apply 闭包的 `enabled`。
function makeSetEnabledRoute() {
  const routes = [];
  const webServer = { register(config) { routes.push(config); return () => {}; } };
  return { webServer, routes };
}
async function postSetEnabled(handler, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method: 'POST',
    url: 'http://localhost/subagent-profiles/set-enabled',
    socket: { remoteAddress: '127.0.0.1' },
    // 写路由 CSRF 三件套（小写键镜像 Node req.headers 归一化）。
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
async function disablePlugin(routes) {
  const handler = routes[0].handler;
  const resp = await postSetEnabled(handler, { enabled: false });
  assert.equal(resp.code, 200);
  assert.equal(resp.json.enabled, false);
}

const ORCHESTRATOR_STUB = { composedPreset: () => 'orchestrator-v2' };
const STANDARD_STUB = { composedPreset: () => 'standard' };

test('gate: orchestrator-v2 + schemas 含 dispatch → profiles 与三段编排语料均非空', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ services: { agentPresets: ORCHESTRATOR_STUB } });
    await mod.apply(ctx);
    const s = sectionsOf(records);
    assert.ok(s['dispatch:profiles'].text({ agent: { ctx: {} } }).length > 0, 'orchestrator-v2 → profiles 非空');
    assert.ok(s['orchestrator:mode'].text({ agent: { ctx: {} } }).length > 0, 'orchestrator-v2 → mode 非空');
    // budget 段需要父 sessionId；编排者会话下注入（三态文案断言见 budget-states.test.mjs）。
    const budgetText = s['dispatch:budget'].text({ agent: { ctx: {}, session: { header: { id: 's1' } } } });
    assert.match(budgetText, /派发预算/, 'orchestrator-v2 + sessionId → budget 非空');
    assert.equal(s['dispatch:budget'].text({ agent: { ctx: {} } }), '', '无父 sessionId 不注入');
  } finally { iso.restore(); iso.teardown(); }
});

test('gate: composedPreset=orchestrator（旧名残留模拟）→ 编排段不注入（精确匹配新名）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    // 判据为精确匹配 'orchestrator-v2'：旧名 orchestrator 不再构成注入条件。
    const legacy = { composedPreset: () => 'orchestrator' };
    const { ctx, records } = createFakeCtx({ services: { agentPresets: legacy } });
    await mod.apply(ctx);
    const s = sectionsOf(records);
    assert.ok(s['dispatch:profiles'].text({ agent: { ctx: {} } }).length > 0, '旧名会话 profiles 段仍按能力判据注入');
    assert.equal(s['orchestrator:mode'].text({ agent: { ctx: {} } }), '', '旧名 orchestrator → mode 不注入');
    assert.equal(s['evolution:advice'].text({ agent: { ctx: {} } }), '', '旧名 orchestrator → advice 不注入');
    assert.equal(s['dispatch:budget'].text({ agent: { ctx: {}, session: { header: { id: 's1' } } } }), '', '旧名 orchestrator → budget 不注入');
  } finally { iso.restore(); iso.teardown(); }
});

test('gate: schemas 含 dispatch 但 composedPreset=standard → profiles 注入、编排段空', async () => {
  const iso = makeIsolatedDshHome();
  try {
    // default toolSchemas=[{name:'dispatch'}]（含 dispatch），但 preset 非 orchestrator-v2。
    const { ctx, records } = createFakeCtx({ services: { agentPresets: STANDARD_STUB } });
    await mod.apply(ctx);
    const s = sectionsOf(records);
    assert.ok(s['dispatch:profiles'].text({ agent: {} }).length > 0, 'schemas 含 dispatch → profiles 注入（非 orchestrator-v2 亦可）');
    assert.equal(s['orchestrator:mode'].text({ agent: {} }), '', 'standard → mode 空（编排者专属）');
    assert.equal(s['evolution:advice'].text({ agent: {} }), '', 'standard → advice 空（编排者专属）');
    assert.equal(s['dispatch:budget'].text({ agent: { session: { header: { id: 's1' } } } }), '', 'standard → budget 空（编排者专属）');
  } finally { iso.restore(); iso.teardown(); }
});

test('gate: schemas 明确不含 dispatch → 四段全空（否决）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ toolSchemas: [], services: { agentPresets: ORCHESTRATOR_STUB } });
    await mod.apply(ctx);
    const s = sectionsOf(records);
    assert.equal(s['dispatch:profiles'].text({ agent: {} }), '', 'schemas 无 dispatch → profiles 空（否决）');
    assert.equal(s['orchestrator:mode'].text({ agent: {} }), '', 'schemas 无 dispatch → mode 空（否决）');
    assert.equal(s['evolution:advice'].text({ agent: {} }), '', 'schemas 无 dispatch → advice 空（否决）');
    assert.equal(s['dispatch:budget'].text({ agent: { session: { header: { id: 's1' } } } }), '', 'schemas 无 dispatch → budget 空（否决）');
  } finally { iso.restore(); iso.teardown(); }
});

test('gate: 无 agentPresets → profiles 注入（能力判据）、编排段空（模式判据保守不注入）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx(); // 默认 services 无 agentPresets
    await mod.apply(ctx);
    const s = sectionsOf(records);
    assert.ok(s['dispatch:profiles'].text({ agent: { ctx: {} } }).length > 0, '无 agentPresets → profiles 仍注入（schemas 含 dispatch）');
    assert.equal(s['orchestrator:mode'].text({ agent: { ctx: {} } }), '', '无 agentPresets → mode 空');
    assert.equal(s['dispatch:budget'].text({ agent: { session: { header: { id: 's1' } } } }), '', '无 agentPresets → budget 空');
  } finally { iso.restore(); iso.teardown(); }
});

test('gate: context 缺省（无 agent）→ profiles 按注入机会非空；编排段按 preset 判据', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ services: { agentPresets: ORCHESTRATOR_STUB } });
    await mod.apply(ctx);
    const s = sectionsOf(records);
    // context 缺省 → schemas 不可用 → profiles 视为一次注入机会（debug 留痕后注入）。
    assert.ok(s['dispatch:profiles'].text().length > 0, 'context 缺省 + 注入机会 → profiles 非空');
    // 编排段主判据 agentCtx 取插件 ctx；stub 忽略入参返回 orchestrator-v2。
    assert.ok(s['orchestrator:mode'].text().length > 0, 'context 缺省 + orchestrator-v2 桩 → mode 非空');
    const standard = createFakeCtx({ services: { agentPresets: STANDARD_STUB } });
    await mod.apply(standard.ctx);
    const s2 = sectionsOf(standard.records);
    assert.equal(s2['orchestrator:mode'].text(), '', 'context 缺省 + standard 桩 → mode 空');
  } finally { iso.restore(); iso.teardown(); }
});

test('gate: enabled=false → profiles 与编排段全空（第一道门）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeSetEnabledRoute();
    const { ctx, records } = createFakeCtx({ services: { webServer, agentPresets: ORCHESTRATOR_STUB } });
    await mod.apply(ctx);
    await disablePlugin(routes);
    const s = sectionsOf(records);
    assert.equal(s['dispatch:profiles'].text({ agent: {} }), '', 'enabled=false → profiles 空');
    assert.equal(s['orchestrator:mode'].text({ agent: {} }), '', 'enabled=false → mode 空');
    assert.equal(s['dispatch:budget'].text({ agent: { session: { header: { id: 's1' } } } }), '', 'enabled=false → budget 空');
  } finally { iso.restore(); iso.teardown(); }
});

test('gate: orchestrator:mode 文案为编排者模式 V2 定稿、无旧文案残留', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ services: { agentPresets: ORCHESTRATOR_STUB } });
    await mod.apply(ctx);
    const s = sectionsOf(records);
    const text = s['orchestrator:mode'].text({ agent: { ctx: {} } });
    assert.ok(text.includes('编排者模式 V2'), '文案必须指认编排者模式 V2');
    assert.ok(text.includes('字段 orchestrator-v2'), '文案必须标注新预设字段名');
    assert.ok(text.includes('Minimal 双工具'), '文案必须含两阶段引导语义');
    // 追加：官方错误对照句（not allowed → 白名单 → list_subagent_models 或转 dispatch）。
    assert.ok(text.includes('not allowed for this Session'), '文案必须含官方错误原文对照');
    assert.ok(text.includes('list_subagent_models 查允许路由'), '文案必须给官方错误的中文行动引导');
    assert.ok(text.includes('转用 dispatch（profile）'), '文案必须给转用 dispatch 的替代路径');
    // 旧说明书体文案标记不得残留。
    assert.ok(!text.includes('dsh-subagent-profile 插件的「编排者模式」'), '旧说明文案已替换');
    assert.ok(!text.includes('主协调模式'), '旧关键词已移除');
    assert.ok(!text.includes('swap-standard'), '旧内置方案枚举已移除');
  } finally { iso.restore(); iso.teardown(); }
});
