// test/characterization.test.mjs — snapshot of `apply(ctx)` behavior.
//
// This is a CHARACTERIZATION test: it locks the current observable apply-time
// wiring so later slices can regress-check against it. It is a snapshot, not a
// full simulation — provider.start / dispatch execute are explicitly not
// exercised, and `agents.create` is asserted to be
// never touched. See test/README.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

// Isolate ~/.dsh BEFORE importing/apply: index.mjs's dshHome() reads
// process.env.DSH_HOME at call time, so pointing it at a fresh tmp dir keeps
// the preset self-install + profile load away from the real home.
const iso = makeIsolatedDshHome();
process.on('exit', () => { iso.restore(); iso.teardown(); });

const mod = await import('../index.mjs');

test('module top-level: name + inject surface is the shipped bundle contract', () => {
  assert.equal(mod.name, 'dsh-subagent-profile');
  assert.deepEqual(mod.inject, ['subagents', 'tools', 'agents']);
  assert.equal(typeof mod.apply, 'function');
});

test('DSH_HOME isolation: apply() runs against a temp dir, not the real ~/.dsh', async () => {
  const { ctx } = createFakeCtx();
  await mod.apply(ctx);
  assert.equal(process.env.DSH_HOME, iso.dir, 'process.env.DSH_HOME must be the isolated temp dir during apply');
  // The preset self-install writes into ${DSH_HOME}/.agent-presets; its
  // presence proves apply() routed its side effects through the isolated home.
  assert.ok(existsSync(join(iso.dir, '.agent-presets')), 'preset sync must write into the isolated DSH home');
  // The profile store path is dshHome()/subagent-profiles.json; nothing wrote a
  // persisted file at apply time, so it must still be absent in the isolated dir.
  assert.ok(!existsSync(join(iso.dir, 'subagent-profiles.json')), 'no persisted profiles file should exist after a bare apply()');
});

test('subagents.registerProvider: called once with the profile provider contract', async () => {
  const { ctx, records } = createFakeCtx();
  await mod.apply(ctx);

  assert.equal(records.registerProviderCalls.length, 1, 'registerProvider must be called exactly once at apply time');
  const provider = records.registerProviderCalls[0];
  assert.equal(provider.name, 'profile');
  // capabilities carry four fields; inheritsParentContext is a sibling.
  assert.deepEqual(provider.capabilities, { outputSchema: false, depthLimit: true, toolFilter: true, persona: true });
  assert.equal(provider.inheritsParentContext, false);
  assert.equal(typeof provider.start, 'function', 'provider.start must be a function');
  assert.equal(typeof provider.prepareContinuable, 'function');
});

test('tools.register: registers dispatch + profiles_query while enabled', async () => {
  const { ctx, records } = createFakeCtx();
  await mod.apply(ctx);

  assert.equal(records.registerToolCalls.length, 2, 'enabled 时注册 dispatch 与 profiles_query 两个工具');
  const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
  assert.ok(tool, 'dispatch tool must be registered');
  assert.equal(typeof tool.execute, 'function');
  // defineTool normalizes `parameters` into a JSON-schema object:
  // { type, properties, required }. `prompt.required: true` in the spec
  // becomes an entry in the top-level `required` array.
  assert.equal(tool.parameters.type, 'object');
  assert.equal(typeof tool.parameters.properties.prompt, 'object');
  assert.ok(Array.isArray(tool.parameters.required));
  assert.ok(tool.parameters.required.includes('prompt'), 'prompt must be a required parameter');
  assert.equal(tool.parameters.properties.profile?.type, 'string');
  assert.ok(tool.output && Array.isArray(tool.output.schema.oneOf), 'output schema must declare a oneOf closure');
  // profiles_query：入参全可选（无 required），输出闭合对象。
  const queryTool = records.registerToolCalls.find((t) => t.name === 'profiles_query');
  assert.ok(queryTool, 'profiles_query tool must be registered');
  assert.equal(typeof queryTool.execute, 'function');
  assert.equal(queryTool.parameters.type, 'object');
  for (const key of ['id', 'tier', 'provider', 'model']) {
    assert.ok(queryTool.parameters.properties[key], `profiles_query 参数 ${key} 必须声明`);
  }
  assert.ok(queryTool.parameters.required === undefined || queryTool.parameters.required.length === 0, 'profiles_query 入参全可选');
});

test('provide("subagent-profiles"): register/get/list/resolve are all functions', async () => {
  const { ctx, records } = createFakeCtx();
  await mod.apply(ctx);

  const provided = records.provides.find((p) => p.name === 'subagent-profiles');
  assert.ok(provided, 'apply() must provide the subagent-profiles service');
  assert.ok(provided.service, 'service must be delivered as the provide() payload');
  // Service methods are closures over apply()'s internal store — assert they
  // exist and respond.
  for (const method of ['register', 'get', 'list', 'resolve']) {
    assert.equal(typeof provided.service[method], 'function', `subagent-profiles.${method} must be a function`);
  }
  assert.ok(Array.isArray(provided.service.list()), 'subagent-profiles.list() must return an array');
  assert.equal(provided.service.get('swap-standard')?.id, 'swap-standard', 'subagent-profiles.get() must resolve a builtin seed');
});

