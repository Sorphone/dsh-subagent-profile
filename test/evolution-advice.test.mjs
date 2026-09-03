// test/evolution-advice.test.mjs — 派发优化建议（evolution:advice）。
//   纯函数 suggestAdvice（四条件 + 升/降轴硬规则 + cooldown）+ 非 system 候选
//   fail-loud + 面板渲染（renderAdviceText）+ POST /set-evolution-advice 路由。
//   模型侧注入下架：evolution:advice section 注册结构保留但 text 恒空
//   （开关/编排者/数据齐全都不注入），trace 的 advice_present 埋点恒 false；
//   人类面板（建议卡/提醒中心/审计行）数据链不受影响。
// 纯函数段直接 import evolution-advice.mjs（无 index 依赖）；门控/路由段动态
// import index.mjs（junction），复用 test/harness 的 ctx 与 routes。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  suggestAdvice,
  presetFromKey,
  assertSystemCandidate,
  recentDispatchDetails,
  renderAdviceText,
} from '../lib/core/evolution-advice.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

// --- 纯函数 fixture ------------------------------------------------------------

function makeEntry({ n = 3, completed = 1, failed = 1, killed = 1, weightedSuccess = 0.333, untilTs = null, level } = {}) {
  return {
    deployments_total: n,
    outcome: { completed, failed, killed },
    score: { weighted_success: weightedSuccess, win_rate: 0.333 },
    perf: { avg_elapsed_ms: 150, avg_output_len: 500, avg_tool_count: 2 },
    confidence: { n, min_n_required: 3, level: level ?? (n >= 10 ? 'high' : n >= 3 ? 'medium' : 'low') },
    cooldown: { until_ts: untilTs, last_apply_ts: null },
  };
}

// --- suggestAdvice：四条件 ------------------------------------------------------

test('suggestAdvice：N<3 不产出（即便加权分低于阈值）', () => {
  const entry = makeEntry({ n: 2, completed: 0, failed: 2, killed: 0, weightedSuccess: 0 });
  assert.equal(suggestAdvice({ l1Entry: entry, profileKey: 'preset:standard', now: 1000 }), null);
});

test('suggestAdvice：聚合分阈值下才产出，达阈值不产出', () => {
  const bad = makeEntry({ n: 3, completed: 1, failed: 2, killed: 0, weightedSuccess: 0.333 });
  assert.ok(suggestAdvice({ l1Entry: bad, profileKey: 'preset:standard', now: 1000 }), '低于阈值产出');
  const good = makeEntry({ n: 3, weightedSuccess: 0.8 });
  assert.equal(suggestAdvice({ l1Entry: good, profileKey: 'preset:standard', now: 1000 }), null, '达阈值不产出');
});

test('suggestAdvice：置信度低于阈值（level=low）不产出', () => {
  const entry = makeEntry({ n: 3, weightedSuccess: 0.3, level: 'low' });
  assert.equal(suggestAdvice({ l1Entry: entry, profileKey: 'preset:standard', now: 1000 }), null);
});

test('suggestAdvice：cooldown 未过期阻断，过期后产出', () => {
  const active = makeEntry({ n: 3, weightedSuccess: 0.3, untilTs: 2000 });
  assert.equal(suggestAdvice({ l1Entry: active, profileKey: 'preset:standard', now: 1000 }), null);
  const expired = makeEntry({ n: 3, weightedSuccess: 0.3, untilTs: 500 });
  assert.ok(suggestAdvice({ l1Entry: expired, profileKey: 'preset:standard', now: 1000 }), '过期后产出');
});

test('suggestAdvice：输出字段（profileKey/performanceText/suggestion/confidence/cooldownUntil）', () => {
  const r = suggestAdvice({ l1Entry: makeEntry({ n: 3, weightedSuccess: 0.333 }), profileKey: 'preset:standard', now: 1000, cooldownMs: 600000 });
  assert.ok(r);
  assert.equal(r.profileKey, 'preset:standard');
  assert.equal(r.suggestion, '降');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.cooldownUntil, 1000 + 600000);
  assert.match(r.performanceText, /过去 3 次/);
  assert.match(r.performanceText, /近期表现分 0\.333/);
});

// --- suggestAdvice：对象描述与理由（候选分层轮）--------------------------------

