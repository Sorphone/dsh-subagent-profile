// test/evolution-canary.test.mjs — 金丝雀防退化域单测 + 路由集成：apply 基线/快照、
// 观察期计数、判定（regress/applied/inconclusive/stalled/aborted）、回滚建议与执行、
// 显式保留决议（keep）、人工编辑中止、冷启动、观察期联动、回滚冷却有界、hold-out
// 契约、L3-4 per-call 契约。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEvolutionAssets } from '../lib/core/evolution-assets.mjs';
import { createEvolutionEngine } from '../lib/core/evolution-engine.mjs';
import { configIdentityKey, profileFingerprint, sourceConfigFromKey } from '../lib/core/evolution-draft.mjs';
import { sanitizeProfile } from '../lib/core/pure.mjs';
import { BUILTIN_SEEDS } from '../lib/core/profiles-store.mjs';
import { CANARY_K, CANARY_STALL_MS, evolutionStatusOf, holdoutBacktest, rollbackSuggestionOf } from '../lib/core/evolution-canary.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

// --- fake 依赖 --------------------------------------------------------------------

function makeFakeLlm(models = [{ id: 'm1' }, { id: 'm2' }]) {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async (provider) => (provider === 'p1' ? models : []),
    resolveModelInfo: async () => ({}),
    resolveCallConfig: async () => ({}),
  };
}

function makeCatalog({ models = [], presets = [] } = {}) {
  return { getSnapshot: async () => ({ models, tools: [{ name: 'bash' }, { name: 'read' }], presets, efforts: {}, llm: { providersError: undefined, providers: [{ id: 'p1' }], modelsByProvider: { p1: { ok: true, models } } } }) };
}

// 基线聚合：preset:standard 5 次 0.8（下沿 ≈ 0.4，可构造 regress 与 applied）。
const SUMMARIES = {
  v: 1,
  l1: { 'preset:standard': { score: { weighted_success: 0.8 }, confidence: { n: 5, level: 'medium' }, deployments_total: 5, cooldown: { until_ts: null } } },
  l2: {},
};

let childSeq = 0;
function disp(ts, cfg, status = 'completed') {
  childSeq += 1;
  return { v: 1, ts, child_id: 'child-' + childSeq, effective: typeof cfg === 'object' ? cfg : { preset: cfg }, outcome: { status } };
}

// apply 前基线派发（4 完成 1 失败 → 加权分 0.8）。
function baselineRecords(now) {
  const out = [];
  for (let i = 0; i < 4; i += 1) out.push(disp(now - 100000 - i * 1000, 'standard', 'completed'));
  out.push(disp(now - 100000 - 5000, 'standard', 'failed'));
  return out;
}

// 带人格与工具过滤的身份键（swap-standard 完整配置的聚合口径）：候选「去掉自定义
// 人格与工具过滤」应用后身份键回到 preset:standard。
const RICH_KEY = 'preset:standard|persona:1|toolFilter:1';
const RICH_EFFECTIVE = { preset: 'standard', persona_present: true, toolFilter_present: true };
const RICH_SUMMARIES = {
  v: 1,
  l1: { [RICH_KEY]: { score: { weighted_success: 0.8 }, confidence: { n: 5, level: 'medium' }, deployments_total: 5, cooldown: { until_ts: null } } },
  l2: {},
};
function richBaselineRecords(now) {
  const out = [];
  for (let i = 0; i < 4; i += 1) out.push(disp(now - 100000 - i * 1000, RICH_EFFECTIVE, 'completed'));
  out.push(disp(now - 100000 - 5000, RICH_EFFECTIVE, 'failed'));
  return out;
}
// 去人格/工具过滤后的应用配置（身份键 = preset:standard）。
const APPLY_CONFIG = { id: 'evo-down-a', preset: 'standard' };

function swapStandardProfile() {
  return {
    id: 'swap-standard',
    name: '标准编码',
    description: '切换到 standard 预设的完整编码工具集。',
    preset: 'standard',
    persona: 'You are a coding subagent.',
    toolFilter: { allow: ['bash', 'read'] },
    tokenTier: 'balanced',
  };
}

