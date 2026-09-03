// test/token-tier.test.mjs — tokenTier 成本分层 + childTotalTokens 成本证据链。
// 覆盖：
//   * sanitizeProfile 的 tokenTier 白名单 / 缺省 balanced / 非法剔除 + warn。
//   * TIER_ORDER / tierSortKey 纯函数与 dispatch:profiles 目录行序
//     （cheap→balanced→premium，缺省按 balanced）。
//   * childTotalTokens：mock tokenMeter 时前台（execute）/后台（settleStart）
//     completed 结算写入 meta 且仅 completed 测量；tokenMeter 缺失省略字段
//     （fail-soft，估算口径非计费）。
//   * R1 三分支 output schema 同步携带 childTotalTokens + tokenTier。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeProfile,
  TIER_ORDER,
  tierSortKey,
  assertResultSchemaConsistency,
} from '../lib/core/pure.mjs';
import { settleStart } from '../lib/core/delegation.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// ---- sanitizeProfile：tokenTier 白名单 / 缺省 / 非法剔除 ----------------------

test('sanitizeProfile: tokenTier 白名单（cheap/balanced/premium 透传）', () => {
  for (const tier of ['cheap', 'balanced', 'premium']) {
    const { clean, warnings } = sanitizeProfile({ id: 'x', tokenTier: tier });
    assert.equal(clean.tokenTier, tier);
    assert.equal(warnings.length, 0);
  }
});

test('sanitizeProfile: tokenTier 缺省 → balanced', () => {
  const { clean, warnings } = sanitizeProfile({ id: 'x' });
  assert.equal(clean.tokenTier, 'balanced');
  assert.equal(warnings.length, 0);
});

test('sanitizeProfile: tokenTier 非法值 → 剔除 + warn（不回填缺省）', () => {
  const { clean, warnings } = sanitizeProfile({ id: 'x', tokenTier: 'expensive' });
  assert.equal(clean.tokenTier, undefined, '非法值必须剔除，而非回填 balanced');
  assert.ok(warnings.some((w) => w.field === 'tokenTier' && /cheap\/balanced\/premium/.test(w.reason)));
});

// ---- TIER_ORDER / tierSortKey --------------------------------------------------

test('TIER_ORDER / tierSortKey: cheap→balanced→premium 权重，未知 tier 按 balanced', () => {
  assert.deepEqual(TIER_ORDER, { cheap: 0, balanced: 1, premium: 2 });
  assert.equal(tierSortKey('cheap'), 0);
  assert.equal(tierSortKey('balanced'), 1);
  assert.equal(tierSortKey('premium'), 2);
  assert.equal(tierSortKey('unknown'), 1);
  assert.equal(tierSortKey(undefined), 1);
});

// ---- dispatch:profiles 目录行序 -------------------------------------------------

test('dispatch:profiles 目录行按 tier cheap→balanced→premium 排序', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ services: { agentPresets: { composedPreset: () => 'orchestrator-v2' } } });
    await mod.apply(ctx);
    // 注册一个 premium profile 覆盖三分档排序（register 不经 sanitize，原样入 store）。
    const service = records.provides.find((p) => p.name === 'subagent-profiles')?.service;
    service.register({ id: 'premium-x', name: 'Premium', description: '高成本', tokenTier: 'premium' });
    const profiles = records.sectionCalls.find((s) => s.name === 'dispatch:profiles');
    const text = profiles.text({ agent: {} });
    const idxCheap = text.indexOf('researcher:');
    const idxBalanced = text.indexOf('swap-standard:');
    const idxPremium = text.indexOf('premium-x:');
    assert.ok(idxCheap >= 0 && idxBalanced >= 0 && idxPremium >= 0, '三分档 profile 都应在目录中');
    assert.ok(idxCheap < idxBalanced, 'cheap 应在 balanced 之前');
    assert.ok(idxBalanced < idxPremium, 'balanced 应在 premium 之前');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- childTotalTokens：前台结算测量 ---------------------------------------------

function makeForegroundParent() {
  return { ctx: { get: () => undefined }, options: {} };
}

