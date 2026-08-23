// test/observability.test.mjs — 结果可观测：elapsedMs 派发耗时 + stopReason 结束原因。
// 覆盖：
//   * 前台（execute completed）结算 meta 携带 elapsedMs(number) + stopReason=completed。
//   * 后台（settleStart）completed / 非 completed 结算携带 elapsedMs(number)，
//     且 stopReason 映射对齐底层词汇（max-tokens/aborted/refusal/error）。
//   * continuable 不结算、不携带 elapsedMs / stopReason（实际省略）。
//   * R1 三分支 output schema 同步携带 elapsedMs(number) + stopReason(string enum)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleStart } from '../lib/core/delegation.mjs';
import { assertResultSchemaConsistency } from '../lib/core/pure.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

function makeForegroundParent() {
  return { ctx: { get: () => undefined }, options: {} };
}

function makeContinuableParent() {
  // 提供 llm（让 assertCostGuard 对 reasoningEffort 的校验通过）与 tools.schemas
  // （供 computeContinuableAllow 取父工具集，非空）。
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
  };
}

// ---- 前台结算：elapsedMs + stopReason ------------------------------------------

test('foreground completed → meta.elapsedMs 为 number 且 stopReason=completed', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: { id: 'child-session' } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    assert.equal(typeof out.elapsedMs, 'number', 'elapsedMs 必须是 number');
    assert.ok(out.elapsedMs >= 0, 'elapsedMs 必须非负');
    assert.equal(out.stopReason, 'completed');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- 后台结算（settleStart）：elapsedMs + stopReason ------------------------------

test('settleStart completed → meta.elapsedMs 为 number 且 stopReason=completed', async () => {
  const start = async () => ({
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] },
    localAgent: { session: { id: 'bg-session' } },
    dispose: async () => {},
  });
  const out = await settleStart(start(), { aborted: false }, { profile: 'x' }, (b) => b, () => undefined);
  assert.equal(out.status, 'completed');
  assert.equal(typeof out.elapsedMs, 'number', 'elapsedMs 必须是 number');
  assert.ok(out.elapsedMs >= 0);
  assert.equal(out.stopReason, 'completed');
});

test('settleStart 非 completed → stopReason 映射对齐底层词汇', async () => {
  const cases = [
    ['max-tokens', 'failed'],
    ['aborted', 'killed'],
    ['refusal', 'failed'],
    ['error', 'failed'],
  ];
  for (const [stopReason, status] of cases) {
    const start = async () => ({
      result: { stopReason, output: [{ type: 'text', text: 'partial' }] },
      dispose: async () => {},
    });
    const out = await settleStart(start(), { aborted: false }, { profile: 'x' }, (b) => b, () => undefined);
    assert.equal(out.status, status, `stopReason=${stopReason} → status=${status}`);
    assert.equal(out.stopReason, stopReason, `stopReason 必须原样映射为 ${stopReason}`);
    assert.equal(typeof out.elapsedMs, 'number', '非 completed 结算同样携带 elapsedMs(number)');
  }
});

test('settleStart start 抛错 → stopReason 按中止状态映射 error/aborted', async () => {
  const boom = async () => { throw new Error('boom'); };
  const failed = await settleStart(boom(), { aborted: false }, { profile: 'x' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stopReason, 'error', '未中止的硬失败映射为 error');
  assert.equal(typeof failed.elapsedMs, 'number');

  const killed = await settleStart(boom(), { aborted: true }, { profile: 'x' });
  assert.equal(killed.status, 'killed');
  assert.equal(killed.stopReason, 'aborted', 'signal.aborted 映射为 aborted');
  assert.equal(typeof killed.elapsedMs, 'number');
});

// ---- continuable：不结算、不携带 ------------------------------------------------

test('continuable 不结算 → 结果不携带 elapsedMs / stopReason', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const startContinuable = async () => ({ childId: 'child-1' });
    const { ctx, records } = createFakeCtx({ startContinuable });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute(
      { prompt: 'task', continuable: true, preset: 'standard', reasoningEffort: 'high' },
      { agent: makeContinuableParent(), signal: undefined }
    );
    assert.equal(out.kind, 'continuable');
    assert.equal(out.elapsedMs, undefined, 'continuable 不结算，不携带 elapsedMs');
    assert.equal(out.stopReason, undefined, 'continuable 不结算，不携带 stopReason');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- R1 三分支 schema 同步 + render 行 ------------------------------------------

test('R1 schema：三分支同步携带 elapsedMs(number) + stopReason(string enum)', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    assert.doesNotThrow(() => assertResultSchemaConsistency(tool.output.schema));
    for (const branch of tool.output.schema.oneOf) {
      assert.equal(branch.properties.elapsedMs.type, 'number', '每分支必须有 elapsedMs(number)');
      assert.equal(branch.properties.stopReason.type, 'string', '每分支必须有 stopReason(string)');
      assert.deepEqual(
        branch.properties.stopReason.enum,
        ['completed', 'max-tokens', 'aborted', 'refusal', 'error'],
        'stopReason 枚举必须对齐底层词汇'
      );
    }
  } finally { iso.restore(); iso.teardown(); }
});

test('render 行：前台包含 elapsedMs 与 stopReason（供 client 解析回显）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const value = {
      output: 'x',
      profile: 'p',
      preset: 'inherit',
      provider: 'pr',
      model: 'm',
      reasoningEffort: 'off',
      tokenTier: 'cheap',
      childTotalTokens: 42,
      elapsedMs: 123,
      stopReason: 'completed',
      ignored: [],
    };
    const [block] = tool.output.render({}, value);
    assert.match(block.text, /elapsedMs=123/);
    assert.match(block.text, /stopReason=completed/);
  } finally { iso.restore(); iso.teardown(); }
});
