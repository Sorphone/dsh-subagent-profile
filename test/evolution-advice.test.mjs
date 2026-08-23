// test/evolution-advice.test.mjs — 只读建议注入（evolution:advice，默认关）。
//   纯函数 suggestAdvice（四条件 + 升/降轴硬规则 + cooldown）+ 非 system 候选
//   fail-loud + 注入段门控（开关/编排者）+ POST /set-evolution-advice 路由。
// 纯函数段直接 import evolution-summary.mjs（无 index 依赖）；门控/路由段动态
// import index.mjs（junction），复用 test/harness 的 ctx 与 routes。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  suggestAdvice,
  presetFromKey,
  assertSystemCandidate,
} from '../lib/core/evolution-summary.mjs';
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
  assert.match(r.performanceText, /加权成功分 0\.333/);
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

// --- apply-time：注入段门控 + 路由 ---------------------------------------------

const ORCHESTRATOR_STUB = { composedPreset: () => 'orchestrator' };
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

test('advice section: 默认关（evolutionAdvice=false）→ orchestrator + 有数据也不注入', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:standard': underperformingEntry() });
    const { records } = await setupApp({ agentPresets: ORCHESTRATOR_STUB });
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    assert.ok(advice, 'evolution:advice section must be registered');
    assert.equal(advice.order, 116.8);
    assert.equal(advice.text({ agent: { ctx: {} } }), '', '默认关不注入');
  } finally { iso.restore(); iso.teardown(); }
});

test('advice section: 非 orchestrator → 即便开关开也不注入', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:standard': underperformingEntry() });
    const { routes, records } = await setupApp({ agentPresets: STANDARD_STUB });
    await postAdvice(routes, true);
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    assert.equal(advice.text({ agent: { ctx: {} } }), '', '非 orchestrator 不注入');
  } finally { iso.restore(); iso.teardown(); }
});

test('advice section: orchestrator + 开关开 + 欠佳 profile → 注入仅含聚合数字', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:standard': underperformingEntry() });
    const { routes, records } = await setupApp({ agentPresets: ORCHESTRATOR_STUB });
    await postAdvice(routes, true);
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    const text = advice.text({ agent: { ctx: {} } });
    assert.ok(text.length > 0, 'orchestrator + 开关开 → 注入非空');
    assert.match(text, /过去 3 次/);
    assert.match(text, /加权成功分 0\.333/);
    assert.match(text, /建议降级/);
    assert.match(text, /置信度 medium/);
    // 注入段只含确定性聚合数字与建议文案，永不含子 Agent 派生原文（如 persona/prompt 结构指纹）。
    assert.doesNotMatch(text, /persona_fp|structure|child_id|prompt/);
  } finally { iso.restore(); iso.teardown(); }
});

test('advice section: 非 system 候选出现在建议生成路径 → warn 留痕且不注入（不炸提示装配）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    writeSummariesFixture(iso.dir, { 'preset:custom': underperformingEntry() });
    const { routes, records } = await setupApp({ agentPresets: ORCHESTRATOR_STUB });
    await postAdvice(routes, true);
    const advice = records.sectionCalls.find((s) => s.name === 'evolution:advice');
    // 兜底行为：text 回调不抛（fail-loud 语义经 warn 日志留痕），注入为空——
    // 损坏/手改的 summaries 不得让 orchestrator 每请求提示装配失败。
    const text = advice.text({ agent: { ctx: {} } });
    assert.equal(text, '', '非 system 候选时不注入');
    assert.ok(records.logs.warn.some((args) => String(args).includes('system-trust 白名单')), 'warn 留痕 fail-loud 语义');
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