function makeEngineDeps({ asset, summaries = SUMMARIES, applyEnabled = true, adviceEnabled = true, models = [], presets = [], profiles = new Map(), records = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evo-canary-test-'));
  const logs = [];
  const audits = [];
  const persistedCalls = [];
  const cooldowns = [];
  const store = {
    profiles: profiles ?? new Map(),
    persistProfiles: () => { persistedCalls.push(1); return { persisted: true }; },
    getAllowFailOpen: () => false,
  };
  const assets = createEvolutionAssets({ dshHome: dir, logger: { warn: (...a) => logs.push(a.join(' ')) }, onGovernanceFailure: () => {} });
  if (asset !== undefined) assets.add(asset);
  const mints = [];
  const engine = createEvolutionEngine({
    store,
    catalog: makeCatalog({ models, presets }),
    assets,
    evoLedger: { recordGovernanceAudit: (entry) => audits.push(entry) },
    whitelist: new Set(['standard', 'code']),
    logger: { warn: (...a) => logs.push(a.join(' ')) },
    getApplyEnabled: () => applyEnabled,
    getAdviceEnabled: () => adviceEnabled,
    getAllowFailOpen: () => false,
    getLlm: () => makeFakeLlm(models.length > 0 ? models : [{ id: 'm1' }]),
    getSummaries: () => summaries,
    getCandidateMode: () => 'auto',
    getCandidateTtlH: () => 24,
    getDispatchRecords: () => records,
    injectRollbackCooldown: (key, until) => cooldowns.push({ key, until }),
    mintRollbackReminder: (entry) => mints.push(entry),
    pluginVersion: '0.0.0-test',
  });
  return { dir, assets, store, audits, logs, engine, records, persistedCalls, cooldowns, mints, teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

function makeAsset(overrides = {}) {
  return {
    v: 1,
    id: 'evo-down-a',
    source: 'evolution',
    provenance: { generatedAt: 1, basis: { profileKey: 'preset:standard' } },
    state: 'draft',
    version: 1,
    expiry: null,
    from: { preset: 'standard' },
    to: { id: 'evo-down-a', preset: 'standard' },
    axis: 'capability',
    direction: 'down',
    baseline_snapshot: { from: { preset: 'standard' }, score: 0.8, n: 5, confidence: 'medium' },
    profile_key: 'preset:standard',
    profile_fingerprint: 'unused',
    config: { id: 'evo-down-a', preset: 'standard' },
    name: '进化草稿-preset:standard',
    description: '建议：降级能力配置',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeMatchAsset(overrides = {}, summaries = SUMMARIES, registry = []) {
  const key = overrides.profile_key ?? 'preset:standard';
  const from = overrides.from ?? sourceConfigFromKey(key, summaries.l2 ?? {});
  const fingerprint = profileFingerprint({ profileKey: key, from, registryEntries: registry });
  return makeAsset({ profile_key: key, from, profile_fingerprint: fingerprint, ...overrides });
}

// 应用后的相关派发身份（应用写入的方案配置）。
const CODE_CONFIG = { id: 'evo-down-a', preset: 'code' };

// --- 1. apply 基线/快照字段齐备 ---------------------------------------------------

test('1 apply → 资产含 fromSnapshot（完整配置快照）+ baseline_metrics 字段齐备', async () => {
  const now = Date.now();
  const profiles = new Map([['swap-standard', { ...swapStandardProfile(), persisted: true }]]);
  const registry = [sanitizeProfile(swapStandardProfile(), { strict: false }).clean];
  const asset = makeMatchAsset({ profile_key: RICH_KEY, config: APPLY_CONFIG, to: APPLY_CONFIG }, RICH_SUMMARIES, registry);
  const t = makeEngineDeps({ asset, summaries: RICH_SUMMARIES, profiles, records: richBaselineRecords(now) });
  try {
    const result = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(result.ok, true);
    const applied = t.assets.get('evo-down-a');
    assert.equal(applied.state, 'proposed');
    assert.equal(applied.fromSnapshot.kind, 'full-profile-snapshots');
    assert.equal(applied.fromSnapshot.profiles.length, 1);
    const snap = applied.fromSnapshot.profiles[0].config;
    assert.equal(snap.id, 'swap-standard');
    assert.equal(snap.name, '标准编码', '快照含 name（非「保存为方案」节选段）');
    assert.equal(snap.description.length > 0, true, '快照含 description');
    assert.equal(snap.persona, 'You are a coding subagent.', '快照含 persona 原文字段');
    assert.deepEqual(snap.toolFilter, { allow: ['bash', 'read'] }, '快照含 toolFilter');
    assert.equal(snap.tokenTier, 'balanced');
    assert.equal(applied.baseline_metrics.sampleN, 5);
    assert.equal(applied.baseline_metrics.weighted_success, 0.8);
    assert.equal(applied.canary.kTotal, CANARY_K);
    assert.equal(applied.canary.baseline.scores.length, 5, '基线逐条分齐备（下沿构造输入）');
    assert.equal(applied.applied_config.id, 'evo-down-a');
    const audit = t.audits[0];
    assert.equal(audit.event, 'suggestion-apply');
    assert.ok('baseline_snapshot' in audit, 'apply 审计字段保持兼容（applyAuditEntry 不动）');
  } finally { t.teardown(); }
});

// --- 2. 观察期计数 / 无关派发 / stalled ---------------------------------------------

test('2 观察期计数：K=5 相关派发后判定；无关派发不计', async () => {
  const now = Date.now();
  const records = baselineRecords(now);
  const asset = makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, SUMMARIES, []);
  const t = makeEngineDeps({ asset, summaries: SUMMARIES, records });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    records.push(disp(now + 1000, 'code', 'completed'), disp(now + 2000, 'code', 'completed'), disp(now + 3000, 'code', 'failed'));
    records.push(disp(now + 1500, 'minimal', 'completed'), disp(now + 2500, 'minimal', 'completed'));
    const mid = t.engine.evaluateCanaries(now + 5000);
    assert.equal(mid[0].verdict, 'pending');
    assert.equal(t.assets.get('evo-down-a').canary.k, 3, '无关派发不计入观察期');
    assert.equal(t.assets.get('evo-down-a').canary.samples.length, 3);
    assert.equal(t.assets.get('evo-down-a').canary.samples[0].sampleN, 1, '样本点含累计 sampleN/weighted_success');
    records.push(disp(now + 4000, 'code', 'completed'), disp(now + 4500, 'code', 'completed'));
    const done = t.engine.evaluateCanaries(now + 6000);
    assert.equal(done[0].verdict, 'applied', 'K=5 后判定（4 完成 1 失败 = 0.8 ≥ 基线均值）');
    assert.equal(t.assets.get('evo-down-a').state, 'applied');
    assert.equal(t.audits.filter((a) => a.event === 'golden-canary').length, 1, '判定只写一次 golden-canary');
  } finally { t.teardown(); }
});

test('2b 24h 无新派发 → stalled（判定延期，不误判）', async () => {
  const now = Date.now();
  const asset = makeMatchAsset({}, SUMMARIES, []);
  const t = makeEngineDeps({ asset, summaries: SUMMARIES, records: baselineRecords(now) });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    const result = t.engine.evaluateCanaries(now + CANARY_STALL_MS + 1000);
    assert.equal(result[0].verdict, 'stalled');
    const applied = t.assets.get('evo-down-a');
    assert.equal(applied.state, 'proposed', 'stalled 保持观察期（延期）');
    assert.equal(applied.canary.stalled, true);
    const golden = t.audits.filter((a) => a.event === 'golden-canary');
    assert.equal(golden.length, 1);
    assert.equal(golden[0].verdict, 'stalled');
  } finally { t.teardown(); }
});

// --- 3. 跌破基线 → 回滚建议（不自动回滚/不自动写） ---------------------------------

test('3 判定跌破基线 → 回滚建议 + golden-canary 审计，且不自动回滚/不自动写 profile', async () => {
  const now = Date.now();
  const records = baselineRecords(now);
  const asset = makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, SUMMARIES, []);
  const t = makeEngineDeps({ asset, summaries: SUMMARIES, records });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    const writesBefore = t.persistedCalls.length;
    for (let i = 0; i < 5; i += 1) records.push(disp(now + 1000 + i * 1000, 'code', 'failed'));
    const result = t.engine.evaluateCanaries(now + 20000);
    assert.equal(result[0].verdict, 'regress');
    const applied = t.assets.get('evo-down-a');
    assert.equal(applied.state, 'proposed', 'regress 不自动转 applied');
    assert.equal(t.persistedCalls.length, writesBefore, '判定绝不自动写 profile');
    const golden = t.audits.filter((a) => a.event === 'golden-canary');
    assert.equal(golden.length, 1);
    assert.equal(golden[0].verdict, 'regress');
    assert.equal(golden[0].asset_id, 'evo-down-a');
    assert.equal(golden[0].baseline_metrics.sampleN, 5);
    assert.equal(golden[0].post_metrics.weighted_success, 0);
    const suggestion = rollbackSuggestionOf(applied);
    assert.ok(suggestion !== null, 'regress → 回滚建议条目');
    assert.equal(suggestion.assetId, 'evo-down-a');
    assert.equal(suggestion.reason, '观察期表现较基线下降');
    assert.equal(suggestion.evidence.delta, -0.8, '证据样本 Δ = post − 基线');
    assert.equal(suggestion.to.profiles.length, 0, '无既有方案时快照为空表（回滚 = 移除应用方案）');
    assert.equal(t.store.profiles.has('evo-down-a'), true, '应用方案保持（不自动回滚）');
  } finally { t.teardown(); }
});

