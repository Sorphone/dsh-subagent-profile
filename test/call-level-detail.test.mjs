// test/call-level-detail.test.mjs — 逐次调用明细（host 逐条收集 + 结算接线 + render 面隔离）。
// 覆盖：
//   * collectChildCalls：逐条产出 assistant/message 的 usage（可选字段仅该条报告时
//     携带）；截断到前 maxCalls 条 + totalCalls 记总数；assistant/chunk 不参与；无
//     usage 事件 / 非法输入返回 undefined；非 number 字段忽略（fail-soft）。
//   * 前台 runForeground 结算：decisionTrace.settled.calls 并入且不进结果顶层。
//   * 后台 settleStart：metaOut 并入 calls。
//   * render 行隔离：DISPATCH_RENDER 不渲染 calls（不进模型可见面）。
//   * 前台多调用：settled.calls 截断到默认 6 条 + trace lossless JSON。
//
// client 侧的纯函数（recordCalls / buildCallDetailSection）驻留 lib/client.js 这一
// 浏览器端无导出模块，无法被 node:test import，按「代码审查」覆盖（非单测）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectChildCalls, settleStart } from '../lib/core/delegation.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

function makeForegroundParent() {
  return { ctx: { get: () => undefined }, options: {}, session: { header: { id: 'parent-calls' } } };
}

// ---- collectChildCalls 逐条收集 ---------------------------------------------------

test('collectChildCalls：逐条产出 assistant/message 的 usage（可选字段仅该条报告时携带）', () => {
  const session = {
    events: [
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 200, outputTokens: 80, cacheWriteTokens: 5, reasoningTokens: 10 } } },
      { type: 'tool/call', data: { callId: 'c1' } },
    ],
  };
  assert.deepEqual(collectChildCalls(session), {
    calls: [
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 },
      { inputTokens: 200, outputTokens: 80, cacheWriteTokens: 5, reasoningTokens: 10 },
    ],
    truncated: false,
    totalCalls: 2,
  });
});

test('collectChildCalls：默认截断到前 6 条 + totalCalls 记总数', () => {
  const events = [];
  for (let i = 1; i <= 15; i += 1) {
    events.push({ type: 'assistant/message', data: { usage: { inputTokens: i, outputTokens: i * 2 } } });
  }
  const out = collectChildCalls({ events });
  assert.equal(out.totalCalls, 15);
  assert.equal(out.truncated, true);
  assert.equal(out.calls.length, 6);
  assert.deepEqual(out.calls[0], { inputTokens: 1, outputTokens: 2 });
  assert.deepEqual(out.calls[5], { inputTokens: 6, outputTokens: 12 });
});

test('collectChildCalls：显式 maxCalls 覆盖默认上限', () => {
  const events = [];
  for (let i = 1; i <= 15; i += 1) {
    events.push({ type: 'assistant/message', data: { usage: { inputTokens: i, outputTokens: i * 2 } } });
  }
  const out = collectChildCalls({ events }, 12);
  assert.equal(out.totalCalls, 15);
  assert.equal(out.truncated, true);
  assert.equal(out.calls.length, 12);
  assert.deepEqual(out.calls[11], { inputTokens: 12, outputTokens: 24 });
});

test('collectChildCalls：总数恰好等于上限时 truncated=false', () => {
  const events = [
    { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 20, outputTokens: 7 } } },
  ];
  assert.deepEqual(collectChildCalls({ events }, 2), {
    calls: [
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 20, outputTokens: 7 },
    ],
    truncated: false,
    totalCalls: 2,
  });
});

test('collectChildCalls：无任何 assistant/message 带 usage → undefined', () => {
  assert.equal(collectChildCalls({ events: [] }), undefined);
  assert.equal(collectChildCalls({ events: [{ type: 'tool/call', data: { callId: 'c' } }] }), undefined);
  assert.equal(collectChildCalls({ events: [{ type: 'assistant/message', data: {} }] }), undefined);
  assert.equal(collectChildCalls({ events: [{ type: 'assistant/message', data: { usage: undefined } }] }), undefined);
});

test('collectChildCalls：assistant/chunk 的 usage 不参与逐条收集', () => {
  const session = {
    events: [
      { type: 'assistant/chunk', data: { usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 999 } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } } },
    ],
  };
  assert.deepEqual(collectChildCalls(session), {
    calls: [{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }],
    truncated: false,
    totalCalls: 1,
  });
  // 仅 chunk 带 usage、无 message → undefined（与「无 usage 事件」同口径）。
  assert.equal(collectChildCalls({
    events: [{ type: 'assistant/chunk', data: { usage: { inputTokens: 1, outputTokens: 1 } } }],
  }), undefined);
});

test('collectChildCalls：非 object / 非 number 字段忽略（fail-soft），input/output 恒在', () => {
  const session = {
    events: [
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 'many', cacheWriteTokens: -1 } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 'x', outputTokens: 3 } } },
      { type: 'assistant/message', data: { usage: 'not-an-object' } },
      { type: 'assistant/message', data: { usage: [1, 2] } },
      { type: 'assistant/message', data: { usage: null } },
    ],
  };
  assert.deepEqual(collectChildCalls(session), {
    calls: [
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 0, outputTokens: 3 },
    ],
    truncated: false,
    totalCalls: 2,
  });
});

