// test/evolution-engine.test.mjs — 进化 apply 引擎单测 + 路由集成。
// 引擎单测：构造 fake deps（store/catalog/evoLedger/assets）直驱 createEvolutionEngine，
// 覆盖三道闸逐项拒绝、审计（通过/拒绝两分支）、人工确认、指纹过期（编辑方案/聚合
// 变化）、观察期隔离、同资产并发只生效一次、apply 开关门、生成幂等与总量护栏。
// 路由集成：index.mjs apply() + fake ctx/llm/presets，经 GET /list 触发生成、
// GET /evolution/assets 列表、POST /evolution/apply 应用 → profiles 落盘 + 审计。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEvolutionAssets } from '../lib/core/evolution-assets.mjs';
import { createEvolutionEngine } from '../lib/core/evolution-engine.mjs';
import { profileFingerprint, sourceConfigFromKey } from '../lib/core/evolution-draft.mjs';
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

function makeCatalog({ models = [], tools = [{ name: 'bash' }, { name: 'read' }], presets = [] } = {}) {
  return { getSnapshot: async () => ({ models, tools, presets, efforts: {}, llm: { providersError: undefined, providers: [{ id: 'p1' }], modelsByProvider: { p1: { ok: true, models } } } }) };
}

const SUMMARIES = {
  v: 1,
  l1: { 'preset:standard': { score: { weighted_success: 0.3 }, confidence: { n: 3, level: 'medium' }, cooldown: { until_ts: null } } },
  l2: {},
};

function makeEngineDeps({ asset, summaries = SUMMARIES, applyEnabled = true, adviceEnabled = true, models = [], tools, profiles, presets = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evo-engine-test-'));
  const logs = [];
  const audits = [];
  const store = {
    profiles: profiles ?? new Map(),
    persistProfiles: () => ({ persisted: true }),
    getAllowFailOpen: () => false,
  };
  const assets = createEvolutionAssets({ dshHome: dir, logger: { warn: (...a) => logs.push(a.join(' ')) }, onGovernanceFailure: () => {} });
  if (asset !== undefined) assets.add(asset);
  const evoLedger = { recordGovernanceAudit: (entry) => audits.push(entry) };
  const engine = createEvolutionEngine({
    store,
    catalog: makeCatalog({ models, tools, presets }),
    assets,
    evoLedger,
    whitelist: new Set(['standard', 'code']),
    logger: { warn: (...a) => logs.push(a.join(' ')) },
    getApplyEnabled: () => applyEnabled,
    getAdviceEnabled: () => adviceEnabled,
    getAllowFailOpen: () => false,
    getLlm: () => makeFakeLlm(models.length > 0 ? models : [{ id: 'm1' }]),
    getSummaries: () => summaries,
    pluginVersion: '0.0.0-test',
  });
  return { dir, assets, store, audits, logs, engine, teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
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
    baseline_snapshot: { from: { preset: 'standard' }, score: 0.3, n: 3, confidence: 'medium' },
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

// 指纹与引擎重算同口径（注册表为空 → registryEntries=[]）的匹配资产。
function makeMatchAsset(overrides = {}, summaries = SUMMARIES) {
  const key = overrides.profile_key ?? 'preset:standard';
  const from = overrides.from ?? sourceConfigFromKey(key, summaries.l2 ?? {});
  const fingerprint = profileFingerprint({ profileKey: key, from, registryEntries: [] });
  return makeAsset({ profile_key: key, from, profile_fingerprint: fingerprint, ...overrides });
}

// --- 全过 -------------------------------------------------------------------------

test('apply 全过：三道闸 pass + 审批 never → 落写新 profile + 持久化 + proposed + 审计', async () => {
  const t = makeEngineDeps({ asset: makeMatchAsset() });
  try {
    const result = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.equal(result.state, 'proposed');
    assert.ok(t.store.profiles.has('evo-down-a'), '新方案写入注册表');
    assert.equal(t.assets.get('evo-down-a').state, 'proposed');
    assert.equal(t.audits.length, 1);
    const entry = t.audits[0];
    assert.equal(entry.event, 'suggestion-apply');
    assert.equal(entry.profile_id, 'evo-down-a');
    assert.equal(entry.human_confirmed, true);
    assert.equal(entry.gates.whitelist.verdict, 'pass');
    assert.equal(entry.gates.cost.verdict, 'pass');
    assert.equal(entry.gates.intersection.verdict, 'pass');
    assert.equal(entry.gates.approval, 'never');
  } finally { t.teardown(); }
});

// --- 闸逐项失败 --------------------------------------------------------------------

test('whitelist 闸失败 → 拒绝写 + 审计（含失败 verdict），profile 不落', async () => {
  const asset = makeMatchAsset({ config: { id: 'evo-down-a', preset: 'evil' }, to: { id: 'evo-down-a', preset: 'evil' } });
  const t = makeEngineDeps({ asset });
  try {
    const result = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /system-trust 白名单/);
    assert.ok(!t.store.profiles.has('evo-down-a'));
    assert.equal(t.audits.length, 1);
    assert.equal(t.audits[0].gates.whitelist.verdict, 'fail');
    assert.equal(t.audits[0].gates.cost.verdict, 'skipped');
    assert.equal(t.audits[0].gates.intersection.verdict, 'skipped');
    assert.equal(t.audits[0].event, 'suggestion-apply');
  } finally { t.teardown(); }
});

test('cost 闸失败（模型不在目录）→ 拒绝写 + 审计 cost 失败 verdict', async () => {
  const config = { id: 'evo-down-a', provider: 'p1', model: 'missing' };
  const asset = makeMatchAsset({ config, to: config });
  const t = makeEngineDeps({ asset, models: [{ id: 'm1' }, { id: 'm2' }] });
  try {
    const result = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /目录/);
    assert.equal(t.audits.length, 1);
    assert.equal(t.audits[0].gates.cost.verdict, 'fail');
    assert.ok(!t.store.profiles.has('evo-down-a'));
  } finally { t.teardown(); }
});

test('intersection 闸失败（allow 含未知工具 / 收窄后为空）→ 拒绝写', async () => {
  const unknownConfig = { id: 'evo-down-a', toolFilter: { allow: ['missing-tool'] } };
  const t1 = makeEngineDeps({ asset: makeMatchAsset({ config: unknownConfig, to: unknownConfig }) });
  try {
    const result = await t1.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /未知工具/);
    assert.equal(t1.audits[0].gates.intersection.verdict, 'fail');
  } finally { t1.teardown(); }
  const emptyConfig = { id: 'evo-down-a', toolFilter: { deny: ['bash', 'read'] } };
  const t2 = makeEngineDeps({ asset: makeMatchAsset({ config: emptyConfig, to: emptyConfig }) });
  try {
    const result = await t2.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /工具交集为空/);
  } finally { t2.teardown(); }
});