// --- 4. 未下跌 → applied；±1σ 且样本不足 → inconclusive -----------------------------

test('4 判定：未下跌 → applied；±1σ 内且样本 < 基线 → inconclusive 延长观察', async () => {
  const now = Date.now();
  const records = baselineRecords(now);
  const t = makeEngineDeps({ asset: makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, SUMMARIES, []), summaries: SUMMARIES, records });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    for (let i = 0; i < 5; i += 1) records.push(disp(now + 1000 + i * 1000, 'code', 'completed'));
    const result = t.engine.evaluateCanaries(now + 20000);
    assert.equal(result[0].verdict, 'applied');
    assert.equal(t.assets.get('evo-down-a').state, 'applied');
  } finally { t.teardown(); }

  const now2 = Date.now();
  const summaries10 = { v: 1, l1: { 'preset:standard': { score: { weighted_success: 0.8 }, confidence: { n: 10, level: 'high' }, cooldown: { until_ts: null } } }, l2: {} };
  const records2 = [];
  for (let i = 0; i < 8; i += 1) records2.push(disp(now2 - 100000 - i * 1000, 'standard', 'completed'));
  records2.push(disp(now2 - 200000, 'standard', 'failed'), disp(now2 - 201000, 'standard', 'failed'));
  const t2 = makeEngineDeps({ asset: makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, summaries10, []), summaries: summaries10, records: records2 });
  try {
    await t2.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    for (let i = 0; i < 5; i += 1) records2.push(disp(now2 + 1000 + i * 1000, 'code', i < 3 ? 'completed' : 'failed'));
    const first = t2.engine.evaluateCanaries(now2 + 20000);
    assert.equal(first[0].verdict, 'inconclusive', '0.6 在 ±1σ 内且样本 < 基线 → 延长观察');
    const asset2 = t2.assets.get('evo-down-a');
    assert.equal(asset2.canary.insufficient, true);
    assert.equal(asset2.state, 'proposed', 'inconclusive 留 proposed 继续等待');
    for (let i = 0; i < 5; i += 1) records2.push(disp(now2 + 20000 + i * 1000, 'code', 'completed'));
    const second = t2.engine.evaluateCanaries(now2 + 40000);
    assert.equal(second[0].verdict, 'applied', '补足样本后重新判定（0.8 ≥ 基线均值）');
    assert.equal(t2.audits.filter((a) => a.event === 'golden-canary').length, 2, '两次判定各写一条 golden-canary');
  } finally { t2.teardown(); }
});

// --- 5. 回滚人工确认双分支（引擎层） ------------------------------------------------

test('5 回滚：humanConfirmed=false → 拒绝+审计；true → 恢复完整配置+持久化+rolled_back+审计双分支', async () => {
  const now = Date.now();
  const profiles = new Map([['swap-standard', { ...swapStandardProfile(), persisted: true }]]);
  const registry = [sanitizeProfile(swapStandardProfile(), { strict: false }).clean];
  const asset = makeMatchAsset({ profile_key: RICH_KEY, config: APPLY_CONFIG, to: APPLY_CONFIG }, RICH_SUMMARIES, registry);
  const t = makeEngineDeps({ asset, summaries: RICH_SUMMARIES, profiles, records: richBaselineRecords(now) });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    for (let i = 0; i < 5; i += 1) recordsOf(t).push(disp(now + 1000 + i * 1000, 'standard', 'failed'));
    t.engine.evaluateCanaries(now + 20000);
    const denied = await t.engine.rollback({ assetId: 'evo-down-a', humanConfirmed: false });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /人工确认/);
    assert.equal(t.assets.get('evo-down-a').state, 'proposed', '拒绝不改变资产状态');
    const ok = await t.engine.rollback({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(ok.ok, true);
    assert.equal(ok.persisted, true);
    assert.deepEqual(ok.restored, ['swap-standard']);
    assert.ok(!t.store.profiles.has('evo-down-a'), '应用写入的方案被移除');
    const restored = t.store.profiles.get('swap-standard');
    assert.equal(restored.persona, 'You are a coding subagent.', '完整配置恢复（persona）');
    assert.deepEqual(restored.toolFilter, { allow: ['bash', 'read'] }, '完整配置恢复（toolFilter）');
    assert.equal(restored.name, '标准编码', '完整配置恢复（name）');
    assert.equal(t.assets.get('evo-down-a').state, 'rolled_back');
    const rollbacks = t.audits.filter((a) => a.event === 'suggestion-rollback');
    assert.equal(rollbacks.length, 2, '拒绝/通过双分支都写审计');
    assert.equal(rollbacks[0].human_confirmed, false);
    assert.equal(rollbacks[1].human_confirmed, true);
    assert.equal(rollbacks[1].gates.whitelist.verdict, 'skipped', '回滚不重过三道闸');
    assert.equal(rollbacks[1].gates.approval, 'never');
    assert.equal(t.cooldowns.length, 1, '回滚注入同键冷却');
    assert.ok(t.cooldowns[0].until >= now + 600000 - 5000);
  } finally { t.teardown(); }
});