test('systemPrompt.section: registers dispatch:profiles and orchestrator:mode', async () => {
  // gate: dispatch:profiles 按「能力」判据（schemas 含 dispatch 即注入），
  // orchestrator:mode 按「模式」判据（composedPreset === 'orchestrator-v2'）。
  // 快照提供 composedPreset 桩返回 'orchestrator-v2' + 缺省 dispatch-capable
  // toolSchemas，开箱 apply() 注册的两段均非空。
  const { ctx, records } = createFakeCtx({ services: { agentPresets: { composedPreset: () => 'orchestrator-v2' } } });
  await mod.apply(ctx);

  const profiles = records.sectionCalls.find((s) => s.name === 'dispatch:profiles');
  assert.ok(profiles, 'systemPrompt.section must register dispatch:profiles');
  assert.equal(profiles.order, 116.5);
  assert.equal(typeof profiles.text, 'function');
  const text = profiles.text({ agent: {} });
  assert.ok(text.length > 0, 'dispatch:profiles text() must be non-empty when enabled + dispatch-capable');
  assert.match(text, /Available dispatch profiles/);
  // 瘦身：目录行只含 id + 描述 + tier（无成本/成功率列）；note 一行查表式。
  assert.match(text, /swap-standard: "写代码与重构场景：切换到 standard 预设的完整编码工具集，适合多文件改动、修复与测试；当父会话不是 standard、但子任务需要完整编码能力时选用。" \(tier: balanced\)/);
  assert.match(text, /researcher: "调研与汇总场景：关闭深度推理省 token，继承父工具；适合查资料、检索、背景调研与只读分析，不适合改代码。" \(tier: cheap\)/);
  assert.doesNotMatch(text, /平均|成功率|preset: |model: /, '目录行不得含成本/成功率/preset/model 列');
  assert.match(text, /profiles_query/, 'note 必须指向 profiles_query 下钻');
  assert.match(text, /1-2 步可自查的小事直接做别派/, 'note 一行行为规则保留');

  const orchestrator = records.sectionCalls.find((s) => s.name === 'orchestrator:mode');
  assert.ok(orchestrator, 'systemPrompt.section must register orchestrator:mode');
  assert.equal(orchestrator.order, 117);
  assert.equal(typeof orchestrator.text, 'function');
  const orchestratorText = orchestrator.text({ agent: {} });
  assert.ok(orchestratorText.length > 0, 'orchestrator:mode text must be non-empty when enabled + orchestrator-v2');
});

test('systemPrompt.section: profiles 段按能力注入（非 orchestrator-v2 亦可），编排段仍 orchestrator-v2-only', async () => {
  const { ctx, records } = createFakeCtx({ services: { agentPresets: { composedPreset: () => 'standard' } } });
  await mod.apply(ctx);

  const profiles = records.sectionCalls.find((s) => s.name === 'dispatch:profiles');
  assert.ok(profiles.text({ agent: {} }).length > 0, 'schemas 含 dispatch → profiles 段注入（与预设无关）');
  const orchestrator = records.sectionCalls.find((s) => s.name === 'orchestrator:mode');
  assert.equal(orchestrator.text({ agent: {} }), '', '非 orchestrator-v2 → orchestrator:mode 空');
});

test('agents.create is never touched at apply time', async () => {
  const { ctx, records } = createFakeCtx();
  await mod.apply(ctx);
  assert.equal(records.agentCreateCalls, 0, 'apply() must not reach ctx.agents.create');
  const provided = records.provides.find((p) => p.name === 'subagent-profiles');
  assert.ok(provided && typeof provided.service.register === 'function', 'sanity: apply() completed and wired the service');
});

test('contract: webServer.register records its config and returns a callable disposer', () => {
  const { ctx, records } = createFakeCtx();
  const webServer = ctx.get('webServer');
  assert.equal(typeof webServer.register, 'function');
  const dispose = webServer.register({ kind: 'prefix', path: '/probe', handler() {} });
  assert.equal(typeof dispose, 'function', 'webServer.register must return a callable disposer');
  assert.equal(records.webServerRegisterCalls.length, 1);
  assert.equal(records.webServerRegisterCalls[0].path, '/probe');
  assert.doesNotThrow(() => dispose());
});

test('contract: tools.register records the tool and returns a callable disposer', () => {
  const { ctx, records } = createFakeCtx();
  assert.equal(typeof ctx.tools.register, 'function');
  const dispose = ctx.tools.register({ name: 'probe', execute() {} });
  assert.equal(typeof dispose, 'function', 'tools.register must return a callable disposer');
  assert.equal(records.registerToolCalls.length, 1);
  assert.equal(records.registerToolCalls[0].name, 'probe');
  assert.doesNotThrow(() => dispose());
});

test('contract: tools.schemas returns an array (for the tools directory surface)', () => {
  const { ctx, records } = createFakeCtx();
  assert.ok(Array.isArray(ctx.tools.schemas()));
  assert.ok(Array.isArray(ctx.tools.schemas({})));
  assert.equal(records.schemaCalls.length, 2);
});