// --- 人工确认 / 指纹 / 观察期 ------------------------------------------------------

test('human_confirmed=false → 拒绝（升/降一律需人工确认）', async () => {
  const t = makeEngineDeps({ asset: makeMatchAsset() });
  try {
    const result = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /人工确认/);
    assert.ok(!t.store.profiles.has('evo-down-a'));
    assert.equal(t.audits.length, 1);
    assert.equal(t.audits[0].human_confirmed, false);
    assert.equal(t.audits[0].gates.whitelist.verdict, 'skipped');
  } finally { t.teardown(); }
});

test('指纹过期（人工编辑匹配 profile 后）→ 应用被拒且资产置 expired', async () => {
  const profiles = new Map();
  const t = makeEngineDeps({ asset: makeMatchAsset(), profiles });
  try {
    // 生成时刻注册表为空；生成后人工编辑出一个匹配该身份键的方案 → 指纹失配。
    profiles.set('swap-standard', { id: 'swap-standard', preset: 'standard', tokenTier: 'balanced' });
    const result = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /指纹失配/);
    assert.equal(t.assets.get('evo-down-a').state, 'expired');
    assert.equal(t.audits.length, 1);
  } finally { t.teardown(); }
});

test('观察期内同身份键二次 apply（不同资产）→ 被拒', async () => {
  const t = makeEngineDeps({ asset: makeMatchAsset() });
  try {
    const first = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(first.ok, true);
    const secondAsset = makeMatchAsset({ id: 'evo-down-b', config: { id: 'evo-down-b', preset: 'code' }, to: { id: 'evo-down-b', preset: 'code' } });
    t.assets.add(secondAsset);
    const second = await t.engine.apply({ assetId: 'evo-down-b', humanConfirmed: true });
    assert.equal(second.ok, false);
    assert.match(second.reason, /观察期/);
    assert.equal(t.assets.get('evo-down-b').state, 'draft', '观察期拒绝不销毁候选');
  } finally { t.teardown(); }
});

test('同资产并发 apply 只生效一次（串行化）', async () => {
  const t = makeEngineDeps({ asset: makeMatchAsset() });
  try {
    const [a, b] = await Promise.all([
      t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true }),
      t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    assert.equal(okCount, 1, '并发 apply 只生效一次');
    const rejected = [a, b].find((r) => !r.ok);
    assert.match(rejected.reason, /已处置/);
    assert.equal(t.store.profiles.has('evo-down-a'), true);
    assert.equal(t.audits.length, 2, '两次尝试都留痕');
  } finally { t.teardown(); }
});