test('foreground completed + tokenMeter → meta.childTotalTokens 来自 measure', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const measureCalls = [];
    const meter = {
      measure(session) {
        measureCalls.push(session);
        return { totalTokens: 1534 };
      },
    };
    const childSession = { id: 'child-session' };
    const subagentsStart = async () => ({
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: childSession },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ services: { tokenMeter: meter }, subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    assert.equal(out.childTotalTokens, 1534);
    assert.equal(measureCalls.length, 1, 'completed 必须测量一次');
    assert.equal(measureCalls[0], childSession, 'measure 必须收到子 session');
    assert.equal(out.tokenTier, 'balanced', '缺省 tokenTier=balanced');
  } finally { iso.restore(); iso.teardown(); }
});

test('foreground 非 completed → 不测量（无 childTotalTokens）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const measureCalls = [];
    const meter = { measure() { measureCalls.push(1); return { totalTokens: 99 }; } };
    const subagentsStart = async () => ({
      result: { stopReason: 'max-tokens', output: [{ type: 'text', text: 'partial' }] },
      localAgent: { session: { id: 'child-session' } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ services: { tokenMeter: meter }, subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    await assert.rejects(
      () => tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined }),
      /token limit/
    );
    assert.equal(measureCalls.length, 0, '非 completed 不得测量');
  } finally { iso.restore(); iso.teardown(); }
});

test('foreground completed + tokenMeter 缺失 → 省略 childTotalTokens（fail-soft）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: { id: 'child-session' } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart }); // services 无 tokenMeter
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    assert.equal(out.childTotalTokens, undefined, 'tokenMeter 缺失必须省略字段');
    assert.equal(out.tokenTier, 'balanced');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- childTotalTokens：后台结算（settleStart）测量 -------------------------------

test('settleStart completed + measure → 结果含 childTotalTokens（后台路径）', async () => {
  const measureCalls = [];
  const measure = (session) => { measureCalls.push(session); return 777; };
  const childSession = { id: 'bg-session' };
  const start = async () => ({
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] },
    localAgent: { session: childSession },
    dispose: async () => {},
  });
  const out = await settleStart(start(), { aborted: false }, { profile: 'x' }, (blocks) => blocks, measure);
  assert.equal(out.status, 'completed');
  assert.equal(out.childTotalTokens, 777);
  assert.equal(measureCalls.length, 1);
  assert.equal(measureCalls[0], childSession);
});

test('settleStart 非 completed → 不测量（后台路径）', async () => {
  const measureCalls = [];
  const measure = () => { measureCalls.push(1); return 99; };
  const start = async () => ({
    result: { stopReason: 'aborted', output: [{ type: 'text', text: 'partial' }] },
    localAgent: { session: { id: 'bg-session' } },
    dispose: async () => {},
  });
  const out = await settleStart(start(), { aborted: false }, { profile: 'x' }, (blocks) => blocks, measure);
  assert.equal(out.status, 'killed');
  assert.equal(out.childTotalTokens, undefined);
  assert.equal(measureCalls.length, 0);
});

// ---- 参数 schema + R1 三分支 schema + render 行 ---------------------------------

test('dispatch 参数 schema：tokenTier 为 enum（cheap/balanced/premium）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const p = tool.parameters.properties.tokenTier;
    assert.equal(p.type, 'string');
    assert.deepEqual(p.enum, ['cheap', 'balanced', 'premium']);
  } finally { iso.restore(); iso.teardown(); }
});

test('R1 schema：三分支同步携带 childTotalTokens + tokenTier', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    assert.doesNotThrow(() => assertResultSchemaConsistency(tool.output.schema));
    for (const branch of tool.output.schema.oneOf) {
      assert.equal(branch.properties.childTotalTokens.type, 'number', '每分支必须有 childTotalTokens(number)');
      assert.equal(branch.properties.tokenTier.type, 'string', '每分支必须有 tokenTier(string)');
      assert.deepEqual(branch.properties.tokenTier.enum, ['cheap', 'balanced', 'premium']);
    }
  } finally { iso.restore(); iso.teardown(); }
});

test('render 行：包含 tokenTier 与 childTotalTokens（供 client 解析回显）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const value = {
      kind: 'foreground',
      output: 'x',
      profile: 'p',
      preset: 'inherit',
      provider: 'pr',
      model: 'm',
      reasoningEffort: 'off',
      tokenTier: 'cheap',
      childTotalTokens: 42,
      ignored: [],
    };
    const [block] = tool.output.render({}, value);
    assert.match(block.text, /tokenTier=cheap/);
    assert.match(block.text, /childTotalTokens=42/);
  } finally { iso.restore(); iso.teardown(); }
});
