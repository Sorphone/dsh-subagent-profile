// test/envelope.test.mjs — 信封模式 opt-in 启用：
//   * schema：envelope 参数 description 已启用（结构化信封汇报 + 默认剪枝回收）。
//   * 前台 / continuable 分支：envelope:true 时把信封骨架追加进子 persona
//     （request.persona 与 request.profile.persona 均含骨架）。
//   * 骨架只进 persona、不进 descriptor（request.descriptor 保持未设）。
//   * 既有 persona 非空时以空行衔接追加，不覆盖原文。
//   * 默认（无 envelope）行为不变：persona 未设时保持未设，剪枝照常。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

const SKELETON_MARKERS = [
  '完成前按以下骨架输出：## 结论（1-2 句）',
  '## 结构分项（逐项）',
  '## 关键发现落点（文件路径/数据位置）',
];

function assertHasSkeleton(text, label) {
  assert.equal(typeof text, 'string', `${label} 必须为字符串（含信封骨架）`);
  for (const marker of SKELETON_MARKERS) {
    assert.ok(text.includes(marker), `${label} 必须包含信封骨架片段：${marker}`);
  }
}

function makeForegroundParent() {
  return { ctx: { get: () => undefined }, options: {} };
}

function makeContinuableParent() {
  // 提供 llm（供 assertCostGuard 能力面校验兜底）与 tools.schemas
  // （供 buildContinuableRequest 取父工具集，非空）。
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

// ---- schema：envelope description 已启用 ----------------------------------------

test('envelope schema：description 已启用（结构化信封 + 默认剪枝回收）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const envelope = tool.parameters.properties.envelope;
    assert.equal(envelope.type, 'boolean');
    assert.match(envelope.description, /结构化信封汇报/);
    assert.match(envelope.description, /默认 false 走剪枝回收/);
    assert.doesNotMatch(envelope.description, /预留/);
  } finally { iso.restore(); iso.teardown(); }
});

// ---- 前台分支：骨架进 persona、不进 descriptor -----------------------------------

test('envelope:true 前台 → request.persona / profile.persona 含骨架，descriptor 不触碰', async () => {
  const iso = makeIsolatedDshHome();
  try {
    let captured;
    const subagentsStart = async (_provider, request) => {
      captured = request;
      return { result: { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }, dispose: async () => {} };
    };
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    await tool.execute({ prompt: 'task', envelope: true }, { agent: makeForegroundParent(), signal: undefined });
    assertHasSkeleton(captured.persona, 'request.persona');
    assertHasSkeleton(captured.profile.persona, 'request.profile.persona');
    assert.equal(captured.descriptor, undefined, 'descriptor 不触碰：request.descriptor 必须保持未设');
    assert.equal(captured.profile.descriptor, undefined, 'descriptor 不触碰：profile.descriptor 必须保持未设');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- continuable 分支：骨架进 persona、不进 descriptor ----------------------------

test('envelope:true continuable → request.persona 含骨架，descriptor 不触碰', async () => {
  const iso = makeIsolatedDshHome();
  try {
    let captured;
    const startContinuable = async (opts) => { captured = opts; return { childId: 'child-envelope' }; };
    const { ctx, records } = createFakeCtx({ startContinuable });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute(
      { prompt: 'task', continuable: true, envelope: true },
      { agent: makeContinuableParent(), signal: undefined }
    );
    assert.equal(out.kind, 'continuable');
    assertHasSkeleton(captured.request.persona, 'continuable request.persona');
    assert.equal(captured.request.descriptor, undefined, 'descriptor 不触碰：continuable request.descriptor 必须保持未设');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- 既有 persona 追加：不覆盖原文 ----------------------------------------------

test('envelope:true + 既有 persona → 骨架以空行衔接追加、不覆盖原文', async () => {
  const iso = makeIsolatedDshHome();
  try {
    let captured;
    const subagentsStart = async (_provider, request) => {
      captured = request;
      return { result: { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }, dispose: async () => {} };
    };
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    await tool.execute(
      { prompt: 'task', envelope: true, persona: 'BASE-PERSONA' },
      { agent: makeForegroundParent(), signal: undefined }
    );
    assert.ok(captured.persona.startsWith('BASE-PERSONA\n\n完成前按以下骨架输出'), '既有 persona 必须保留在骨架之前');
    assertHasSkeleton(captured.persona, 'request.persona');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- 默认（无 envelope）：行为不变 -----------------------------------------------

test('默认（无 envelope）→ 不注入骨架、剪枝照常', async () => {
  const iso = makeIsolatedDshHome();
  try {
    let captured;
    const pruneCalls = [];
    const pruner = {
      pruneContent(blocks) {
        pruneCalls.push(blocks);
        return [{ type: 'text', text: 'PRUNED' }];
      }
    };
    const subagentsStart = async (_provider, request) => {
      captured = request;
      return { result: { stopReason: 'completed', output: [{ type: 'text', text: 'LONG' }] }, dispose: async () => {} };
    };
    const { ctx, records } = createFakeCtx({ services: { toolResultPruner: pruner }, subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    assert.equal(captured.persona, undefined, '无 envelope 且未设 persona → 不注入信封骨架');
    assert.equal(pruneCalls.length, 1, '剪枝照常：pruneContent 仍被调用一次');
    assert.equal(out.output, 'PRUNED', '剪枝照常：输出为裁剪结果');
  } finally { iso.restore(); iso.teardown(); }
});