test('suggestAdvice objectText：降方向按最保守改变取一段（人格/工具过滤先、模型次之、预设最后）', () => {
  const base = makeEntry({ n: 3, completed: 1, failed: 0, killed: 2, weightedSuccess: 0.333 });
  assert.equal(suggestAdvice({ l1Entry: base, profileKey: 'preset:standard|persona:1|toolFilter:1|model:deepseek-v4-pro', now: 1000 }).objectText, '去掉自定义人格');
  assert.equal(suggestAdvice({ l1Entry: base, profileKey: 'preset:standard|toolFilter:1', now: 1000 }).objectText, '移除工具过滤');
  assert.equal(suggestAdvice({ l1Entry: base, profileKey: 'model:deepseek-v4-pro', now: 1000 }).objectText, '模型改用更低档');
  assert.equal(suggestAdvice({ l1Entry: base, profileKey: 'preset:standard', now: 1000 }).objectText, '预设改用更低档');
  const flat = suggestAdvice({ l1Entry: base, profileKey: '(inline)', now: 1000 });
  assert.equal(flat.objectText, '', '平方向无对象描述');
});

test('suggestAdvice objectText：升方向按 L2 预算轴给推理强度/token 上限', () => {
  const base = makeEntry({ n: 3, completed: 1, failed: 2, killed: 0, weightedSuccess: 0.333 });
  const budgetEntry = { ...base, axes: { capability: false, budget: true } };
  const effort = suggestAdvice({ l1Entry: budgetEntry, profileKey: '(inline)', l2: { '(inline):reasoningEffort:off': {} }, now: 1000 });
  assert.equal(effort.suggestion, '升');
  assert.equal(effort.objectText, '推理强度上调一档');
  const tokens = suggestAdvice({ l1Entry: budgetEntry, profileKey: '(inline)', l2: { '(inline):maxTokens:1000': {} }, now: 1000 });
  assert.equal(tokens.objectText, 'maxTokens 上调');
});

test('suggestAdvice reasonText：人格终止计数 / 工具过滤 / 模型 / 预设的确定性理由', () => {
  const killed = makeEntry({ n: 3, completed: 1, failed: 0, killed: 2, weightedSuccess: 0.333 });
  const persona = suggestAdvice({ l1Entry: killed, profileKey: 'persona:1', now: 1000 });
  assert.equal(persona.reasonText, '带自定义人格的派发 3 次里 2 次被终止，去掉后可复用父会话统一提示');
  const noKill = suggestAdvice({ l1Entry: makeEntry({ n: 3, completed: 1, failed: 2, killed: 0, weightedSuccess: 0.333 }), profileKey: 'persona:1', now: 1000 });
  assert.equal(noKill.reasonText, '去掉自定义人格后，子 Agent 复用父会话统一提示，配置更简单');
  const filter = suggestAdvice({ l1Entry: killed, profileKey: 'toolFilter:1', now: 1000 });
  assert.equal(filter.reasonText, '移除工具过滤后，子 Agent 的工具面回到父会话范围，配置更简单');
  const model = suggestAdvice({ l1Entry: killed, profileKey: 'model:deepseek-v4-pro', now: 1000 });
  assert.equal(model.reasonText, '同类任务改用更低档模型，成本通常更低');
  const preset = suggestAdvice({ l1Entry: killed, profileKey: 'preset:standard', now: 1000 });
  assert.equal(preset.reasonText, '相邻低档预设能力相近，成本通常更低');
  const up = suggestAdvice({ l1Entry: { ...killed, axes: { capability: false, budget: true } }, profileKey: '(inline)', l2: { '(inline):reasoningEffort:off': {} }, now: 1000 });
  assert.equal(up.reasonText, '推理强度上调一档可提升复杂任务完成质量');
});

// --- suggestAdvice：升/降轴硬规则 ----------------------------------------------

test('suggestAdvice：能力轴建议恒 ∈{降,平}，永不升', () => {
  const capabilityKeys = ['preset:standard', 'provider:p1|model:m1', 'preset:standard|persona:1|toolFilter:1'];
  for (const key of capabilityKeys) {
    const r = suggestAdvice({ l1Entry: makeEntry({ n: 3, weightedSuccess: 0.3 }), profileKey: key, now: 1000 });
    assert.ok(r, `key ${key} 应产出`);
    assert.ok(['降', '平'].includes(r.suggestion), `能力轴 ${key} 建议须 ∈{降,平}，实际 ${r.suggestion}`);
  }
});

test('suggestAdvice：预算轴可含升；inline/未知轴维持平', () => {
  const budget = suggestAdvice({ l1Entry: makeEntry({ n: 3, weightedSuccess: 0.3 }), profileKey: 'effort:off', now: 1000 });
  assert.equal(budget.suggestion, '升');
  const inline = suggestAdvice({ l1Entry: makeEntry({ n: 3, weightedSuccess: 0.3 }), profileKey: '(inline)', now: 1000 });
  assert.equal(inline.suggestion, '平');
});