// --- 5k. 显式保留（keep）决议 ---------------------------------------------------------

test('5k keep：humanConfirmed=false → 拒绝 + suggestion-keep 审计（不写 profile）', async () => {
  const now = Date.now();
  const profiles = new Map([['swap-standard', { ...swapStandardProfile(), persisted: true }]]);
  const registry = [sanitizeProfile(swapStandardProfile(), { strict: false }).clean];
  const asset = makeMatchAsset({ profile_key: RICH_KEY, config: APPLY_CONFIG, to: APPLY_CONFIG }, RICH_SUMMARIES, registry);
  const t = makeEngineDeps({ asset, summaries: RICH_SUMMARIES, profiles, records: richBaselineRecords(now) });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    for (let i = 0; i < 5; i += 1) t.records.push(disp(now + 1000 + i * 1000, 'standard', 'failed'));
    t.engine.evaluateCanaries(now + 20000);
    const writesBefore = t.persistedCalls.length;
    const denied = await t.engine.rollback({ assetId: 'evo-down-a', humanConfirmed: false, action: 'keep' });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /人工确认/);
    assert.equal(t.assets.get('evo-down-a').state, 'proposed', '拒绝不改变资产状态');
    assert.equal(t.persistedCalls.length, writesBefore, '拒绝不写 profile');
    const keeps = t.audits.filter((a) => a.event === 'suggestion-keep');
    assert.equal(keeps.length, 1, '拒绝分支写 suggestion-keep 审计');
    assert.equal(keeps[0].human_confirmed, false);
    assert.equal(keeps[0].asset_id, 'evo-down-a');
    assert.equal(keeps[0].profile_key, RICH_KEY);
    assert.ok(typeof keeps[0].reason === 'string', '拒绝分支附原因');
  } finally { t.teardown(); }
});

test('5k2 keep 成功：资产 applied + suggestion-keep（reason=user-kept）+ 冷却内同方向建议抑制 + 不写 profile', async () => {
  const now = Date.now();
  const profiles = new Map([['swap-standard', { ...swapStandardProfile(), persisted: true }]]);
  const registry = [sanitizeProfile(swapStandardProfile(), { strict: false }).clean];
  const asset = makeMatchAsset({ profile_key: RICH_KEY, config: APPLY_CONFIG, to: APPLY_CONFIG }, RICH_SUMMARIES, registry);
  const t = makeEngineDeps({ asset, summaries: RICH_SUMMARIES, profiles, records: richBaselineRecords(now) });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    for (let i = 0; i < 5; i += 1) t.records.push(disp(now + 1000 + i * 1000, 'standard', 'failed'));
    t.engine.evaluateCanaries(now + 20000);
    const writesBefore = t.persistedCalls.length;
    const kept = await t.engine.rollback({ assetId: 'evo-down-a', humanConfirmed: true, action: 'keep' });
    assert.equal(kept.ok, true);
    assert.equal(kept.action, 'keep');
    assert.equal(kept.state, 'applied');
    const applied = t.assets.get('evo-down-a');
    assert.equal(applied.state, 'applied', 'keep → 资产 proposed→applied');
    assert.equal(applied.canary.verdict, 'regress', '金丝雀判定留痕不回改');
    assert.ok(Number.isFinite(applied.cooldown_until) && applied.cooldown_until > now, 'keep 落资产级冷却标记');
    assert.equal(t.store.profiles.has('evo-down-a'), true, 'keep 不写 profile（应用方案保留）');
    assert.equal(t.store.profiles.get('swap-standard').name, '标准编码', '既有方案不动');
    assert.equal(t.persistedCalls.length, writesBefore, 'keep 全程不写 profile');
    const keeps = t.audits.filter((a) => a.event === 'suggestion-keep');
    assert.equal(keeps.length, 1, '通过分支写 suggestion-keep 审计');
    assert.equal(keeps[0].human_confirmed, true);
    assert.equal(keeps[0].reason, 'user-kept');
    assert.equal(t.audits.filter((a) => a.event === 'suggestion-rollback').length, 0, 'keep 不写回滚审计');
    assert.equal(t.cooldowns.length, 1, 'keep 注入同键冷却');
    assert.ok(t.cooldowns[0].until >= now + 600000 - 5000);
    // 冷却内同方向建议被抑制（复用现有 cooldown 断言路径）。
    const down = [{ profileKey: RICH_KEY, suggestion: '降', confidence: 'medium', performanceText: 'x', cooldownUntil: now + 60000 }];
    const suppressed = await t.engine.generate({ advice: down, summaries: RICH_SUMMARIES });
    assert.equal(suppressed.skipped[0].reason, 'rollback-cooldown', 'keep 后同方向候选生成被抑制');
  } finally { t.teardown(); }
});

function recordsOf(t) {
  return t.records;
}

// --- 6m. 回滚建议提醒（仅 regress 一次；观察中/中止不提醒） ---------------------------

