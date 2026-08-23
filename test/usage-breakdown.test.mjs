// test/usage-breakdown.test.mjs — 真实计费 token 五段分解 + 缓存命中（数据层与 meta 接线）。
// 覆盖：
//   * collectChildUsage：累加 assistant/message 事件的五段 usage；可选字段（缓存读/
//     写/推理）全程缺失省略键；无任何 usage 事件 → undefined；非 object / 非 number
//     类型守卫忽略（fail-soft）。
//   * 前台 / 后台 completed 结算 meta 携带 childUsage 且仅 completed 携带；tokenMeter
//     缺失不影响 childUsage（usage 走 session 事件，与 tokenMeter 无关）。
//   * R1 三分支 output schema 同步携带 childUsage（object，五键 number）。
//   * render 行 JSON 序列化 childUsage（client 解析回对象的前向契约）。
//
// client 侧的纯函数（parseChildUsage / usageBreakdownText）驻留 lib/client.js 这一
// 浏览器端无导出模块，无法被 node:test import，故按「代码审查」覆盖（非单测）；此处
// 以 render 行 JSON 段的前向契约测试作为 host→client 边界的等价验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectChildUsage, settleStart } from '../lib/core/delegation.mjs';
import { assertResultSchemaConsistency } from '../lib/core/pure.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// ---- collectChildUsage 累加 ---------------------------------------------------

test('collectChildUsage：累加 assistant/message 五段 usage（含可选字段）', () => {
  const session = {
    events: [
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 } } },
      { type: 'assistant/message', data: { turn: 2, step: 1, usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 10 } } },
      { type: 'tool/call', data: { callId: 'c1' } },
    ],
  };
  assert.deepEqual(collectChildUsage(session), {
    inputTokens: 300,
    outputTokens: 130,
    cacheReadTokens: 50,
    cacheWriteTokens: 5,
    reasoningTokens: 10,
  });
});

test('collectChildUsage：可选字段全程缺失 → 省略键', () => {
  const session = {
    events: [
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5 } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 20, outputTokens: 7 } } },
    ],
  };
  assert.deepEqual(collectChildUsage(session), { inputTokens: 30, outputTokens: 12 });
});

test('collectChildUsage：无任何 assistant/message 带 usage → undefined', () => {
  assert.equal(collectChildUsage({ events: [] }), undefined);
  assert.equal(collectChildUsage({ events: [{ type: 'tool/call', data: { callId: 'c' } }] }), undefined);
  assert.equal(collectChildUsage({ events: [{ type: 'assistant/message', data: {} }] }), undefined);
  assert.equal(collectChildUsage({ events: [{ type: 'assistant/message', data: { usage: undefined } }] }), undefined);
});

test('collectChildUsage：assistant/chunk 的 usage 不参与累加（同 step 早期分片，防重复计数）', () => {
  const session = {
    events: [
      { type: 'assistant/chunk', data: { usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 999 } } },
      { type: 'assistant/chunk', data: { usage: { inputTokens: 888, outputTokens: 888 } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } } },
    ],
  };
  // chunk 的 999/888 全被忽略，只计 message 的 10/5/3。
  assert.deepEqual(collectChildUsage(session), { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
  // 仅 chunk 带 usage、无 message → undefined（与「无 usage 事件」同口径）。
  assert.equal(collectChildUsage({
    events: [{ type: 'assistant/chunk', data: { usage: { inputTokens: 1, outputTokens: 1 } } }],
  }), undefined);
});

test('collectChildUsage：非 object / 非 number 类型守卫忽略', () => {
  const session = {
    events: [
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 'many', cacheWriteTokens: -1, reasoningTokens: NaN } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 'x', outputTokens: 3 } } },
      { type: 'assistant/message', data: { usage: 'not-an-object' } },
      { type: 'assistant/message', data: { usage: [1, 2] } },
      { type: 'assistant/message', data: { usage: null } },
    ],
  };
  assert.deepEqual(collectChildUsage(session), { inputTokens: 10, outputTokens: 8 });
});

