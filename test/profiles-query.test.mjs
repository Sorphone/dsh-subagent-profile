// test/profiles-query.test.mjs — profiles_query 工具：
//   入参全可选（id / tier / provider+model 成对 / 无参全量）；未知键由宿主 DSL
//   默认拒绝——键集闭合以白名单 4 键锁定（与 percall-spec 同口径）；provider/model
//   只传其一在 execute 内 fail-loud（成对约束）。efforts 条件式（绑定 → 官方档位；
//   未绑定 → 继承父）；未在册只标不判失效；「未授权」联动官方模型选择投影。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILES_QUERY_PARAMETERS,
  catalogStatusOf,
  unauthorizedMarkOf,
  effortsTextOf,
  profileDetailLines,
  buildProfilesQueryText,
} from '../lib/core/profiles-query.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// 目录快照口径：dp/flash 与 dp/v4 在册；not-listed 不在册。
const MODELS = [
  { provider: 'dp', id: 'flash' },
  { provider: 'dp', id: 'v4' },
];
const EFFORTS = { flash: [{ id: 'off' }, { id: 'high' }] };

function makeLlm() {
  return {
    listProviders: async () => [{ id: 'dp' }],
    listModels: async () => [{ id: 'flash' }, { id: 'v4' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
    resolveCallConfig: async () => ({}),
  };
}

function makeQueryAgent({ services = {} } = {}) {
  const llm = makeLlm();
  const projections = { stateOf: () => [{ provider: 'dp', model: 'flash' }] };
  const all = { llm, sessionProjections: projections, ...services };
  return {
    ctx: { get: (name) => all[name] },
    session: { header: { id: 'q1' } },
    options: {},
  };
}

// 注册测试档案：qa（绑定 flash，cheap）/ code（preset 绑定，balanced）/
// ghost（绑定不在册模型，cheap）/ longdesc（超 80 字符描述，绑定 v4，premium）。
function registerFixtures(records) {
  const service = records.provides.find((p) => p.name === 'subagent-profiles')?.service;
  service.register({ id: 'qa', name: 'QA', description: '查资料与汇总的测试场景方案', provider: 'dp', model: 'flash', tokenTier: 'cheap' });
  service.register({ id: 'code', name: 'Code', description: '写代码与多文件重构场景方案', preset: 'standard', tokenTier: 'balanced' });
  service.register({ id: 'ghost', name: 'Ghost', description: '测试场景但模型不在册', provider: 'dp', model: 'not-listed', tokenTier: 'cheap' });
  service.register({ id: 'longdesc', name: 'Long', description: '这是一个用于验证列表口径截断的长描述方案说明文字。'.repeat(4), provider: 'dp', model: 'v4', tokenTier: 'premium' });
}

function queryToolOf(records) {
  const tool = records.registerToolCalls.find((t) => t.name === 'profiles_query');
  assert.ok(tool, 'profiles_query tool must be registered');
  return tool;
}

async function setupApp() {
  const iso = makeIsolatedDshHome();
  const { ctx, records } = createFakeCtx();
  await mod.apply(ctx);
  registerFixtures(records);
  return { iso, ctx, records };
}

// ---- 入参 schema：键集闭合（未知键无接受路径） -------------------------------

test('参数 schema：键集恰为白名单 4 键（id/tier/provider/model，全可选）', () => {
  const keys = Object.keys(PROFILES_QUERY_PARAMETERS);
  assert.deepEqual([...keys].sort(), ['id', 'model', 'provider', 'tier'], '键集必须与白名单齐全');
});

// ---- 纯函数：状态标注 / efforts 两态 / 明细行统计 ----------------------------

test('catalogStatusOf：在册 / 未在册 / 未绑定 三态（未在册只标不判失效）', () => {
  assert.equal(catalogStatusOf({ provider: 'dp', model: 'flash' }, MODELS), '在册');
  assert.equal(catalogStatusOf({ provider: 'dp', model: 'not-listed' }, MODELS), '未在册');
  assert.equal(catalogStatusOf({ preset: 'standard' }, MODELS), '未绑定');
  assert.equal(catalogStatusOf({ model: 'flash' }, MODELS), '未绑定', '缺 provider 视为未绑定');
});

test('unauthorizedMarkOf：投影配置 + 绑定路由不在允许集 → 未授权；未配置/未绑定 → 不标注', () => {
  const policy = { configured: true, enabled: true, allowedModels: [{ provider: 'dp', model: 'flash' }] };
  assert.equal(unauthorizedMarkOf({ provider: 'dp', model: 'v4' }, policy), '未授权');
  assert.equal(unauthorizedMarkOf({ provider: 'dp', model: 'flash' }, policy), undefined);
  assert.equal(unauthorizedMarkOf({ preset: 'standard' }, policy), undefined, '未绑定不评估授权');
  assert.equal(unauthorizedMarkOf({ provider: 'dp', model: 'v4' }, { configured: false, allowedModels: [] }), undefined);
});

test('effortsTextOf：绑定 → 官方档位；目录无数据 → 占位；未绑定 → 继承父', () => {
  assert.equal(effortsTextOf({ provider: 'dp', model: 'flash' }, EFFORTS), 'off/high');
  assert.equal(effortsTextOf({ provider: 'dp', model: 'not-listed' }, EFFORTS), '（目录无该模型明细）');
  assert.equal(effortsTextOf({ preset: 'standard' }, EFFORTS), '继承父模型，档位以父为准');
});

test('profileDetailLines：主行含统计（平均 ¥/成功率 N）与状态，efforts 行条件式', () => {
  const stats = new Map([['qa', { avgCost: 0.012, successRate: 0.85, n: 12 }]]);
  const lines = profileDetailLines(
    { id: 'qa', description: '查资料与汇总的测试场景方案', provider: 'dp', model: 'flash', tokenTier: 'cheap' },
    { stats, models: MODELS, effortsByModel: EFFORTS, policy: undefined }
  );
  assert.match(lines[0], /^qa: 查资料与汇总的测试场景方案 — dp\/flash · tier cheap · 平均 ¥0\.012 · 成功率 0\.85 \(N=12\) · 官方状态:在册$/);
  assert.equal(lines[1], '· efforts: off/high');
  // 未绑定：统计缺省省略成本/成功率；官方状态未绑定。
  const unbound = profileDetailLines(
    { id: 'code', description: '写代码与多文件重构场景方案', preset: 'standard', tokenTier: 'balanced' },
    { stats: new Map(), models: MODELS, effortsByModel: EFFORTS, policy: undefined }
  );
  assert.match(unbound[0], /— 继承父 · tier balanced · 官方状态:未绑定$/);
  assert.equal(unbound[1], '· efforts: 继承父模型，档位以父为准');
  // 列表口径截断 80 字符 + …。
  const long = profileDetailLines(
    { id: 'longdesc', description: '长'.repeat(120), provider: 'dp', model: 'flash', tokenTier: 'cheap' },
    { stats: new Map(), models: MODELS, effortsByModel: EFFORTS, policy: undefined, truncate: true }
  );
  assert.match(long[0], /^longdesc: 长{80}… /, '列表行描述截断 80 字符');
});

// ---- buildProfilesQueryText：四入口 + 成对校验（纯函数） ----------------------

const ROWS = [
  { id: 'qa', description: '查资料与汇总的测试场景方案', provider: 'dp', model: 'flash', tokenTier: 'cheap' },
  { id: 'code', description: '写代码与多文件重构场景方案', preset: 'standard', tokenTier: 'balanced' },
  { id: 'ghost', description: '测试场景但模型不在册', provider: 'dp', model: 'not-listed', tokenTier: 'cheap' },
];

test('buildProfilesQueryText：无参全量 / id 单档 / tier 过滤 / provider+model 成对', () => {
  const env = { rows: ROWS, stats: new Map(), models: MODELS, effortsByModel: EFFORTS, policy: undefined };
  const all = buildProfilesQueryText({ args: {}, ...env });
  assert.match(all.text, /^派发档案目录（3）：/);
  assert.ok(all.text.includes('qa:') && all.text.includes('code:') && all.text.includes('ghost:'));
  const one = buildProfilesQueryText({ args: { id: 'code' }, ...env });
  assert.match(one.text, /^code: 写代码与多文件重构场景方案 — 继承父 · tier balanced · 官方状态:未绑定$/m);
  const missing = buildProfilesQueryText({ args: { id: 'nope' }, ...env });
  assert.match(missing.text, /未找到 profile "nope"。可用 id：qa、code、ghost/);
  const tier = buildProfilesQueryText({ args: { tier: 'cheap' }, ...env });
  assert.match(tier.text, /tier=cheap 的方案（2）：/);
  assert.ok(tier.text.includes('qa:') && tier.text.includes('ghost:'));
  assert.ok(!tier.text.includes('code:'), 'balanced 不进 cheap 过滤');
  const pair = buildProfilesQueryText({ args: { provider: 'dp', model: 'flash' }, ...env });
  assert.match(pair.text, /模型 dp\/flash 官方 reasoning efforts：off\/high/);
  assert.ok(pair.text.includes('qa:'), '绑定该模型的档案必须列出');
  assert.ok(!pair.text.includes('ghost:'), '绑定其它模型的档案不列出');
  const unlisted = buildProfilesQueryText({ args: { provider: 'dp', model: 'not-listed' }, ...env });
  assert.match(unlisted.text, /官方 reasoning efforts：（目录无该模型明细）/);
  assert.ok(unlisted.text.includes('官方状态:未在册'));
});

test('buildProfilesQueryText：provider/model 只传其一 → fail-loud（成对约束）', () => {
  const env = { rows: ROWS, stats: new Map(), models: MODELS, effortsByModel: EFFORTS, policy: undefined };
  assert.throws(() => buildProfilesQueryText({ args: { provider: 'dp' }, ...env }), /provider 与 model 须成对提供/);
  assert.throws(() => buildProfilesQueryText({ args: { model: 'flash' }, ...env }), /provider 与 model 须成对提供/);
});

// ---- execute：apply 接线 + 数据源拼接 + 未授权联动 ----------------------------

test('execute 无参全量：内置 + 注册档案，含官方状态与 efforts 两态', async () => {
  const { iso, records } = await setupApp();
  try {
    const tool = queryToolOf(records);
    const out = await tool.execute({}, { agent: makeQueryAgent() });
    assert.match(out.text, /^派发档案目录（6）：/, '内置 2 + 注册 4');
    for (const id of ['qa', 'code', 'ghost', 'longdesc', 'swap-standard', 'researcher']) {
      assert.ok(out.text.includes(`${id}:`), `目录必须含 ${id}`);
    }
    assert.match(out.text, /qa: 查资料与汇总的测试场景方案 — dp\/flash · tier cheap · 官方状态:在册\n· efforts: off\/high/);
    assert.match(out.text, /code: .*官方状态:未绑定\n· efforts: 继承父模型，档位以父为准/);
    assert.match(out.text, /ghost: .*官方状态:未在册·未授权\n· efforts: （目录无该模型明细）/);
    // 列表行描述截断 80 + …。
    assert.match(out.text, /longdesc: .*… — dp\/v4/);
  } finally { iso.restore(); iso.teardown(); }
});

test('execute id 单档明细：描述不截断', async () => {
  const { iso, records } = await setupApp();
  try {
    const tool = queryToolOf(records);
    const out = await tool.execute({ id: 'longdesc' }, { agent: makeQueryAgent() });
    assert.match(out.text, /^longdesc: 这是一个用于验证列表口径截断的长描述方案说明文字。/);
    assert.ok(out.text.includes('这是一个用于验证列表口径截断的长描述方案说明文字。这是一个用于验证列表口径截断的长描述方案说明文字。'), '单档明细描述完整');
    assert.doesNotMatch(out.text, /…/, '单档明细不截断');
    assert.match(out.text, /官方状态:在册·未授权/);
  } finally { iso.restore(); iso.teardown(); }
});

test('execute：未知 id → 给出可用 id 清单（advisory，不抛）', async () => {
  const { iso, records } = await setupApp();
  try {
    const tool = queryToolOf(records);
    const out = await tool.execute({ id: 'nope' }, { agent: makeQueryAgent() });
    assert.match(out.text, /未找到 profile "nope"。可用 id：/);
    assert.ok(out.text.includes('qa') && out.text.includes('swap-standard'));
  } finally { iso.restore(); iso.teardown(); }
});

test('execute：provider/model 只传其一 → fail-loud', async () => {
  const { iso, records } = await setupApp();
  try {
    const tool = queryToolOf(records);
    await assert.rejects(() => tool.execute({ provider: 'dp' }, { agent: makeQueryAgent() }), /provider 与 model 须成对提供/);
    await assert.rejects(() => tool.execute({ model: 'flash' }, { agent: makeQueryAgent() }), /provider 与 model 须成对提供/);
  } finally { iso.restore(); iso.teardown(); }
});

test('execute：未授权联动官方模型选择投影（投影允许 flash，v4 绑定档案标未授权）', async () => {
  const { iso, records } = await setupApp();
  try {
    const tool = queryToolOf(records);
    const out = await tool.execute({ tier: 'premium' }, { agent: makeQueryAgent() });
    // longdesc 绑定 dp/v4：在册但不在投影允许集 → 在册·未授权。
    assert.match(out.text, /longdesc: .*官方状态:在册·未授权/);
  } finally { iso.restore(); iso.teardown(); }
});