test('6m regress 判定 mint 回滚建议提醒一次；观察中不提醒', async () => {
  const now = Date.now();
  const records = baselineRecords(now);
  const asset = makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, SUMMARIES, []);
  const t = makeEngineDeps({ asset, summaries: SUMMARIES, records });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    for (let i = 0; i < 3; i += 1) records.push(disp(now + 1000 + i * 1000, 'code', 'failed'));
    t.engine.evaluateCanaries(now + 20000); // 观察中（k=3）：不提醒
    assert.equal(t.mints.length, 0, '观察中不 mint');
    for (let i = 3; i < 5; i += 1) records.push(disp(now + 1000 + i * 1000, 'code', 'failed'));
    t.engine.evaluateCanaries(now + 40000); // regress：提醒一次
    assert.equal(t.mints.length, 1, 'regress 判定 mint 一次');
    assert.equal(t.mints[0].id, 'evo-down-a');
    assert.equal(t.assets.get('evo-down-a').canary.rollback_reminder_sent, true);
    t.engine.evaluateCanaries(now + 60000); // 重复判定：不再 mint
    assert.equal(t.mints.length, 1, '只提醒一次');
  } finally { t.teardown(); }
});

// --- 6. 回滚保护（人工编辑后拒绝） --------------------------------------------------

test('6 回滚保护：profile 已被人工编辑 → 拒绝并提示手动恢复', async () => {
  const now = Date.now();
  const records = baselineRecords(now);
  const asset = makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, SUMMARIES, []);
  const t = makeEngineDeps({ asset, summaries: SUMMARIES, records });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    for (let i = 0; i < 5; i += 1) records.push(disp(now + 1000 + i * 1000, 'code', 'failed'));
    t.engine.evaluateCanaries(now + 20000);
    t.store.profiles.get('evo-down-a').preset = 'minimal'; // 人工编辑应用写入的方案
    const rejected = await t.engine.rollback({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /已被编辑/);
    assert.equal(t.audits.filter((a) => a.event === 'suggestion-rollback').length, 1, '拒绝分支留痕');
  } finally { t.teardown(); }
});

// --- 7. 冷启动 ----------------------------------------------------------------------

test('7 冷启动：minN<3 → apply/防退化禁用状态暴露；建议/候选不清除', () => {
  const sparse = { v: 1, l1: { 'preset:standard': { score: { weighted_success: 1 }, confidence: { n: 2, level: 'low' } } }, l2: {} };
  const status = evolutionStatusOf({ getApplyEnabled: () => true, summaries: sparse });
  assert.equal(status.applyEnabled, false);
  assert.equal(status.canaryEnabled, false);
  assert.ok(status.reasons.some((r) => r.includes('数据不足')), '原因清单暴露数据不足');
  const missing = evolutionStatusOf({ getApplyEnabled: () => true, summaries: null });
  assert.ok(missing.reasons.some((r) => r.includes('聚合数据缺失')));
  const t = makeEngineDeps({ summaries: sparse });
  t.assets.add(makeAsset('evo-keep-a', { profile_key: 'preset:standard' }));
  assert.equal(t.assets.list().length, 1, '既有候选不被清除');
  assert.equal(t.engine.evolutionStatus().applyEnabled, false);
  assert.equal(t.engine.evolutionStatus().canaryEnabled, false);
  t.teardown();
});

test('7b 冷启动：minN<3 时 apply 被拒（明确原因 + 审计）', async () => {
  const sparse = { v: 1, l1: { 'preset:standard': { score: { weighted_success: 1 }, confidence: { n: 2, level: 'low' } } }, l2: {} };
  const t = makeEngineDeps({ asset: makeMatchAsset({}, sparse, []), summaries: sparse });
  try {
    const result = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /数据不足/);
    assert.equal(t.audits.length, 1, '拒绝分支写审计');
  } finally { t.teardown(); }
});

// --- 8. 观察期联动 ------------------------------------------------------------------

test('8 观察期联动：同键 renewal/regenerate skip + 同键新候选不生成', async () => {
  const now = Date.now();
  const records = baselineRecords(now);
  const asset = makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, SUMMARIES, []);
  const t = makeEngineDeps({ asset, summaries: SUMMARIES, records });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    const advice = [{ profileKey: 'preset:standard', suggestion: '降', confidence: 'medium', performanceText: 'x', cooldownUntil: now + 60000 }];
    await t.engine.generate({ advice, summaries: SUMMARIES }); // 首轮被滞后闸抑制
    const gen = await t.engine.generate({ advice, summaries: SUMMARIES });
    assert.equal(gen.generated.length, 0);
    assert.equal(gen.skipped[0].reason, 'pending', '观察期同键新候选不生成');
    const regen = await t.engine.regenerate({ profileKey: 'preset:standard', advice, summaries: SUMMARIES });
    assert.equal(regen.expired.length, 0, '观察期不换代（不销毁观察资产）');
    assert.equal(regen.generated.length, 0);
    assert.equal(regen.skipped[0].reason, 'observation-period');
    assert.equal(t.assets.get('evo-down-a').state, 'proposed', '观察资产保持');
    assert.equal(t.audits.filter((a) => a.event === 'suggestion-refresh').length, 0, 'skip 不写 refresh 审计');
  } finally { t.teardown(); }
});

// --- 10. hold-out 契约位 -----------------------------------------------------------

test('3b 基线 unknown（apply 时刻聚合缺失）→ 判定降级不判（inconclusive + 提示）', async () => {
  const now = Date.now();
  const records = baselineRecords(now);
  const asset = makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, SUMMARIES, []);
  const t = makeEngineDeps({ asset, summaries: SUMMARIES, records });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    // 抹掉基线聚合（模拟 apply 时刻聚合缺失的残留场景），金丝雀必须降级不判。
    t.assets.transition('evo-down-a', 'proposed', { canary: { ...t.assets.get('evo-down-a').canary, baseline: { sampleN: null, weighted_success: null, scores: [] } }, baseline_metrics: { sampleN: null, weighted_success: null } });
    for (let i = 0; i < 5; i += 1) records.push(disp(now + 1000 + i * 1000, 'code', 'failed'));
    const result = t.engine.evaluateCanaries(now + 20000);
    assert.equal(result[0].verdict, 'inconclusive');
    const golden = t.audits.filter((a) => a.event === 'golden-canary');
    assert.equal(golden.length, 1);
    assert.match(golden[0].reason, /unknown/);
    assert.equal(t.assets.get('evo-down-a').state, 'proposed', '不判不丢资产');
  } finally { t.teardown(); }
});

