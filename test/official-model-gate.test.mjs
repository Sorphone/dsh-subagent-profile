// test/official-model-gate.test.mjs — 官方子代理模型选择（subagentModelSelectionPolicy）
// 官方模型选择投影（感知闸）断言：
//   ① 投影缺失 → 闸跳过（0.4.0 回归：无 policy 时轨迹闸序与 0.4.0 完全一致）
//   ② 显式越界（per-call 指定白名单外 provider/model）→ fail-loud 三层中文错误
//   ③ 继承绕过（关键）：profile 绑定白名单外模型、per-call 未指定 → fail-loud
//     （判定输入 = 生效路由，非 per-call 显式值）
//   ④ 白名单内（显式/继承/方案绑定）→ 通过，official-model 闸在 whitelist 后、cost 前
//   ⑤ 畸形投影（非数组/空数组/空 provider/空 model/重复路由）→ fail-loud 清晰错误
//   ⑥ 台账 source 三态（call/profile/parent）→ requested.source 与
//     effectiveModelSource 双落点断言
//   ⑦ 审计事件 official-model-reject：每次拒绝恰好落一条，格式与逃生舱审计一致
// 另覆盖 provider 渠道接线（runStartPreflight 读取 + agentOptions 生效路由判定）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readModelSelectionPolicy } from '../lib/core/model-policy.mjs';
import { effectiveModelSourceOf } from '../lib/core/decision-trace.mjs';
import { applyOfficialModelGate } from '../lib/core/dispatch-gates.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

const POLICY_KEY = 'subagentModelSelectionPolicy';
const ALLOWED = [{ provider: 'p1', model: 'm1' }];

// 官方投影 fake：stateOf 只回应官方 key，返回注入的投影值（undefined = 未注册/未固化）。
function makeProjections(value) {
  return { stateOf: (session, key) => { assert.equal(key, POLICY_KEY, '必须读取官方投影 key'); return value; } };
}

function makeLlm() {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    resolveCallConfig: async () => ({}),
  };
}

// 父 Agent fake：sessionProjections 与 llm 经 ctx.get 注入；缺省父路由 p1/m1。
function makeParent({ projection, llm = makeLlm(), options = { provider: 'p1', model: 'm1' }, sessionId = 'parent-sess' } = {}) {
  const services = { llm };
  if (projection !== undefined) services.sessionProjections = projection;
  return {
    ctx: {
      get: (name) => services[name],
      tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
    },
    options,
    session: { header: { id: sessionId } },
  };
}

function dispatchTool(records) {
  const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
  assert.ok(tool, 'apply() 必须注册 dispatch 工具');
  return tool;
}

function makeForegroundStart() {
  return async () => ({
    id: 'child-ok',
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
    localAgent: { session: { events: [] } },
    dispose: async () => {},
  });
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// ---- ① 投影缺失 → 闸跳过（0.4.0 回归）-------------------------------------------

test('① 投影缺失 → 闸跳过：无 policy 时轨迹闸序与 0.4.0 完全一致', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ subagentsStart: makeForegroundStart() });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const out = await tool.execute({ prompt: 'task' }, { agent: makeParent({ projection: undefined }), signal: undefined });
    assert.deepEqual(
      out.decisionTrace.gates.map((g) => g.name),
      ['whitelist', 'cost', 'intersection', 'approval', 'budget'],
      '无 policy 时闸序列与 0.4.0 一致（不新增 official-model 条目）'
    );
    // 读取面跳过语义：ctx 缺失 / 服务缺失 / stateOf 缺失 / 投影值 undefined / null 均为未配置。
    assert.equal(readModelSelectionPolicy(undefined, {}).configured, false);
    assert.equal(readModelSelectionPolicy({ get: () => undefined }, {}).configured, false);
    assert.equal(readModelSelectionPolicy({ get: () => ({}) }, {}).configured, false);
    assert.equal(readModelSelectionPolicy({ get: () => ({ stateOf: () => undefined }) }, {}).configured, false);
    assert.equal(readModelSelectionPolicy({ get: () => makeProjections(null) }, {}).configured, false, '投影已注册但未固化（null）视同未配置');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- ② 显式越界 → fail-loud 三层中文错误 -----------------------------------------

test('② 显式越界：per-call 指定白名单外 provider/model → fail-loud 三层中文错误', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({});
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    await assert.rejects(
      () => tool.execute(
        { prompt: 'task', provider: 'p2', model: 'm2' },
        { agent: makeParent({ projection: makeProjections(ALLOWED) }), signal: undefined }
      ),
      (err) => {
        assert.match(err.message, /模型 p2\/m2 不在本会话允许的子代理模型白名单内（允许：p1\/m1）/, '第一层：越界事实与白名单');
        assert.match(err.message, /官方在其工具链执行同一策略，本插件同步执行，以保证两通道一致。/, '第二层：与官方通道同策略');
        assert.match(err.message, /请改用允许的模型\/方案，或在官方设置更新模型选择（本会话策略已固定，新会话生效）。/, '第三层：行动路径');
        return true;
      }
    );
  } finally { iso.restore(); iso.teardown(); }
});

