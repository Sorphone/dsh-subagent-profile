// test/decision-trace.test.mjs — 派发决策轨迹（decisionTrace）纯组装 + 失败台账 +
// execute 级接线（经 fake ctx 的 dispatch.execute 路径）。
// 覆盖：
//   * 纯函数：createDecisionTrace 骨架 / recordGate 名单截断 / finalizeTrace 定稿 /
//     assertTraceSize 体积逐级截断（detail/reason → checks → 丢弃超长 detail）。
//   * 台账：record/get/take 读后清空 / 每会话上限 / 总量上限 / clear(dispose)。
//   * 接线：前台 completed 四闸齐全 + settled 并入 + execution.childSessionId；
//     continuable 无 settled 且 ignored 与 effective 一致；后台 execution.kind；
//     失败路径 ledger 记账 + 原错误文案不变；render 行不含决策轨迹内容；
//     presentationMeta 投影；三分支 schema 同步；HTTP 失败台账路由。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecisionTrace,
  recordGate,
  finalizeTrace,
  assertTraceSize,
  createFailureLedger,
  requestedOf,
  effectiveMeta,
  hardLimitChecks,
  recordApprovalGate,
} from '../lib/core/decision-trace.mjs';
import { assertResultSchemaConsistency, MAX_TOKENS, MAX_DEPTH } from '../lib/core/pure.mjs';
import { applyCostGuardGate } from '../lib/core/dispatch-gates.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// ---- createDecisionTrace 骨架 --------------------------------------------------

test('createDecisionTrace：骨架含 version/startedAt/parentContext/requested/gates 与三占位', () => {
  const trace = createDecisionTrace({ parentPreset: 'orchestrator' }, { profile: 'researcher' }, 123);
  assert.equal(trace.version, 1);
  assert.equal(trace.startedAt, 123);
  assert.deepEqual(trace.parentContext, { parentPreset: 'orchestrator' });
  assert.deepEqual(trace.requested, { profile: 'researcher' });
  assert.deepEqual(trace.gates, []);
  assert.equal(trace.effective, undefined);
  assert.equal(trace.execution, undefined);
  assert.equal(trace.settled, undefined);
});

// ---- recordGate：追加 + 名单截断 ------------------------------------------------

test('recordGate：追加一道闸，input/output 原样记录，reason 缺省时不写', () => {
  const trace = createDecisionTrace({}, {});
  recordGate(trace, { name: 'whitelist', input: { requestedPreset: 'standard' }, output: { allowed: true }, verdict: 'pass' });
  assert.equal(trace.gates.length, 1);
  assert.deepEqual(trace.gates[0], {
    name: 'whitelist',
    input: { requestedPreset: 'standard' },
    output: { allowed: true },
    verdict: 'pass',
  });
});

test('recordGate：名单类数组（>8 项字符串）截断为 values + truncated:true', () => {
  const trace = createDecisionTrace({}, {});
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  recordGate(trace, { name: 'intersection', input: { systemTrustCandidates: names }, output: { effectiveToolNames: names }, verdict: 'pass' });
  const gate = trace.gates[0];
  assert.deepEqual(gate.input.systemTrustCandidates, { values: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], truncated: true });
  assert.deepEqual(gate.output.effectiveToolNames, { values: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], truncated: true });
});