// --- 非 system 候选 fail-loud ----------------------------------------------------

test('presetFromKey：提取 preset 候选（无 preset 段返回 null）', () => {
  assert.equal(presetFromKey('preset:standard|provider:p1'), 'standard');
  assert.equal(presetFromKey('effort:off'), null);
  assert.equal(presetFromKey('(inline)'), null);
  assert.equal(presetFromKey(''), null);
});

test('assertSystemCandidate：非 system 候选 fail-loud 抛错（不静默滤掉）', () => {
  const whitelist = new Set(['standard', 'code', 'minimal']);
  assert.doesNotThrow(() => assertSystemCandidate(whitelist, 'standard'));
  assert.doesNotThrow(() => assertSystemCandidate(whitelist, null));
  assert.doesNotThrow(() => assertSystemCandidate(whitelist, 'inherit'));
  assert.throws(() => assertSystemCandidate(whitelist, 'custom'), /system-trust 白名单/);
});

test('recentDispatchDetails：按生效配置键匹配最近 N=5，只含渲染字段，无匹配/台账缺失空表', () => {
  const iso = makeIsolatedDshHome();
  try {
    const evoDir = join(iso.dir, 'subagent-evolution');
    mkdirSync(evoDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 7; i += 1) {
      lines.push(JSON.stringify({ v: 1, ts: 1000 + i, session_id: 'session-a', child_id: 'sub-' + i, mode: 'foreground', effective: { preset: 'standard' }, outcome: { status: 'completed', elapsed_ms: 100 + i } }));
    }
    writeFileSync(join(evoDir, 'dispatch.jsonl'), lines.join('\n'), 'utf8');
    const details = recentDispatchDetails(join(evoDir, 'dispatch.jsonl'), ['preset:standard'], { limit: 5 });
    assert.equal(details['preset:standard'].length, 5, '只取最近 5 次');
    assert.equal(details['preset:standard'][0].ts, 1006, '按时间倒序取最新');
    assert.deepEqual(Object.keys(details['preset:standard'][0]).sort(), ['childId', 'elapsedMs', 'mode', 'outcome', 'sessionId', 'ts'], '只含渲染所需字段');
    assert.deepEqual(recentDispatchDetails(join(evoDir, 'dispatch.jsonl'), ['preset:code']), {}, '无匹配为空表');
    assert.deepEqual(recentDispatchDetails(join(iso.dir, 'missing.jsonl'), ['preset:standard']), {}, '台账缺失空表');
  } finally { iso.restore(); iso.teardown(); }
});

// --- apply-time：注入段门控 + 路由 ---------------------------------------------

const ORCHESTRATOR_STUB = { composedPreset: () => 'orchestrator-v2' };
const STANDARD_STUB = { composedPreset: () => 'standard' };

function underperformingEntry() {
  return makeEntry({ n: 3, completed: 1, failed: 2, killed: 0, weightedSuccess: 0.333 });
}

function writeSummariesFixture(dir, l1) {
  const evoDir = join(dir, 'subagent-evolution');
  mkdirSync(evoDir, { recursive: true });
  writeFileSync(join(evoDir, 'summaries.json'), JSON.stringify({ v: 1, l1, l2: {} }, null, 2), 'utf8');
}

async function setupApp(options = {}) {
  const { webServer, routes } = makeRouteHarness();
  const services = { webServer };
  if (options.agentPresets !== undefined) services.agentPresets = options.agentPresets;
  const { ctx, records } = createFakeCtx({ services });
  await mod.apply(ctx);
  return { routes, records };
}

async function postAdvice(routes, adviceValue) {
  return callRoute(routes[0].handler, 'POST', '/set-evolution-advice', { advice: adviceValue });
}

test('advice section: 模型侧恒空——注册结构保留、默认关也不注入', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:standard': underperformingEntry() });
    const { records } = await setupApp({ agentPresets: ORCHESTRATOR_STUB });
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    assert.ok(advice, 'evolution:advice section must be registered（注册结构保留）');
    assert.equal(advice.order, 116.8);
    assert.equal(advice.text({ agent: { ctx: {} } }), '', '默认关恒空');
    assert.equal(advice.text({ agent: {} }), '', '任意 context 恒空');
  } finally { iso.restore(); iso.teardown(); }
});

