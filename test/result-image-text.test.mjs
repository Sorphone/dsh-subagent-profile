// test/result-image-text.test.mjs — 结果行回显生效画像 imageText：
//   三分支（foreground/background/continuable）都携带 imageText；有 profile →
//   `方案 X；provider/model 或继承父；档位 Y`；无 profile → `继承父方案；…`。
//   schema 三分支共享 imageText 键；presentationMeta 把 imageText 投影进卡片。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCH_OUTPUT_SCHEMA, imageTextOf } from '../lib/core/dispatch-schema.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

function makeLlm() {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    resolveCallConfig: async () => ({}),
  };
}

function makeParent({ provider = 'pp', model = 'mm' } = {}) {
  const llm = makeLlm();
  return {
    ctx: {
      get: (name) => (name === 'llm' ? llm : undefined),
      tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
    },
    options: { provider, model },
  };
}

function registerProfile(records) {
  const service = records.provides.find((p) => p.name === 'subagent-profiles')?.service;
  service.register({ id: 'ptest', name: 'PT', description: '写代码与测试场景的方案', provider: 'p1', model: 'm1', tokenTier: 'cheap' });
}

async function setupApp({ subagentsStart, startContinuable, jobs } = {}) {
  const iso = makeIsolatedDshHome();
  const services = { ...(jobs !== undefined ? { jobs } : {}) };
  const { ctx, records } = createFakeCtx({ services, subagentsStart, startContinuable });
  await mod.apply(ctx);
  registerProfile(records);
  const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
  return { iso, records, tool };
}

// ---- imageTextOf 纯函数：两态 -----------------------------------------------------------

test('imageTextOf：有 profile → 方案 X；provider/model；档位 Y；继承父路由 → 继承父', () => {
  assert.equal(imageTextOf({ profile: 'ptest', provider: 'p1', model: 'm1', tokenTier: 'cheap' }), '方案 ptest；p1/m1；档位 cheap');
  assert.equal(imageTextOf({ profile: 'ptest', provider: '(parent)', model: '(parent)', tokenTier: 'balanced' }), '方案 ptest；继承父；档位 balanced');
});

test('imageTextOf：无 profile（含 inline）→ 继承父方案；provider/model；档位（缺省 balanced）', () => {
  assert.equal(imageTextOf({ profile: '(inline)', provider: 'pp', model: 'mm', tokenTier: 'premium' }), '继承父方案；pp/mm；档位 premium');
  assert.equal(imageTextOf({ profile: undefined, provider: '(parent)', model: '(parent)' }), '继承父方案；(parent)/(parent)；档位 balanced');
});

test('schema：三分支共享 imageText(string) 键', () => {
  for (const branch of DISPATCH_OUTPUT_SCHEMA.oneOf) {
    assert.equal(branch.properties.imageText.type, 'string', '每个分支必须声明 imageText(string)');
  }
});

// ---- 三分支执行：imageText 填充 ---------------------------------------------------------

test('foreground 有 profile：imageText = 方案 ptest；p1/m1；档位 cheap，presentationMeta 投影', async () => {
  const subagentsStart = async () => ({
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
    dispose: async () => {},
  });
  const { iso, tool } = await setupApp({ subagentsStart });
  try {
    const out = await tool.execute({ prompt: 'task', profile: 'ptest' }, { agent: makeParent(), signal: undefined });
    assert.equal(out.imageText, '方案 ptest；p1/m1；档位 cheap');
    const meta = tool.output.presentationMeta({}, out);
    assert.equal(meta.imageText, out.imageText, 'imageText 必须随 presentationMeta 投影');
    assert.ok(meta.gates, '决策轨迹键保留');
  } finally { iso.restore(); iso.teardown(); }
});

test('foreground 无 profile：imageText = 继承父方案；pp/mm；档位 balanced', async () => {
  const subagentsStart = async () => ({
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
    dispose: async () => {},
  });
  const { iso, tool } = await setupApp({ subagentsStart });
  try {
    const out = await tool.execute({ prompt: 'task' }, { agent: makeParent(), signal: undefined });
    assert.equal(out.imageText, '继承父方案；pp/mm；档位 balanced');
  } finally { iso.restore(); iso.teardown(); }
});

test('background 有 profile：imageText = 方案 ptest；p1/m1；档位 cheap', async () => {
  const jobs = { start: () => 'job-1' };
  const { iso, tool } = await setupApp({ jobs });
  try {
    const out = await tool.execute({ prompt: 'task', profile: 'ptest', run_in_background: true }, { agent: makeParent(), signal: undefined });
    assert.equal(out.kind, 'background');
    assert.equal(out.imageText, '方案 ptest；p1/m1；档位 cheap');
  } finally { iso.restore(); iso.teardown(); }
});

test('continuable 有 profile：imageText = 方案 ptest；p1/m1；档位 cheap（ignored 语义不变）', async () => {
  const startContinuable = async () => ({ childId: 'child-1' });
  const { iso, tool } = await setupApp({ startContinuable });
  try {
    const out = await tool.execute({ prompt: 'task', profile: 'ptest', continuable: true }, { agent: makeParent(), signal: undefined });
    assert.equal(out.kind, 'continuable');
    assert.equal(out.imageText, '方案 ptest；p1/m1；档位 cheap');
    assert.deepEqual(out.ignored, ['preset', 'reasoningEffort']);
  } finally { iso.restore(); iso.teardown(); }
});

test('continuable 无 profile：imageText = 继承父方案；pp/mm；档位 balanced', async () => {
  const startContinuable = async () => ({ childId: 'child-2' });
  const { iso, tool } = await setupApp({ startContinuable });
  try {
    const out = await tool.execute({ prompt: 'task', continuable: true }, { agent: makeParent(), signal: undefined });
    assert.equal(out.imageText, '继承父方案；pp/mm；档位 balanced');
  } finally { iso.restore(); iso.teardown(); }
});
