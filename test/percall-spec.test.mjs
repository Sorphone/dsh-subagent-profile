// test/percall-spec.test.mjs — per-call 规范化清单（零行为变更断言）。
// 覆盖：
//   * ① per-call 覆盖优先于 profile：profile 设 model='m1'、per-call 设 model='m2'
//     → 前台 execute 结果与决策轨迹的 effective.model 均为 'm2'。
//   * ② 未知字段拒绝：DISPATCH_PARAMETERS 键集恰为白名单 14 键（9 配置 + 2 模式 +
//     profile/tokenTier/envelope/prompt），toolFilter schema 闭合
//     （additionalProperties:false，无未知键接受路径）。
//   * ③ continuable 下 per-call reasoningEffort 忽略但回显请求值：结果
//     meta.reasoningEffort 回显请求档，ignored 含 reasoningEffort。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCH_PARAMETERS } from '../lib/core/dispatch-schema.mjs';
import { requestedOf } from '../lib/core/decision-trace.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// 白名单键集 = 9 配置（preset/model/provider/reasoningEffort/persona/toolFilter/
// maxTokens/maxDepth + tokenTier 预算档）+ 2 模式（run_in_background/continuable）
// + profile（容器选择）/ envelope（模式）/ prompt（任务文本）。键集断言以未列出的
// 任一键都必须被拒绝的闭合口径为准。
const WHITELIST_KEYS = [
  'profile', 'preset', 'model', 'provider', 'reasoningEffort', 'tokenTier',
  'persona', 'toolFilter', 'maxTokens', 'maxDepth',
  'run_in_background', 'continuable', 'envelope', 'prompt',
];

// 提供能力面可核验的 llm：m1/m2 均在目录中，resolveCallConfig 接受任意档位。
function makeLlm() {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    resolveCallConfig: async () => ({}),
  };
}

function makeForegroundParent() {
  const llm = makeLlm();
  return {
    ctx: {
      get: (name) => (name === 'llm' ? llm : undefined),
      tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
    },
    options: {},
  };
}

// ---- ① per-call 覆盖优先于 profile ----------------------------------------------

test('per-call 优先：profile model=m1，per-call model=m2 → effective.model 为 m2', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => {
      // per-call 优先级断言只看 execute 返回的 meta/轨迹，不依赖子请求。
      return { result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }, dispose: async () => {} };
    };
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const service = records.provides.find((p) => p.name === 'subagent-profiles')?.service;
    service.register({ id: 'ptest', name: 'PT', description: '带 model 的测试 profile', model: 'm1' });
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute(
      { prompt: 'task', profile: 'ptest', model: 'm2' },
      { agent: makeForegroundParent(), signal: undefined }
    );
    assert.equal(out.model, 'm2', '前台结果 meta.model 必须为 per-call 覆盖值');
    assert.equal(out.decisionTrace.effective.model, 'm2', '决策轨迹 effective.model 必须为 per-call 覆盖值');
    assert.equal(out.decisionTrace.requested.model, 'm2', '请求参数快照 model 必须为 per-call 值');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- ② 未知字段拒绝：白名单键集闭合 + toolFilter 闭合 ---------------------------

test('参数 schema：键集恰为白名单 14 键（无未知字段接受路径）', () => {
  const keys = Object.keys(DISPATCH_PARAMETERS);
  assert.deepEqual([...keys].sort(), [...WHITELIST_KEYS].sort(), '键集必须与白名单齐全');
  assert.equal(keys.length, WHITELIST_KEYS.length, '不得多出白名单外的字段');
  for (const key of keys) {
    assert.ok(WHITELIST_KEYS.includes(key), `字段 ${key} 必须在白名单内`);
  }
});

test('参数 schema：toolFilter 闭合（additionalProperties:false，无未知键接受路径）', () => {
  const filter = DISPATCH_PARAMETERS.toolFilter;
  assert.equal(filter.type, 'object');
  assert.equal(filter.additionalProperties, false, 'toolFilter 必须闭合，任何未知子键都被 schema 拒绝');
  assert.ok(filter.properties.allow, 'allow 子字段必须声明');
  assert.ok(filter.properties.deny, 'deny 子字段必须声明');
});

// ---- ③ continuable 下 per-call reasoningEffort 忽略但回显 ------------------------

test('continuable：per-call reasoningEffort 被忽略但结果回显请求值，ignored 含 reasoningEffort', async () => {
  const iso = makeIsolatedDshHome();
  try {
    let captured;
    const startContinuable = async (opts) => { captured = opts; return { childId: 'child-effort' }; };
    const { ctx, records } = createFakeCtx({ startContinuable });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute(
      { prompt: 'task', continuable: true, reasoningEffort: 'high' },
      { agent: makeForegroundParent(), signal: undefined } // agentOptions 不含 effort
    );
    assert.equal(out.kind, 'continuable');
    assert.equal(out.reasoningEffort, 'high', '结果 meta.reasoningEffort 必须回显请求值');
    assert.deepEqual(out.ignored, ['preset', 'reasoningEffort'], 'ignored 必须列出被丢弃的 reasoningEffort');
    assert.equal(out.decisionTrace.effective.reasoningEffort, 'high', '轨迹 effective.reasoningEffort 回显请求值');
    assert.ok(out.decisionTrace.effective.ignored.includes('reasoningEffort'), '轨迹 effective.ignored 必须含 reasoningEffort');
    assert.equal(captured.request.agentOptions, undefined, 'continuable request 不得携带 agentOptions（effort 被忽略）');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- ④ 未知字段 fail-visible（F5）----------------------------------------------

test('F5：requestedOf 把未知 per-call 字段记入 unknown_keys（键集以 DISPATCH_PARAMETERS 为准）', () => {
  const requested = requestedOf({ prompt: 'p', model: 'm1', bogus: 1, toolFilter: { allow: ['read'] } });
  assert.deepEqual(requested.unknown_keys, ['bogus'], '未知字段必须记录到决策轨迹');
  assert.equal(requested.model, 'm1', '已知字段不受影响');
  const clean = requestedOf({ prompt: 'p' });
  assert.equal(clean.unknown_keys, undefined, '无未知字段时不写该键');
  // 已知键集合与 DISPATCH_PARAMETERS 同源（单一事实来源），防止两处键集漂移。
  const withModes = requestedOf({ prompt: 'p', run_in_background: true, continuable: false });
  assert.equal(withModes.unknown_keys, undefined, '模式字段不得误报为未知');
});

test('F5：execute 层未知字段进入 decisionTrace.requested.unknown_keys（不静默吞）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute(
      { prompt: 'task', model: 'm1', bogus: true, anotherUnknown: 'x' },
      { agent: makeForegroundParent(), signal: undefined }
    );
    assert.deepEqual(out.decisionTrace.requested.unknown_keys, ['bogus', 'anotherUnknown'], '未知字段必须记录到决策轨迹');
    assert.equal(out.decisionTrace.requested.model, 'm1', '已知字段不受影响');
  } finally { iso.restore(); iso.teardown(); }
});