test('recordGate：≤8 项数组 / 非字符串数组不截断', () => {
  const trace = createDecisionTrace({}, {});
  recordGate(trace, { name: 'cost', input: { eight: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], nums: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, output: {}, verdict: 'pass' });
  assert.deepEqual(trace.gates[0].input.eight, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(trace.gates[0].input.nums, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

// ---- finalizeTrace 定稿 --------------------------------------------------------

test('finalizeTrace：只写传入的 effective/execution/settled，缺省不写', () => {
  const trace = createDecisionTrace({}, {});
  finalizeTrace(trace, { execution: { kind: 'background', jobId: 'j1' } });
  assert.deepEqual(trace.execution, { kind: 'background', jobId: 'j1' });
  assert.equal(trace.effective, undefined);
  assert.equal(trace.settled, undefined);
});

// ---- requestedOf / effectiveMeta / hardLimitChecks / recordApprovalGate ---------

test('requestedOf：不记 prompt 原文，只记 persona/toolFilter 存在性布尔与 prompt 摘要', () => {
  const out = requestedOf({ profile: 'p', preset: 'standard', persona: 'x', toolFilter: { deny: ['a'] }, envelope: true, prompt: 'SECRET PROMPT' });
  assert.equal(out.prompt, undefined, 'prompt 原文绝不进 requested');
  assert.equal(out.persona_present, true);
  assert.equal(out.toolFilter_present, true);
  assert.equal(out.envelope, true);
  assert.equal(out.profile, 'p');
  assert.equal(out.prompt_excerpt, 'SECRET PROMPT', 'prompt 摘要存在（≤200 字符全量）');
  assert.equal(out.prompt_truncated, undefined, '未截断时不带截断标记');
});

test('requestedOf：超长 prompt 摘要截断 200 字符 + 截断标记，原文不泄漏', () => {
  const longPrompt = 'x'.repeat(500);
  const out = requestedOf({ prompt: longPrompt });
  assert.equal(out.prompt_excerpt.length, 200, '摘要截断到 200 字符');
  assert.equal(out.prompt_excerpt, 'x'.repeat(200));
  assert.equal(out.prompt_truncated, true, '带截断标记');
  assert.equal(out.prompt, undefined, '原文仍不进 requested');
});

test('effectiveMeta：组装生效值 + ignored 列表', () => {
  assert.deepEqual(
    effectiveMeta({ profile: 'p', preset: 'inherit', provider: 'pr', model: 'm', reasoningEffort: 'off', tokenTier: 'cheap' }, ['preset', 'reasoningEffort']),
    { profile: 'p', preset: 'inherit', provider: 'pr', model: 'm', reasoningEffort: 'off', tokenTier: 'cheap', ignored: ['preset', 'reasoningEffort'] }
  );
});

test('hardLimitChecks：预判 maxTokens/maxDepth 超限（不 throw）', () => {
  const checks = hardLimitChecks({ maxTokens: MAX_TOKENS + 1, maxDepth: 1 }, MAX_TOKENS, MAX_DEPTH);
  assert.equal(checks[0].field, 'maxTokens');
  assert.equal(checks[0].verdict, 'fail');
  assert.equal(checks[1].verdict, 'pass');
});

test('recordApprovalGate：声明性记录 policy/applied 均为 never、verdict pass', () => {
  const trace = createDecisionTrace({}, {});
  recordApprovalGate(trace);
  assert.deepEqual(trace.gates[0], {
    name: 'approval',
    input: { policy: 'never' },
    output: { applied: 'never' },
    verdict: 'pass',
    reason: '派发不豁免审批：子 Agent 权限范围在启动时固定（DELEGATION_CONTEXT 语义）',
  });
});

test('applyCostGuardGate：profile 合并后的超限 maxTokens → checks 与真闸同口径 fail（merged 而非 args）', async () => {
  const trace = createDecisionTrace({}, {});
  const deps = {
    store: { getAllowFailOpen: () => false },
    logger: { warn: () => {} },
    catalog: { getSnapshot: async () => ({ llm: { providers: [], providersError: undefined, modelsByProvider: {} } }) },
  };
  const parent = { ctx: { get: () => undefined }, options: {} };
  // merged 携带超限值（args 无 maxTokens 的场景：profile 侧带入），真闸 assertHardLimits
  // 与轨迹 checks 必须同判 fail——若 checks 读 args 会错记 pass/undefined。
  await assert.rejects(
    () => applyCostGuardGate(trace, { maxTokens: MAX_TOKENS + 1 }, parent, deps),
    /超过委派上限/
  );
  const cost = trace.gates[0];
  assert.equal(cost.name, 'cost');
  assert.equal(cost.verdict, 'fail');
  assert.equal(cost.input.maxTokens, MAX_TOKENS + 1, 'gate input 记 merged 值');
  assert.equal(cost.output.checks[0].field, 'maxTokens');
  assert.equal(cost.output.checks[0].verdict, 'fail', 'checks 与真闸同口径（merged 超限 → fail）');
  assert.equal(cost.output.checks[0].input, MAX_TOKENS + 1, 'checks input 记 merged 值而非 args');
});

// ---- assertTraceSize：体积逐级截断 ---------------------------------------------

function makeBigTrace(detail) {
  const trace = createDecisionTrace({}, {});
  recordGate(trace, {
    name: 'cost',
    input: {},
    output: { checks: [{ field: 'provider', detail }] },
    verdict: 'fail',
    reason: 'x'.repeat(4000),
  });
  return trace;
}

test('assertTraceSize：超限时先截 reason 长文本到 200 字符', () => {
  const trace = makeBigTrace('short');
  assertTraceSize(trace);
  assert.ok(Buffer.byteLength(JSON.stringify(trace), 'utf8') <= 3072, '收敛后 ≤ 护栏预算');
  assert.equal(trace.gates[0].reason.length, 200, 'reason 被截到 200 字符');
});

test('assertTraceSize：仍超限时截 checks 数组到前 6 条', () => {
  const trace = createDecisionTrace({}, {});
  const checks = Array.from({ length: 20 }, (_, i) => ({ field: `f${i}`, detail: 'y'.repeat(150) }));
  recordGate(trace, { name: 'cost', input: {}, output: { checks }, verdict: 'pass' });
  assertTraceSize(trace);
  assert.ok(trace.gates[0].output.checks.length <= 6, 'checks 收敛到 ≤6 条');
  assert.ok(Buffer.byteLength(JSON.stringify(trace), 'utf8') <= 3072);
});

test('assertTraceSize：仍超限时整体移除 detail（保留结构化键）', () => {
  // 前两级（截 detail/reason 到 200 字符、截 checks 到 6 条）后仍超护栏预算
  // （多字节 detail 让 200 字符 ≈ 600 字节，6 条即 3600 字节）→ 后续级移除 detail。
  const trace = createDecisionTrace({}, {});
  const checks = Array.from({ length: 6 }, (_, i) => ({ field: `f${i}`, checkedAgainst: 'providerModelList', detail: '账'.repeat(6000) }));
  recordGate(trace, { name: 'cost', input: {}, output: { checks }, verdict: 'fail', reason: '账'.repeat(500) });
  assertTraceSize(trace);
  for (const check of trace.gates[0].output.checks) {
    assert.equal(check.detail, undefined, '超长 detail 被整体移除');
    assert.ok(check.field !== undefined, '结构化 field 保留');
    assert.ok(check.verdict === undefined || check.checkedAgainst !== undefined, '结构化键保留');
  }
  assert.ok(Buffer.byteLength(JSON.stringify(trace), 'utf8') <= 3072);
});

test('assertTraceSize：settled.calls 6 条完整保留（≤ 护栏预算 3072）', () => {
  const trace = createDecisionTrace({}, {});
  const calls = Array.from({ length: 6 }, () => ({ inputTokens: 9999, outputTokens: 9999, cacheReadTokens: 9999, cacheWriteTokens: 9999, reasoningTokens: 9999 }));
  trace.settled = { stopReason: 'completed', elapsedMs: 1000, calls: { calls, truncated: false, totalCalls: 6 } };
  assertTraceSize(trace);
  assert.equal(trace.settled.calls.calls.length, 6, '6 条完整保留');
  assert.equal(trace.settled.calls.truncated, false, '不误标截断');
  assert.ok(Buffer.byteLength(JSON.stringify(trace), 'utf8') <= 3072, '≤ 护栏预算');
});

test('assertTraceSize：超预算时截 settled.calls 内层数组到前 4 条 + truncated', () => {
  const trace = createDecisionTrace({}, {});
  // 构造前两级截断后仍超预算的组合：checks 20 条长 detail（第二级截到 6 条仍大）
  // + settled.calls 6 条大数字——触发第三级截 calls 到 4 条。
  const checks = Array.from({ length: 20 }, (_, i) => ({ field: `f${i}`, checkedAgainst: 'catalogProviders', detail: '账'.repeat(300) }));
  recordGate(trace, { name: 'cost', input: {}, output: { checks }, verdict: 'pass' });
  const calls = Array.from({ length: 6 }, () => ({ inputTokens: 99999, outputTokens: 99999, cacheReadTokens: 99999, cacheWriteTokens: 99999, reasoningTokens: 99999 }));
  trace.settled = { stopReason: 'completed', elapsedMs: 1000, calls: { calls, truncated: false, totalCalls: 6 } };
  assertTraceSize(trace);
  assert.equal(trace.settled.calls.calls.length, 4, 'calls 截到前 4 条');
  assert.equal(trace.settled.calls.truncated, true, 'truncated 标记置真');
  assert.equal(trace.settled.calls.totalCalls, 6, 'totalCalls 保留原总数');
  assert.ok(Buffer.byteLength(JSON.stringify(trace), 'utf8') <= 3072, '收敛到护栏预算内');
});

test('assertTraceSize：未超限的 trace 原样返回、不截断', () => {
  const trace = createDecisionTrace({}, {});
  recordGate(trace, { name: 'whitelist', input: {}, output: {}, verdict: 'pass', reason: 'ok' });
  const ref = trace;
  assert.equal(assertTraceSize(trace), ref, '返回同一引用');
  assert.equal(trace.gates[0].reason, 'ok');
});

// ---- createFailureLedger：台账 --------------------------------------------------

test('ledger：record/get 返回副本、take 读后清空', () => {
  const ledger = createFailureLedger({ warn: () => {} });
  ledger.record('s1', { a: 1 });
  ledger.record('s1', { a: 2 });
  assert.deepEqual(ledger.get('s1'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(ledger.take('s1'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(ledger.get('s1'), [], 'take 后该会话清空');
  assert.deepEqual(ledger.take('unknown'), [], '未知会话返回空数组');
});

test('ledger：每会话上限超限丢弃最旧并 warn', () => {
  const warns = [];
  const ledger = createFailureLedger({ maxPerSession: 3, warn: (m) => warns.push(m) });
  for (let i = 1; i <= 5; i++) ledger.record('s1', { n: i });
  assert.deepEqual(ledger.get('s1'), [{ n: 3 }, { n: 4 }, { n: 5 }], '只保留最新 3 条');
  assert.equal(ledger.count(), 3);
  assert.ok(warns.length >= 2, '两次超限各自 warn');
});

test('ledger：总量上限超限丢弃全局最旧并 warn', () => {
  const warns = [];
  const ledger = createFailureLedger({ maxPerSession: 10, maxTotal: 4, warn: (m) => warns.push(m) });
  ledger.record('s1', { n: 1 });
  ledger.record('s1', { n: 2 });
  ledger.record('s2', { n: 3 });
  ledger.record('s3', { n: 4 });
  ledger.record('s4', { n: 5 }); // 总量超 4 → 丢弃最旧 s1.n1
  assert.equal(ledger.count(), 4);
  assert.deepEqual(ledger.get('s1'), [{ n: 2 }], 's1 最旧一条被丢弃');
  assert.ok(warns.length >= 1);
});

test('ledger：clear 清空全部（dispose 语义）', () => {
  const ledger = createFailureLedger({ warn: () => {} });
  ledger.record('s1', { a: 1 });
  ledger.record('s2', { a: 2 });
  ledger.clear();
  assert.equal(ledger.count(), 0);
  assert.deepEqual(ledger.get('s1'), []);
});

test('ledger：空 / 非法 sessionId 跳过记录', () => {
  const ledger = createFailureLedger({ warn: () => {} });
  ledger.record(undefined, { a: 1 });
  ledger.record(null, { a: 2 });
  ledger.record('', { a: 3 });
  assert.equal(ledger.count(), 0);
});

// ---- execute 级接线（经 fake ctx 的 dispatch.execute 路径）-----------------------

function dispatchTool(records) {
  const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
  assert.ok(tool, 'apply() 必须注册 dispatch 工具');
  return tool;
}

function makeForegroundParent() {
  return { ctx: { get: () => undefined }, options: {}, session: { header: { id: 'parent-fg' } } };
}

function makeContinuableParent() {
  const llm = {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    resolveCallConfig: async () => ({}),
  };
  return {
    ctx: {
      get: (name) => (name === 'llm' ? llm : undefined),
      tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
    },
    options: {},
    session: { header: { id: 'parent-cont' } },
  };
}

// 捕获 HTTP 路由 handler（与 continuable-guard.test.mjs 同款 fake webServer）。
function makeRouteHarness() {
  const routes = [];
  const webServer = { register(config) { routes.push(config); return () => {}; } };
  return { webServer, routes };
}

async function callRoute(handler, method, path) {
  const req = { method, url: path, socket: { remoteAddress: '127.0.0.1' } };
  const res = { code: null, data: '', writeHead(code) { this.code = code; }, end(text) { this.data = text; } };
  await handler(req, res);
  return { code: res.code, json: res.data ? JSON.parse(res.data) : null };
}

test('execute 前台 completed：结果含 decisionTrace，四闸齐全 + settled 并入 + execution 跳转地址三字段', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      id: 'child-session-1',
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: { events: [] } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    const trace = out.decisionTrace;
    assert.ok(trace, '结果必须携带 decisionTrace');
    assert.equal(trace.version, 1);
    assert.deepEqual(trace.gates.map((g) => g.name), ['whitelist', 'cost', 'intersection', 'approval', 'budget'], '五闸齐全且顺序稳定（budget 通过也记闸）');
    assert.ok(trace.gates.every((g) => typeof g.verdict === 'string'), '每闸必有 verdict');
    assert.equal(trace.execution.kind, 'foreground', 'execution.kind=foreground');
    assert.equal(trace.execution.mode, 'one-shot', 'execution.mode=one-shot');
    assert.equal(trace.execution.parentSessionId, 'parent-fg', 'execution.parentSessionId=父会话 id');
    assert.equal(trace.execution.childSessionId, 'child-session-1', 'execution.childSessionId 存在');
    assert.equal(trace.gates.find((g) => g.name === 'intersection').output.mode, 'deferred', '前/后台交集闸记 deferred');
    assert.equal(trace.settled.stopReason, 'completed', 'settled 已并入');
    assert.equal(typeof trace.settled.elapsedMs, 'number');
    assert.deepEqual(trace.effective.ignored, [], '前台无忽略项');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute continuable：结果含 trace、ignored 与 effective 一致、无 settled', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const startContinuable = async () => ({ childId: 'child-1' });
    const { ctx, records } = createFakeCtx({ startContinuable });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const out = await tool.execute(
      { prompt: 'task', continuable: true, preset: 'standard', reasoningEffort: 'high' },
      { agent: makeContinuableParent(), signal: undefined }
    );
    const trace = out.decisionTrace;
    assert.ok(trace, 'continuable 结果必须携带 decisionTrace');
    assert.deepEqual(out.ignored, ['preset', 'reasoningEffort']);
    assert.deepEqual(trace.effective.ignored, out.ignored, 'ignored 与 trace.effective.ignored 一致');
    assert.equal(trace.effective.preset, 'inherit', 'continuable 生效 preset 为 inherit');
    assert.deepEqual(trace.gates.map((g) => g.name), ['whitelist', 'cost', 'intersection', 'approval'], 'continuable 闸序与前台一致（budget 不占并发不记闸）');
    assert.equal(trace.execution.kind, 'continuable');
    assert.equal(trace.execution.mode, 'continuable');
    assert.equal(trace.execution.parentSessionId, 'parent-cont');
    assert.equal(trace.execution.childSessionId, 'child-1');
    assert.equal(trace.settled, undefined, 'continuable 无 settled');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute 后台：结果含 trace、execution.kind=background、无 settled', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const jobs = { start: () => 'job-1' };
    const { ctx, records } = createFakeCtx({ services: { jobs } });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const out = await tool.execute({ prompt: 'task', run_in_background: true }, { agent: makeForegroundParent(), signal: undefined });
    const trace = out.decisionTrace;
    assert.ok(trace, '后台结果必须携带 decisionTrace');
    assert.equal(out.kind, 'background');
    assert.equal(trace.execution.kind, 'background');
    assert.equal(trace.execution.mode, 'one-shot');
    assert.equal(trace.execution.parentSessionId, 'parent-fg');
    assert.equal(trace.execution.jobId, 'job-1');
    assert.equal(trace.execution.childSessionId, undefined, '后台无 childSessionId（start 未 resolve）');
    assert.equal(trace.settled, undefined, '后台无 settled');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute 后台 + 父无 session：结果为 lossless JSON（undefined 已清理，宿主校验前提）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const jobs = { start: () => 'job-1' };
    const { ctx, records } = createFakeCtx({ services: { jobs } });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const noSessionParent = { ctx: { get: () => undefined }, options: {} };
    const out = await tool.execute({ prompt: 'task', run_in_background: true }, { agent: noSessionParent, signal: undefined });
    // 宿主对工具结果做 lossless JSON 校验：JSON 往返必须逐层一致，undefined 属性
    // 必须已删除、数组 undefined 元素必须已置 null。
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out, '结果必须 lossless JSON');
    assert.equal('settled' in out.decisionTrace, false, 'undefined 占位键已删除');
    assert.equal('parentSessionId' in out.decisionTrace.execution, false, 'undefined 值属性已删除');
    const costGate = out.decisionTrace.gates.find((g) => g.name === 'cost');
    assert.ok(costGate, 'cost 闸存在');
    assert.deepEqual(costGate.output.checks.map((c) => c.field), ['maxTokens', 'maxDepth', 'llm'], 'checks 数组元素保序（无 session 父 → llm 缺失条目）');
    assert.equal('input' in costGate.output.checks[0], false, 'checks 数组元素内 undefined 属性已删除');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute 失败路径：非法 preset 原错误文案不变 + 台账出现 fail 闸记录', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeRouteHarness();
    const { ctx, records } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const parent = { ctx: { get: () => undefined }, options: {}, session: { header: { id: 'sess-1' } } };
    await assert.rejects(
      () => tool.execute({ prompt: 'task', preset: 'nonexistent' }, { agent: parent, signal: undefined }),
      (err) => {
        assert.match(err.message, /dispatch: preset "nonexistent" is not in the target-preset whitelist/);
        return true;
      }
    );
    const handler = routes[0].handler;
    const resp = await callRoute(handler, 'GET', '/subagent-profiles/ledger/failures?session=sess-1');
    assert.equal(resp.code, 200);
    assert.equal(resp.json.ok, true);
    assert.equal(resp.json.failures.length, 1, '该 session 出现一条失败记录');
    const fail = resp.json.failures[0];
    const gate = fail.gates.find((g) => g.name === 'whitelist');
    assert.ok(gate, 'fail 闸必须存在');
    assert.equal(gate.verdict, 'fail');
    assert.equal(gate.input.requestedPreset, 'nonexistent', 'fail 闸 input 完整');
    assert.ok(gate.reason.includes('not in the target-preset whitelist'), 'fail 闸 reason 完整');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute render 行：DISPATCH_RENDER 输出不含 decisionTrace 内容（不进模型可见面）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const trace = createDecisionTrace({ parentPreset: 'orchestrator' }, { profile: 'researcher' });
    recordGate(trace, { name: 'whitelist', input: { requestedPreset: 'standard' }, output: { allowed: true }, verdict: 'pass' });
    const value = {
      kind: 'foreground', output: 'done', profile: 'p', preset: 'inherit', provider: 'pr', model: 'm',
      reasoningEffort: 'off', tokenTier: 'cheap', ignored: [], decisionTrace: trace,
    };
    const [block] = tool.output.render({}, value);
    assert.doesNotMatch(block.text, /decisionTrace/, 'render 行不得含 decisionTrace 键');
    assert.doesNotMatch(block.text, /whitelist/, 'render 行不得含闸名');
    assert.doesNotMatch(block.text, /orchestrator/, 'render 行不得含父上下文');
    assert.match(block.text, /done/, 'render 行正文不变');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute presentationMeta：投影返回值 === value.decisionTrace', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const trace = createDecisionTrace({}, {});
    assert.equal(tool.output.presentationMeta({}, { decisionTrace: trace }), trace);
  } finally { iso.restore(); iso.teardown(); }
});

test('execute schema：三分支都含 decisionTrace(object) + 一致性锁不抛', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    assert.doesNotThrow(() => assertResultSchemaConsistency(tool.output.schema));
    for (const branch of tool.output.schema.oneOf) {
      const dt = branch.properties.decisionTrace;
      assert.equal(dt.type, 'object', '每分支必须有 decisionTrace(object)');
    }
  } finally { iso.restore(); iso.teardown(); }
});

test('execute HTTP 路由：GET /ledger/failures 返回台账内容，未知 session 空数组', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeRouteHarness();
    const { ctx, records } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const parent = { ctx: { get: () => undefined }, options: {}, session: { header: { id: 'sess-x' } } };
    await assert.rejects(
      () => tool.execute({ prompt: 'task', preset: 'nope' }, { agent: parent, signal: undefined }),
      /not in the target-preset whitelist/
    );
    const handler = routes[0].handler;
    const hit = await callRoute(handler, 'GET', '/subagent-profiles/ledger/failures?session=sess-x');
    assert.equal(hit.code, 200);
    assert.equal(hit.json.failures.length, 1);
    const miss = await callRoute(handler, 'GET', '/subagent-profiles/ledger/failures?session=unknown');
    assert.equal(miss.code, 200);
    assert.deepEqual(miss.json.failures, [], '未知 session 返回空数组');
    // 非 loopback 来源拒绝（沿用现有路由 loopback 守卫）。
    const forbiddenReq = { method: 'GET', url: '/subagent-profiles/ledger/failures?session=sess-x', socket: { remoteAddress: '10.0.0.1' } };
    const forbiddenRes = { code: null, data: '', writeHead(code) { this.code = code; }, end(text) { this.data = text; } };
    await handler(forbiddenReq, forbiddenRes);
    assert.equal(forbiddenRes.code, 403, '非 loopback 拒绝');
  } finally { iso.restore(); iso.teardown(); }
});