test('advice section: 非 orchestrator-v2 / standard → 同样恒空', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:standard': underperformingEntry() });
    const { routes, records } = await setupApp({ agentPresets: STANDARD_STUB });
    await postAdvice(routes, true);
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    assert.equal(advice.text({ agent: { ctx: {} } }), '', 'standard → advice 恒空');
  } finally { iso.restore(); iso.teardown(); }
});

test('advice section: orchestrator-v2 + 开关开 + 欠佳 profile → 模型侧仍恒空', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:standard': underperformingEntry() });
    const { routes, records } = await setupApp({ agentPresets: ORCHESTRATOR_STUB });
    await postAdvice(routes, true);
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    assert.equal(advice.text({ agent: { ctx: {} } }), '', 'orchestrator-v2 + 开关开 + 有数据 → 恒空（不再注入聚合数字）');
    assert.equal(advice.text({ agent: {} }), '');
  } finally { iso.restore(); iso.teardown(); }
});

test('advice section: 非 system 候选不再经注入段报错（恒空、无 warn——生成链已不在模型侧）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:custom': underperformingEntry() });
    const { routes, records } = await setupApp({ agentPresets: ORCHESTRATOR_STUB });
    await postAdvice(routes, true);
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    const text = advice.text({ agent: { ctx: {} } });
    assert.equal(text, '', '候选校验失败不再产生注入可见标注（模型侧已下架）');
    assert.ok(!records.logs.warn.some((args) => String(args).includes('system-trust 白名单')), '注入段不再触发候选校验 warn（面板校验在 /list 链）');
  } finally { iso.restore(); iso.teardown(); }
});

test('advice section: N<3 非 system 候选组同样恒空、不抛、不 warn', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:custom': makeEntry({ n: 2, completed: 0, failed: 2, killed: 0, weightedSuccess: 0 }) });
    const { routes, records } = await setupApp({ agentPresets: ORCHESTRATOR_STUB });
    await postAdvice(routes, true);
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    assert.equal(advice.text({ agent: { ctx: {} } }), '', 'N<3 组恒空');
    assert.ok(!records.logs.warn.some((args) => String(args).includes('system-trust 白名单')), '不触发 system-trust 校验');
  } finally { iso.restore(); iso.teardown(); }
});

test('面板回归：renderAdviceText 仍可用且保留「仅供人类参考」面板侧文本', () => {
  const text = renderAdviceText(
    [{
      profileKey: 'preset:standard',
      performanceText: '过去 3 次：完成 1、失败 2、终止 0，近期表现分 0.333',
      suggestion: '降',
      confidence: 'medium',
      cooldownUntil: 1000 + 600000,
    }],
    { completed: 1, failed: 2, killed: 0 }
  );
  assert.match(text, /仅供人类参考，不改变派发行为/, '面板侧提示文本保留');
  assert.match(text, /过去 3 次/);
  assert.match(text, /建议降级/);
  assert.match(text, /置信度 中等/);
});

test('trace 门控恒 false：开关开 + orchestrator-v2 父会话 → advice_present 仍为 false', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      dispose: async () => {},
    });
    const { webServer, routes } = makeRouteHarness();
    const agentPresets = { composedPreset: () => 'orchestrator-v2', list: async () => [{ id: 'standard', trust: 'system' }] };
    const { ctx, records } = createFakeCtx({ services: { webServer, agentPresets }, subagentsStart });
    await mod.apply(ctx);
    await postAdvice(routes, true);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const parent = {
      ctx: { get: (name) => (name === 'agentPresets' ? agentPresets : undefined), tools: { schemas: () => [{ name: 'read' }] } },
      options: {},
      session: { header: { id: 'sess-advice-off' } },
    };
    const out = await tool.execute({ prompt: 'task' }, { agent: parent, signal: undefined });
    assert.equal(out.decisionTrace.requested.advice_present, false, '模型侧下架后 advice_present 恒 false');
  } finally { iso.restore(); iso.teardown(); }
});

test('POST /set-evolution-advice: 切换开关并持久化到 state.json（保留 enabled）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { routes } = await setupApp();
    const on = await postAdvice(routes, true);
    assert.equal(on.code, 200);
    assert.equal(on.json.ok, true);
    assert.equal(on.json.evolutionAdvice, true);
    const stateFile = join(iso.dir, 'subagent-profiles.state.json');
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(parsed.evolutionAdvice, true);
    assert.equal(parsed.enabled, true, '持久化须保留 enabled 字段');
    const off = await postAdvice(routes, false);
    assert.equal(off.code, 200);
    assert.equal(off.json.evolutionAdvice, false);
  } finally { iso.restore(); iso.teardown(); }
});