// --- 开关 / 生成 --------------------------------------------------------------------

test('门控解耦：apply 开关关（默认）→ 建议链开仍生成候选；apply 仍被拒', async () => {
  const t = makeEngineDeps({ applyEnabled: false, adviceEnabled: true, presets: [{ id: 'standard' }, { id: 'code' }] });
  try {
    const advice = [{ profileKey: 'preset:code', suggestion: '降', confidence: 'medium', performanceText: '过去 3 次：完成 1、失败 2', cooldownUntil: Date.now() + 60000 }];
    const generated = await t.engine.generate({ advice, summaries: SUMMARIES });
    assert.equal(generated.generated.length, 1, 'apply 开关关不影响候选生成（生成随建议链）');
    assert.equal(t.assets.get(generated.generated[0]).state, 'draft');
    const applied = await t.engine.apply({ assetId: 'evo-down-a', humanConfirmed: true });
    assert.equal(applied.ok, false, '应用写路径保持 apply 开关硬线');
    assert.match(applied.reason, /开关/);
  } finally { t.teardown(); }
});

test('门控解耦：建议链关 → 不生成候选（apply 开关开也不生成）', async () => {
  const t = makeEngineDeps({ applyEnabled: true, adviceEnabled: false, presets: [{ id: 'standard' }, { id: 'code' }] });
  try {
    const advice = [{ profileKey: 'preset:code', suggestion: '降', confidence: 'medium', performanceText: '过去 3 次：完成 1、失败 2', cooldownUntil: Date.now() + 60000 }];
    const generated = await t.engine.generate({ advice, summaries: SUMMARIES });
    assert.equal(generated.reason, 'advice-disabled');
    assert.deepEqual(generated.generated, []);
  } finally { t.teardown(); }
});

test('生成：建议 → 资产落盘；同身份键幂等跳过；总量 ≥20 跳过并 warn', async () => {
  const t = makeEngineDeps({ models: [] });
  try {
    const advice = [{ profileKey: 'preset:code', suggestion: '降', confidence: 'medium', performanceText: '过去 3 次：完成 1、失败 2', cooldownUntil: Date.now() + 60000 }];
    const catalogWithPresets = { getSnapshot: async () => ({ models: [], tools: [], presets: [{ id: 'standard' }, { id: 'code' }], efforts: {}, llm: { providers: [] } }) };
    // 换一个带预设名册的 catalog（预设降档需要名册）。
    const engine2 = createEvolutionEngine({
      store: t.store,
      catalog: catalogWithPresets,
      assets: t.assets,
      evoLedger: { recordGovernanceAudit: () => {} },
      whitelist: new Set(['standard', 'code']),
      logger: { warn: () => {} },
      getApplyEnabled: () => true,
      getAdviceEnabled: () => true,
      getAllowFailOpen: () => false,
      getLlm: () => makeFakeLlm([]),
      getSummaries: () => SUMMARIES,
      pluginVersion: '0.0.0-test',
    });
    const first = await engine2.generate({ advice, summaries: SUMMARIES });
    assert.equal(first.generated.length, 1, '首轮生成一条');
    assert.equal(t.assets.get(first.generated[0]).state, 'draft');
    const second = await engine2.generate({ advice, summaries: SUMMARIES });
    assert.equal(second.generated.length, 0, '同身份键未处置 → 跳过');
    assert.equal(second.skipped[0].reason, 'pending');
    for (let i = 0; i < 20; i += 1) {
      const extra = makeAsset({ id: 'evo-fill-' + i, profile_key: 'preset:fill-' + i, config: { id: 'evo-fill-' + i } });
      t.assets.add(extra);
    }
    const capped = await engine2.generate({ advice, summaries: SUMMARIES });
    assert.equal(capped.generated.length, 0, '总量护栏跳过生成');
  } finally { t.teardown(); }
});

// --- 路由集成（index.mjs apply + fake ctx/llm）------------------------------------

function underperformingEntry() {
  return {
    deployments_total: 3,
    outcome: { completed: 1, failed: 2, killed: 0 },
    score: { weighted_success: 0.333, win_rate: 0.333 },
    perf: { avg_elapsed_ms: 150, avg_output_len: 500, avg_tool_count: 2 },
    confidence: { n: 3, min_n_required: 3, level: 'medium' },
    cooldown: { until_ts: null, last_apply_ts: null },
    axes: { capability: true, budget: false },
  };
}

function writeSummariesFixture(dir, l1) {
  const evoDir = join(dir, 'subagent-evolution');
  mkdirSync(evoDir, { recursive: true });
  writeFileSync(join(evoDir, 'summaries.json'), JSON.stringify({ v: 1, l1, l2: {} }, null, 2), 'utf8');
}