test('10 hold-out stub：只读不落写 + 规则/验证时间隔离', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-holdout-test-'));
  try {
    const records = [];
    for (let i = 1; i <= 10; i += 1) records.push({ ts: i * 1000, effective: { preset: 'standard' }, outcome: { status: 'completed' } });
    const result = holdoutBacktest(records, { preset: 'standard' });
    assert.equal(result.readOnly, true);
    assert.equal(result.engine, 'stub');
    assert.equal(result.verdict, 'hold');
    assert.equal(result.candidateKey, 'preset:standard');
    assert.equal(result.boundary.trainingCount, 5, '按时间中位切分规则窗');
    assert.equal(result.boundary.holdoutCount, 5);
    const split = result.boundary.splitTs;
    assert.ok(records.every((r) => r.ts < split || r.ts >= split), '规则窗与验证窗时间隔离（无重叠）');
    assert.equal(readdirSync(dir).length, 0, '回放结果不落写');
    const source = readFileSync(new URL('../lib/core/evolution-canary.mjs', import.meta.url), 'utf8');
    assert.ok(!source.includes("from 'node:fs'"), 'hold-out 所在域无 fs 依赖（契约：纯函数零 IO）');
    const explicit = holdoutBacktest(records, null, { splitTs: 7000 });
    assert.equal(explicit.boundary.trainingCount, 6);
    assert.equal(explicit.boundary.holdoutCount, 4);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// --- 11. 观察期人工编辑中止 ---------------------------------------------------------

test('11 观察期人工编辑 → verdict=aborted-human-edit + 资产 invalid + 回滚拒绝', async () => {
  const now = Date.now();
  const profiles = new Map([['swap-standard', { ...swapStandardProfile(), persisted: true }]]);
  const registry = [sanitizeProfile(swapStandardProfile(), { strict: false }).clean];
  const asset = makeMatchAsset({ profile_key: RICH_KEY, config: APPLY_CONFIG, to: APPLY_CONFIG }, RICH_SUMMARIES, registry);
  const t = makeEngineDeps({ asset, summaries: RICH_SUMMARIES, profiles, records: richBaselineRecords(now) });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    profiles.get('swap-standard').name = '观察期被人工改过的名字';
    const result = t.engine.evaluateCanaries(now + 60000);
    assert.equal(result[0].verdict, 'aborted-human-edit');
    const applied = t.assets.get('evo-down-a');
    assert.equal(applied.invalid, true, '资产标 invalid');
    assert.equal(applied.canary.verdict, 'aborted-human-edit');
    const golden = t.audits.filter((a) => a.event === 'golden-canary');
    assert.equal(golden.length, 1);
    assert.equal(golden[0].verdict, 'aborted-human-edit');
    const rollback = await t.engine.rollback({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(rollback.ok, false);
    assert.match(rollback.reason, /中止|一键回滚/);
  } finally { t.teardown(); }
});

// --- 12. 回滚冷却有界（往返最多 1 次进冷却） ----------------------------------------

test('12 rolled_back → 同键 cooldown 内同方向建议抑制；冷却过期/不同方向解除', async () => {
  const now = Date.now();
  const records = baselineRecords(now);
  const asset = makeMatchAsset({ config: CODE_CONFIG, to: CODE_CONFIG }, SUMMARIES, []);
  const t = makeEngineDeps({ asset, summaries: SUMMARIES, records });
  try {
    await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    for (let i = 0; i < 5; i += 1) records.push(disp(now + 1000 + i * 1000, 'code', 'failed'));
    t.engine.evaluateCanaries(now + 20000);
    const ok = await t.engine.rollback({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(ok.ok, true);
    const down = [{ profileKey: 'preset:standard', suggestion: '降', confidence: 'medium', performanceText: 'x', cooldownUntil: now + 60000 }];
    const suppressed = await t.engine.generate({ advice: down, summaries: SUMMARIES });
    assert.equal(suppressed.skipped[0].reason, 'rollback-cooldown', '冷却期内同方向候选生成被抑制');
    t.assets.transition('evo-down-a', 'rolled_back', { rollback_at: now - 11 * 60 * 1000 });
    const released = await t.engine.generate({ advice: down, summaries: SUMMARIES });
    assert.equal(released.skipped[0].reason, 'lag-not-reached', '冷却过期后回滚抑制解除（进入正常滞后闸）');
    const up = [{ profileKey: 'preset:standard', suggestion: '升', confidence: 'medium', performanceText: 'x', cooldownUntil: now + 60000 }];
    const other = await t.engine.generate({ advice: up, summaries: SUMMARIES });
    assert.notEqual(other.skipped[0]?.reason, 'rollback-cooldown', '不同方向不受回滚冷却抑制');
  } finally { t.teardown(); }
});

// --- 路由集成：完整闭环（判定 → 回滚建议 → 人工确认回滚 → 持久化 + 审计） -----------

function baselineLines(now, effective = { preset: 'standard' }) {
  const lines = [];
  for (let i = 0; i < 4; i += 1) lines.push(JSON.stringify({ v: 1, ts: now - 100000 - i * 1000, child_id: 'b' + i, effective, outcome: { status: 'completed' } }));
  lines.push(JSON.stringify({ v: 1, ts: now - 100000 - 5000, child_id: 'bf', effective, outcome: { status: 'failed' } }));
  return lines;
}

function agentPresetsStub() {
  return {
    composedPreset: () => 'orchestrator-v2',
    list: async () => [{ id: 'standard', trust: 'system' }, { id: 'code', trust: 'system' }, { id: 'minimal', trust: 'system' }],
  };
}

// 预置进化域 fixture：state 开关 / 派发台账 / 聚合 / draft 候选资产。registry 是
// 应用时刻注册表匹配集的预期（调用方按 store 实际内容计算）。
function seedEvolutionFixture(iso, { l1Key, l1, registry, baselineEffective, now, assetConfig }) {
  writeFileSync(join(iso.dir, 'subagent-profiles.state.json'), JSON.stringify({ enabled: true, evolutionAdvice: false, escapeEnabled: false, applyEnabled: true }), 'utf8');
  const evoDir = join(iso.dir, 'subagent-evolution');
  mkdirSync(evoDir, { recursive: true });
  writeFileSync(join(evoDir, 'dispatch.jsonl'), baselineLines(now, baselineEffective).join('\n') + '\n', 'utf8');
  writeFileSync(join(evoDir, 'summaries.json'), JSON.stringify({ v: 1, l1, l2: {} }, null, 2), 'utf8'); // summaries 后写 → 不触发重算
  const fingerprint = profileFingerprint({ profileKey: l1Key, from: sourceConfigFromKey(l1Key, {}), registryEntries: registry });
  const assetDir = join(evoDir, 'assets');
  mkdirSync(assetDir, { recursive: true });
  const asset = {
    v: 1,
    id: 'evo-down-a',
    source: 'evolution',
    provenance: { generatedAt: 1, basis: {} },
    state: 'draft',
    version: 1,
    expiry: null,
    from: sourceConfigFromKey(l1Key, {}),
    to: assetConfig,
    axis: 'capability',
    direction: 'down',
    baseline_snapshot: {},
    profile_key: l1Key,
    profile_fingerprint: fingerprint,
    config: assetConfig,
    name: '进化草稿-preset:standard',
    description: '建议：降级能力配置',
    createdAt: 1,
    updatedAt: 1,
  };
  writeFileSync(join(assetDir, 'evo-down-a.json'), JSON.stringify(asset, null, 2), 'utf8');
  writeFileSync(join(assetDir, 'assets.index.json'), JSON.stringify({ v: 1, assets: [{ id: 'evo-down-a', source: 'evolution', profileKey: l1Key, state: 'draft', axis: 'capability', direction: 'down', expiry: null, createdAt: 1, updatedAt: 1 }] }), 'utf8');
  return evoDir;
}

test('5r 路由集成：regress → 回滚建议数据源 → 人工确认回滚 → 恢复 + 持久化 + rolled_back + 审计双分支', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const now = Date.now();
    const swap = { ...swapStandardProfile(), id: 'swap-custom', persisted: true };
    const registry = [sanitizeProfile(swap, { strict: false }).clean];
    const evoDir = seedEvolutionFixture(iso, {
      l1Key: RICH_KEY,
      l1: { [RICH_KEY]: { score: { weighted_success: 0.8 }, confidence: { n: 5, level: 'medium' }, cooldown: { until_ts: null } } },
      registry,
      baselineEffective: RICH_EFFECTIVE,
      now,
      assetConfig: APPLY_CONFIG,
    });
    const { webServer, routes } = makeRouteHarness();
    const { ctx, records } = createFakeCtx({ services: { webServer, agentPresets: agentPresetsStub(), llm: makeFakeLlm([]) } });
    await mod.apply(ctx);
    records.provides.find((p) => p.name === 'subagent-profiles')?.service.register(swap);
    const handler = routes[0].handler;
    const applied = await callRoute(handler, 'POST', '/evolution/apply', { assetId: 'evo-down-a', human_confirmed: true });
    assert.equal(applied.code, 200);
    assert.equal(applied.json.state, 'proposed');
    const extra = [];
    for (let i = 0; i < 5; i += 1) extra.push(JSON.stringify({ v: 1, ts: now + 1000 + i * 1000, child_id: 'p' + i, effective: { preset: 'standard' }, outcome: { status: 'failed' } }));
    appendFileSync(join(evoDir, 'dispatch.jsonl'), extra.join('\n') + '\n', 'utf8');
    const assetsRes = await callRoute(handler, 'GET', '/evolution/assets');
    assert.equal(assetsRes.code, 200);
    assert.equal(assetsRes.json.assets[0].canary.verdict, 'regress', '判定随只读列表触发');
    assert.equal(assetsRes.json.assets[0].canary.state, 'regress', '视图状态 regress');
    assert.equal(assetsRes.json.assets[0].canary.label, '观察期结束：上次的调整表现变差了', 'label 后端给中文（用户可见面零内部词）');
    assert.equal(assetsRes.json.assets[0].canary.post.weighted_success, 0, 'post 证据下发给建议区');
    assert.equal(assetsRes.json.assets[0].stateLabel, '待撤销', '候选行徽标 label');
    assert.ok(Array.isArray(assetsRes.json.assets[0].lifecycle) && assetsRes.json.assets[0].lifecycle.length >= 3, '进化轨迹 events 下发');
    assert.equal(assetsRes.json.assets[0].lifecycle[0].event, 'generated');
    assert.equal(assetsRes.json.rollbackSuggestions.length, 1, 'regress → 回滚建议数据源');
    const denied = await callRoute(handler, 'POST', '/evolution/rollback', { assetId: 'evo-down-a', human_confirmed: false });
    assert.equal(denied.code, 400);
    assert.match(denied.json.error, /人工确认/);
    const rollback = await callRoute(handler, 'POST', '/evolution/rollback', { assetId: 'evo-down-a', human_confirmed: true });
    assert.equal(rollback.code, 200);
    assert.equal(rollback.json.ok, true);
    assert.equal(rollback.json.state, 'rolled_back');
    assert.equal(rollback.json.persisted, true);
    assert.deepEqual(rollback.json.restored, ['swap-custom']);
    const persisted = JSON.parse(readFileSync(join(iso.dir, 'subagent-profiles.json'), 'utf8'));
    assert.ok(!persisted.profiles.some((p) => p.id === 'evo-down-a'), '应用方案被移除');
    const restored = persisted.profiles.find((p) => p.id === 'swap-custom');
    assert.equal(restored.persona, swap.persona, '完整配置恢复（persona）');
    assert.deepEqual(restored.toolFilter, swap.toolFilter, '完整配置恢复（toolFilter）');
    const auditText = readFileSync(join(evoDir, 'governance-audit.jsonl'), 'utf8');
    assert.match(auditText, /golden-canary/);
    assert.equal(auditText.split('\n').filter((l) => l.includes('"event":"suggestion-rollback"')).length, 2, '拒绝/通过双分支审计');
    const summariesAfter = JSON.parse(readFileSync(join(evoDir, 'summaries.json'), 'utf8'));
    assert.ok(summariesAfter.l1[RICH_KEY].cooldown.until_ts > now, '回滚注入同键冷却到建议侧');
    const afterRes = await callRoute(handler, 'GET', '/evolution/assets');
    assert.equal(afterRes.json.assets[0].stateLabel, '已撤销', '回滚后徽标转已撤销');
    assert.equal(afterRes.json.assets[0].canary.state, 'applied', '已撤销视图状态收敛');
    assert.equal(afterRes.json.assets[0].canary.label, '已撤销调整，观察期终止');
    assert.equal(afterRes.json.assets[0].lifecycle.filter((e) => e.event === 'resolved').length, 1, '轨迹含处理事件');
  } finally { iso.restore(); iso.teardown(); }
});

test('5k3 路由集成：action=keep → 200 applied + suggestion-keep 审计；非法 action → 400', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const now = Date.now();
    const swap = { ...swapStandardProfile(), id: 'swap-custom', persisted: true };
    const registry = [sanitizeProfile(swap, { strict: false }).clean];
    const evoDir = seedEvolutionFixture(iso, {
      l1Key: RICH_KEY,
      l1: { [RICH_KEY]: { score: { weighted_success: 0.8 }, confidence: { n: 5, level: 'medium' }, cooldown: { until_ts: null } } },
      registry,
      baselineEffective: RICH_EFFECTIVE,
      now,
      assetConfig: APPLY_CONFIG,
    });
    const { webServer, routes } = makeRouteHarness();
    const { ctx, records } = createFakeCtx({ services: { webServer, agentPresets: agentPresetsStub(), llm: makeFakeLlm([]) } });
    await mod.apply(ctx);
    records.provides.find((p) => p.name === 'subagent-profiles')?.service.register(swap);
    const handler = routes[0].handler;
    const applied = await callRoute(handler, 'POST', '/evolution/apply', { assetId: 'evo-down-a', human_confirmed: true });
    assert.equal(applied.code, 200);
    const extra = [];
    for (let i = 0; i < 5; i += 1) extra.push(JSON.stringify({ v: 1, ts: now + 1000 + i * 1000, child_id: 'pk' + i, effective: { preset: 'standard' }, outcome: { status: 'failed' } }));
    appendFileSync(join(evoDir, 'dispatch.jsonl'), extra.join('\n') + '\n', 'utf8');
    const assetsRes = await callRoute(handler, 'GET', '/evolution/assets');
    assert.equal(assetsRes.json.assets[0].canary.verdict, 'regress');
    const badAction = await callRoute(handler, 'POST', '/evolution/rollback', { assetId: 'evo-down-a', human_confirmed: true, action: 'ignore' });
    assert.equal(badAction.code, 400);
    assert.match(badAction.json.error, /action 无效/);
    const kept = await callRoute(handler, 'POST', '/evolution/rollback', { assetId: 'evo-down-a', human_confirmed: true, action: 'keep' });
    assert.equal(kept.code, 200);
    assert.equal(kept.json.ok, true);
    assert.equal(kept.json.state, 'applied');
    assert.equal(kept.json.persisted, undefined, 'keep 不涉及 profile 持久化信号');
    const persisted = JSON.parse(readFileSync(join(iso.dir, 'subagent-profiles.json'), 'utf8'));
    assert.ok(persisted.profiles.some((p) => p.id === 'evo-down-a'), 'keep 不写 profile（应用方案仍在）');
    const auditText = readFileSync(join(evoDir, 'governance-audit.jsonl'), 'utf8');
    assert.match(auditText, /suggestion-keep/);
    assert.equal(auditText.split('\n').filter((l) => l.includes('"event":"suggestion-rollback"')).length, 0, 'keep 不写回滚审计');
  } finally { iso.restore(); iso.teardown(); }
});

// --- 13. L3-4 per-call 契约 ---------------------------------------------------------

function makeForegroundParent() {
  const llm = makeFakeLlm();
  return {
    ctx: {
      get: (name) => (name === 'llm' ? llm : undefined),
      tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
    },
    options: {},
  };
}

test('13 L3-4：apply 后带 per-call 覆盖的派发不受 apply 影响（per-call > profile 默认值）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const now = Date.now();
    // 未写 profiles 文件 → 注册表 = 内置种子（swap-standard 匹配 preset:standard 键）。
    const seedRegistry = BUILTIN_SEEDS.map((s) => sanitizeProfile(s, { strict: false }).clean).filter((p) => configIdentityKey(p) === 'preset:standard');
    seedEvolutionFixture(iso, {
      l1Key: 'preset:standard',
      l1: { 'preset:standard': { score: { weighted_success: 0.8 }, confidence: { n: 5, level: 'medium' }, cooldown: { until_ts: null } } },
      registry: seedRegistry,
      baselineEffective: { preset: 'standard' },
      now,
      assetConfig: { id: 'evo-down-a', preset: 'code', model: 'm1' },
    });
    const subagentsStart = async () => ({ result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }, dispose: async () => {} });
    const { webServer, routes } = makeRouteHarness();
    const { ctx, records } = createFakeCtx({ services: { webServer, agentPresets: agentPresetsStub(), llm: makeFakeLlm([{ id: 'm1' }, { id: 'm2' }]) }, subagentsStart });
    await mod.apply(ctx);
    const handler = routes[0].handler;
    const applied = await callRoute(handler, 'POST', '/evolution/apply', { assetId: 'evo-down-a', human_confirmed: true });
    assert.equal(applied.code, 200);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task', profile: 'evo-down-a', model: 'm2' }, { agent: makeForegroundParent(), signal: undefined });
    assert.equal(out.decisionTrace.effective.model, 'm2', 'per-call 覆盖优先于应用后的 profile 默认值');
    const persisted = JSON.parse(readFileSync(join(iso.dir, 'subagent-profiles.json'), 'utf8'));
    const profile = persisted.profiles.find((p) => p.id === 'evo-down-a');
    assert.equal(profile.model, 'm1', 'apply 写入的默认值不被 per-call 覆盖反写');
  } finally { iso.restore(); iso.teardown(); }
});