test('collectChildCalls：session / events 缺失或非法 → undefined', () => {
  assert.equal(collectChildCalls(undefined), undefined);
  assert.equal(collectChildCalls(null), undefined);
  assert.equal(collectChildCalls({}), undefined);
  assert.equal(collectChildCalls({ events: 'nope' }), undefined);
});

// ---- 前台结算：decisionTrace.settled.calls ----------------------------------------

test('foreground completed + usage 事件 → decisionTrace.settled.calls 并入，结果顶层无 calls', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const childSession = {
      events: [
        { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } } },
      ],
    };
    const subagentsStart = async () => ({
      id: 'child-calls-1',
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: childSession },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    assert.deepEqual(out.decisionTrace.settled.calls, {
      calls: [{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }],
      truncated: false,
      totalCalls: 1,
    });
    assert.equal(out.calls, undefined, 'calls 不进前台结果顶层（仅 settled，不进模型可见面）');
  } finally { iso.restore(); iso.teardown(); }
});

test('foreground completed + 无 usage 事件 → settled 省略 calls', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const childSession = { events: [] };
    const subagentsStart = async () => ({
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: childSession },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    assert.equal(out.decisionTrace.settled.calls, undefined, '无 usage 事件则 settled 无 calls');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- 后台结算（settleStart）：metaOut 并入 calls ----------------------------------

test('settleStart completed + usage 事件 → 结果含 calls（metaOut 并入，tokenMeter 无关）', async () => {
  const childSession = {
    events: [
      { type: 'assistant/message', data: { usage: { inputTokens: 40, outputTokens: 12, cacheReadTokens: 8 } } },
    ],
  };
  const start = async () => ({
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] },
    localAgent: { session: childSession },
    dispose: async () => {},
  });
  const out = await settleStart(start(), { aborted: false }, { profile: 'x' }, (b) => b, () => undefined);
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.calls, {
    calls: [{ inputTokens: 40, outputTokens: 12, cacheReadTokens: 8 }],
    truncated: false,
    totalCalls: 1,
  });
});

test('settleStart 非 completed → 不携带 calls', async () => {
  const childSession = {
    events: [{ type: 'assistant/message', data: { usage: { inputTokens: 7, outputTokens: 7 } } }],
  };
  const start = async () => ({
    result: { stopReason: 'aborted', output: [{ type: 'text', text: 'partial' }] },
    localAgent: { session: childSession },
    dispose: async () => {},
  });
  const out = await settleStart(start(), { aborted: false }, { profile: 'x' }, (b) => b, () => undefined);
  assert.equal(out.status, 'killed');
  assert.equal(out.calls, undefined);
});

// ---- render 行隔离：DISPATCH_RENDER 不渲染 calls ----------------------------------

test('render 行：DISPATCH_RENDER 不渲染 calls（不进模型可见面）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const calls = { calls: [{ inputTokens: 12345, outputTokens: 6789, cacheReadTokens: 111 }], truncated: false, totalCalls: 1 };
    const value = {
      kind: 'foreground', output: 'x', profile: 'p', preset: 'inherit', provider: 'pr', model: 'm',
      reasoningEffort: 'off', tokenTier: 'cheap', ignored: [], decisionTrace: { settled: { calls } },
    };
    const [block] = tool.output.render({}, value);
    assert.doesNotMatch(block.text, /12345/, 'render 行不得含 calls 的 inputTokens 值');
    assert.doesNotMatch(block.text, /6789/, 'render 行不得含 calls 的 outputTokens 值');
    assert.doesNotMatch(block.text, /totalCalls/, 'render 行不得含 calls 键');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- 前台结算：calls 截断 + lossless JSON -----------------------------------------

test('foreground 多调用：settled.calls 截断到默认 6 条，trace 为 lossless JSON', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const events = [];
    for (let i = 1; i <= 10; i += 1) {
      events.push({
        type: 'assistant/message',
        data: { usage: { inputTokens: i, outputTokens: i * 2, cacheReadTokens: i * 3 } },
      });
    }
    const subagentsStart = async () => ({
      id: 'child-calls-trunc',
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: { events } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    const calls = out.decisionTrace.settled.calls;
    assert.equal(calls.totalCalls, 10);
    assert.equal(calls.truncated, true);
    assert.equal(calls.calls.length, 6, '默认上限 6 条');
    // calls 数组元素无 undefined（input/output 恒在、可选字段仅有效 number 携带），
    // 故 stripUndefined 清理后 trace 仍为 lossless JSON（宿主校验前提）。
    assert.deepEqual(JSON.parse(JSON.stringify(out.decisionTrace)), out.decisionTrace, 'trace 为 lossless JSON');
  } finally { iso.restore(); iso.teardown(); }
});