test('collectChildUsage：session / events 缺失或非法 → undefined', () => {
  assert.equal(collectChildUsage(undefined), undefined);
  assert.equal(collectChildUsage(null), undefined);
  assert.equal(collectChildUsage({}), undefined);
  assert.equal(collectChildUsage({ events: 'nope' }), undefined);
});

// ---- 前台结算：meta.childUsage 且仅 completed 携带 --------------------------------

function makeForegroundParent() {
  return { ctx: { get: () => undefined }, options: {} };
}

test('foreground completed + usage 事件 → meta.childUsage 累加', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const childSession = {
      events: [
        { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } } },
      ],
    };
    const subagentsStart = async () => ({
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: childSession },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    assert.deepEqual(out.childUsage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
  } finally { iso.restore(); iso.teardown(); }
});

test('foreground completed + 无 usage 事件 → 省略 childUsage（向前兼容）', async () => {
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
    assert.equal(out.childUsage, undefined);
  } finally { iso.restore(); iso.teardown(); }
});

test('foreground 非 completed → 抛错（无结果，不携带 childUsage）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const childSession = {
      events: [{ type: 'assistant/message', data: { usage: { inputTokens: 9, outputTokens: 9 } } }],
    };
    const subagentsStart = async () => ({
      result: { stopReason: 'max-tokens', output: [{ type: 'text', text: 'partial' }] },
      localAgent: { session: childSession },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    await assert.rejects(
      () => tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined }),
      /token limit/
    );
  } finally { iso.restore(); iso.teardown(); }
});

// ---- 后台结算（settleStart）：meta.childUsage 且仅 completed 携带 -------------------

test('settleStart completed + usage 事件 → 结果含 childUsage（tokenMeter 无关）', async () => {
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
  // measureChild 恒返回 undefined（模拟 tokenMeter 缺失）：childUsage 仍应携带，
  // 证明 usage 走 session 事件、与 tokenMeter 无关。
  const out = await settleStart(start(), { aborted: false }, { profile: 'x' }, (b) => b, () => undefined);
  assert.equal(out.status, 'completed');
  assert.equal(out.childTotalTokens, undefined);
  assert.deepEqual(out.childUsage, { inputTokens: 40, outputTokens: 12, cacheReadTokens: 8 });
});

test('settleStart 非 completed → 不携带 childUsage', async () => {
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
  assert.equal(out.childUsage, undefined);
});

// ---- R1 三分支 schema 同步 -------------------------------------------------------

test('R1 schema：三分支同步携带 childUsage（object，五键 number）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    assert.doesNotThrow(() => assertResultSchemaConsistency(tool.output.schema));
    for (const branch of tool.output.schema.oneOf) {
      const u = branch.properties.childUsage;
      assert.equal(u.type, 'object', '每分支必须有 childUsage(object)');
      assert.equal(u.additionalProperties, false, 'childUsage 必须闭合（additionalProperties:false）');
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
        assert.equal(u.properties[key].type, 'number', `childUsage.${key} 必须为 number`);
      }
      assert.match(u.description, /真实计费/);
    }
  } finally { iso.restore(); iso.teardown(); }
});

// ---- render 行：JSON 序列化 childUsage（host→client 前向契约） ---------------------

test('render 行：前台 JSON 序列化 childUsage 供 client 解析回对象', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const childUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 };
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
      childUsage,
      ignored: [],
    };
    const [block] = tool.output.render({}, value);
    assert.ok(block.text.includes(`childUsage=${JSON.stringify(childUsage)}`), 'render 行必须含 childUsage JSON 段');
  } finally { iso.restore(); iso.teardown(); }
});

test('render 行：background / continuable 不携带 childUsage', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const shared = { profile: 'p', preset: 'inherit', provider: 'pr', model: 'm', reasoningEffort: 'off', tokenTier: 'cheap', ignored: [] };
    const bg = tool.output.render({}, { kind: 'background', jobId: 'j', ...shared });
    assert.doesNotMatch(bg[0].text, /childUsage=/);
    const cont = tool.output.render({}, { kind: 'continuable', subagentId: 's', ...shared });
    assert.doesNotMatch(cont[0].text, /childUsage=/);
  } finally { iso.restore(); iso.teardown(); }
});