test('闸记录：reject 时先记 official-model fail 闸再 rethrow，审计入口一次', () => {
  const trace = { gates: [] };
  const events = [];
  const deps = { trace, evoLedger: { recordGovernanceAudit: (entry) => events.push(entry) }, sessionId: 's1' };
  assert.throws(
    () => applyOfficialModelGate(deps, {
      policy: { configured: true, enabled: true, allowedModels: ALLOWED },
      effective: { provider: 'p2', model: 'm2' },
    }),
    /p2\/m2/
  );
  assert.equal(trace.gates.length, 1, 'fail 闸恰好记录一条');
  assert.equal(trace.gates[0].name, 'official-model');
  assert.equal(trace.gates[0].verdict, 'fail');
  assert.equal(trace.gates[0].output.allowed, false);
  assert.equal(trace.gates[0].input.effective.model, 'm2', 'input 记录生效路由而非 per-call 原始值');
  assert.equal(events.length, 1, '治理审计入口恰好一次');
  assert.equal(events[0].kind, 'official-model-reject');
});

// ---- ③ 继承绕过（关键用例）-------------------------------------------------------

test('③ 继承绕过（关键）：profile 绑定白名单外模型、per-call 未指定 → fail-loud', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({});
    await mod.apply(ctx);
    const service = records.provides.find((p) => p.name === 'subagent-profiles')?.service;
    assert.ok(service, 'profiles service 必须提供');
    service.register({ id: 'bad-model', name: 'Bad', description: '白名单外模型绑定', model: 'm2' });
    const tool = dispatchTool(records);
    await assert.rejects(
      () => tool.execute(
        { prompt: 'task', profile: 'bad-model' },
        { agent: makeParent({ projection: makeProjections(ALLOWED) }), signal: undefined }
      ),
      (err) => {
        // 判定输入 = 生效路由：provider 继承父会话 p1、model 来自 profile 绑定 m2。
        assert.match(err.message, /模型 p1\/m2 不在本会话允许的子代理模型白名单内（允许：p1\/m1）/, '继承带出的模型同样受查');
        return true;
      }
    );
  } finally { iso.restore(); iso.teardown(); }
});

// ---- ④ 白名单内 → 通过 + 闸顺序不破坏 --------------------------------------------

test('④ 白名单内（显式/继承/方案绑定）→ 通过，official-model 闸在 whitelist 后、cost 前', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ subagentsStart: makeForegroundStart() });
    await mod.apply(ctx);
    const service = records.provides.find((p) => p.name === 'subagent-profiles')?.service;
    service.register({ id: 'ok-model', name: 'OK', description: '白名单内模型', model: 'm1' });
    const tool = dispatchTool(records);
    const parent = makeParent({ projection: makeProjections(ALLOWED) });
    const explicit = await tool.execute({ prompt: 'task', provider: 'p1', model: 'm1' }, { agent: parent, signal: undefined });
    assert.deepEqual(
      explicit.decisionTrace.gates.map((g) => g.name),
      ['whitelist', 'official-model', 'cost', 'intersection', 'approval', 'budget'],
      'official-model 闸插在 whitelist 后、cost 前，后续闸顺序不破坏'
    );
    assert.equal(explicit.decisionTrace.gates.find((g) => g.name === 'official-model').verdict, 'pass');
    const inherited = await tool.execute({ prompt: 'task' }, { agent: parent, signal: undefined });
    assert.equal(inherited.decisionTrace.gates.find((g) => g.name === 'official-model').verdict, 'pass', '继承父路由 p1/m1 在白名单内');
    const profiled = await tool.execute({ prompt: 'task', profile: 'ok-model' }, { agent: parent, signal: undefined });
    assert.equal(profiled.decisionTrace.gates.find((g) => g.name === 'official-model').verdict, 'pass', '方案绑定白名单内模型通过');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- ⑤ 畸形投影 → fail-loud（清晰错误，不静默）-------------------------------------