function agentPresetsStub() {
  return {
    composedPreset: () => 'orchestrator',
    list: async () => [{ id: 'standard', trust: 'system' }, { id: 'code', trust: 'system' }, { id: 'minimal', trust: 'system' }],
  };
}

async function setupApp({ applyEnabled, evolutionAdvice = false }) {
  const iso = makeIsolatedDshHome();
  writeFileSync(join(iso.dir, 'subagent-profiles.state.json'), JSON.stringify({ enabled: true, evolutionAdvice: evolutionAdvice === true, escapeEnabled: false, applyEnabled: applyEnabled === true }), 'utf8');
  writeSummariesFixture(iso.dir, { 'preset:code': underperformingEntry() });
  const { webServer, routes } = makeRouteHarness();
  const { ctx } = createFakeCtx({ services: { webServer, agentPresets: agentPresetsStub(), llm: makeFakeLlm([]) } });
  await mod.apply(ctx);
  return { iso, routes, handler: routes[0].handler }
}

test('路由集成：/list 生成候选 → /evolution/assets 可见 → /evolution/apply 应用落盘 + 审计', async () => {
  const app = await setupApp({ applyEnabled: true, evolutionAdvice: true });
  try {
    const list = await callRoute(app.handler, 'GET', '/list');
    assert.equal(list.code, 200);
    assert.equal(list.json.advice.length, 1, '/list 返回建议');
    const assetsRes = await callRoute(app.handler, 'GET', '/evolution/assets');
    assert.equal(assetsRes.code, 200);
    assert.equal(assetsRes.json.assets.length, 1, '候选资产已生成');
    const assetId = assetsRes.json.assets[0].id;
    assert.equal(assetsRes.json.assets[0].state, 'draft');
    const applied = await callRoute(app.handler, 'POST', '/evolution/apply', { assetId, human_confirmed: true });
    assert.equal(applied.code, 200);
    assert.equal(applied.json.ok, true);
    assert.equal(applied.json.persisted, true);
    assert.equal(applied.json.state, 'proposed');
    const profilesFile = join(app.iso.dir, 'subagent-profiles.json');
    const persisted = JSON.parse(readFileSync(profilesFile, 'utf8'));
    assert.ok(persisted.profiles.some((p) => p.id === assetId), '新方案已持久化到 profiles 文件');
    const auditFile = join(app.iso.dir, 'subagent-evolution', 'governance-audit.jsonl');
    const auditText = readFileSync(auditFile, 'utf8');
    assert.match(auditText, /suggestion-apply/);
    const auditLine = JSON.parse(auditText.trim().split('\n').pop());
    assert.equal(auditLine.event, 'suggestion-apply');
    assert.equal(auditLine.human_confirmed, true);
    assert.equal(auditLine.gates.approval, 'never');
  } finally { app.iso.restore(); app.iso.teardown(); }
});

test('路由集成：apply 开关关 → 建议链开时 /list 生成候选可见；/evolution/apply 仍被拒（解耦）', async () => {
  const app = await setupApp({ applyEnabled: false, evolutionAdvice: true });
  try {
    const list = await callRoute(app.handler, 'GET', '/list');
    assert.equal(list.code, 200);
    assert.equal(list.json.advice.length, 1, '/list 返回建议');
    assert.equal(list.json.evolutionCandidates.length, 1, '候选随建议链生成并随 /list 可见');
    assert.equal(list.json.evolutionCandidates[0].state, 'draft');
    const assetsRes = await callRoute(app.handler, 'GET', '/evolution/assets');
    assert.equal(assetsRes.json.assets.length, 1, '候选资产已生成');
    const applied = await callRoute(app.handler, 'POST', '/evolution/apply', { assetId: list.json.evolutionCandidates[0].id, human_confirmed: true });
    assert.equal(applied.code, 400);
    assert.match(applied.json.error, /开关/);
  } finally { app.iso.restore(); app.iso.teardown(); }
});

test('路由集成：建议链关 → /list 有建议但无候选资产（面板与生成同生共死）', async () => {
  const app = await setupApp({ applyEnabled: true, evolutionAdvice: false });
  try {
    const list = await callRoute(app.handler, 'GET', '/list');
    assert.equal(list.code, 200);
    assert.equal(list.json.advice.length, 1, '建议仍返回（设置面板只读展示）');
    assert.equal(list.json.evolutionCandidates.length, 0, '建议链关不生成候选');
    const assetsRes = await callRoute(app.handler, 'GET', '/evolution/assets');
    assert.equal(assetsRes.json.assets.length, 0, '无候选资产');
  } finally { app.iso.restore(); app.iso.teardown(); }
});