test('⑤ 畸形投影 → fail-loud：非数组/空数组/空 provider/空 model/重复路由', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({});
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const cases = [
      ['not-an-array', /须为非空路由数组/],
      [[], /须为非空路由数组/],
      [[{ provider: 'p1', model: '' }], /每项须为 provider\/model 非空字符串/],
      [[{ provider: '', model: 'm1' }], /每项须为 provider\/model 非空字符串/],
      [[{ provider: 'p1', model: 'm1' }, { provider: 'p1', model: 'm1' }], /重复/],
    ];
    for (const [value, pattern] of cases) {
      await assert.rejects(
        () => tool.execute({ prompt: 'task' }, { agent: makeParent({ projection: makeProjections(value) }), signal: undefined }),
        (err) => { assert.match(err.message, pattern, `畸形投影 ${JSON.stringify(value)} 必须 fail-loud 清晰报错`); return true; }
      );
    }
    const policy = readModelSelectionPolicy({ get: () => makeProjections(ALLOWED) }, { header: { id: 's' } });
    assert.equal(policy.configured, true, '合法投影 configured=true');
    assert.equal(policy.enabled, true);
    assert.deepEqual(policy.allowedModels, ALLOWED, '路由表为校验后的副本');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- ⑥ 台账 source 字段：call/profile/parent 三态 ---------------------------------

test('⑥ 台账 source 三态：requested.source 与 effectiveModelSource 双落点断言', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ subagentsStart: makeForegroundStart() });
    await mod.apply(ctx);
    const service = records.provides.find((p) => p.name === 'subagent-profiles')?.service;
    service.register({ id: 'src-profile', name: 'Src', description: 'source 测试', model: 'm1' });
    const tool = dispatchTool(records);
    const parent = makeParent({ projection: makeProjections(ALLOWED), sessionId: 'parent-src' });
    const callOut = await tool.execute({ prompt: 'task', provider: 'p1', model: 'm1' }, { agent: parent, signal: undefined });
    const profileOut = await tool.execute({ prompt: 'task', profile: 'src-profile' }, { agent: parent, signal: undefined });
    const parentOut = await tool.execute({ prompt: 'task' }, { agent: parent, signal: undefined });
    assert.equal(callOut.decisionTrace.requested.source, 'call', 'per-call 指定 → call');
    assert.equal(profileOut.decisionTrace.requested.source, 'profile', '方案绑定 → profile');
    assert.equal(parentOut.decisionTrace.requested.source, 'parent', '继承父会话 → parent');
    const rows = readJsonl(join(iso.dir, 'subagent-evolution', 'dispatch.jsonl'));
    assert.deepEqual(
      rows.map((r) => r.effectiveModelSource),
      ['call', 'profile', 'parent'],
      '派发台账 effectiveModelSource 与派发顺序一致'
    );
    assert.equal(effectiveModelSourceOf({}, {}, { options: {} }), 'default', '全未指定 → default');
    assert.equal(effectiveModelSourceOf({ provider: 'p1' }, {}, { options: { provider: 'p1', model: 'm1' } }), 'call', 'per-call 单侧指定也判 call');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- ⑦ 审计事件 official-model-reject 落地 -----------------------------------------

test('⑦ 审计事件 official-model-reject：每次拒绝恰好落一条，格式与逃生舱审计一致', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({});
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const parent = makeParent({ projection: makeProjections(ALLOWED), sessionId: 'parent-audit' });
    await assert.rejects(
      () => tool.execute({ prompt: 'task', provider: 'p2', model: 'm2' }, { agent: parent, signal: undefined }),
      /p2\/m2/
    );
    const auditFile = join(iso.dir, 'subagent-evolution', 'governance-audit.jsonl');
    const rows = readJsonl(auditFile);
    assert.equal(rows.length, 1, '一次拒绝恰好落一条审计事件');
    const event = rows[0];
    assert.equal(event.kind, 'official-model-reject');
    assert.equal(event.provider, 'p2');
    assert.equal(event.model, 'm2');
    assert.equal(event.session_id, 'parent-audit');
    assert.equal(event.v, 1, '与逃生舱审计同版本号');
    assert.equal(typeof event.ts, 'number');
    assert.equal(event.gates_snapshot.whitelist, 'pass', '审计携带白名单闸快照（whitelist 已过）');
    await assert.rejects(
      () => tool.execute({ prompt: 'task', provider: 'p2', model: 'm2' }, { agent: parent, signal: undefined }),
      /p2\/m2/
    );
    assert.equal(readJsonl(auditFile).length, 2, '第二次拒绝再落一条（每条拒绝恰好一条）');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- provider 渠道接线（runStartPreflight 读取 + agentOptions 生效路由判定）----------

test('provider 渠道：start 预检对 agentOptions 生效路由执行同一白名单（审计 + fail-loud）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({});
    await mod.apply(ctx);
    const provider = records.registerProviderCalls.find((p) => p.name === 'profile');
    assert.ok(provider, 'profile provider 必须注册');
    const parent = makeParent({ projection: makeProjections(ALLOWED) });
    await assert.rejects(
      () => provider.start({ profile: { model: 'm2' }, parent, signal: undefined }),
      (err) => {
        assert.match(err.message, /模型 p1\/m2 不在本会话允许的子代理模型白名单内（允许：p1\/m1）/, 'provider 渠道判定 agentOptions 生效路由');
        return true;
      }
    );
    const rows = readJsonl(join(iso.dir, 'subagent-evolution', 'governance-audit.jsonl'));
    assert.equal(rows.length, 1, 'provider 渠道拒绝同样写治理审计');
    assert.equal(rows[0].kind, 'official-model-reject');
    assert.equal(rows[0].provider, 'p1');
    assert.equal(rows[0].model, 'm2');
    assert.equal(rows[0].gates_snapshot.intersection, 'deferred', 'provider 渠道快照口径');
    assert.equal(rows[0].gates_snapshot.approval, 'never');
  } finally { iso.restore(); iso.teardown(); }
});
