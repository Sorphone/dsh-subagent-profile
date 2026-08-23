// test/escape-hatch.test.mjs — 逃生舱 opt-in（默认关）全链路。
//   * resolveWhitelist：escapeSet 只叠加（去重、不替代 base；rosterless 叠加回退名单）。
//   * escape store：evolution-escape.json 原子写 + 损坏/形状不符 fail-soft 空集。
//   * 放行审计：recordGovernanceAudit 追加成功 / 写失败降级 health + lostGovernance。
//   * 派发接线：默认关非 system fail-loud；开 + 成员 + 三道闸全过才放行；开 + 非成员
//     恒拒；开 + 成员 + 成本闸失败仍拒（且不写审计）；放行写 governance-audit.jsonl。
//   * 路由：/set-escape /escape-add /escape-remove + summary 字段 + 拒绝 system 预设。
//   * 设置页代码审查：ZH.escapeWarn 键 + 精确文案 + 开关接线。
// 隔离 DSH_HOME（makeIsolatedDshHome）避免触碰真实 ~/.dsh。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWhitelist, FALLBACK_WHITELIST } from '../lib/core/whitelist.mjs';
import { createEscapeStore, escapeGatesSnapshot, recordEscapeAllowProvider } from '../lib/core/escape.mjs';
import { createEvolutionLedger } from '../lib/core/evolution-ledger.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

// --- 纯函数：resolveWhitelist 叠加 -------------------------------------------------

test('resolveWhitelist：escapeSet 只叠加（去重、不替代 base、空集零叠加）', async () => {
  const agentPresets = { list: async () => [
    { id: 'standard', trust: 'system' },
    { id: 'code', trust: 'system' },
    { id: 'custom', trust: 'user' },
  ] };
  assert.deepEqual(await resolveWhitelist(agentPresets), ['standard', 'code']);
  assert.deepEqual(await resolveWhitelist(agentPresets, ['custom']), ['standard', 'code', 'custom']);
  assert.deepEqual(await resolveWhitelist(agentPresets, new Set(['standard', 'custom'])), ['standard', 'code', 'custom'], 'escape 含 base 成员时去重');
  assert.deepEqual(await resolveWhitelist(agentPresets, []), ['standard', 'code'], '空 escape 零叠加');
  assert.deepEqual(await resolveWhitelist(agentPresets, undefined), ['standard', 'code'], '缺省 escape 零叠加');
});

test('resolveWhitelist：rosterless（agentPresets undefined）叠加回退名单', async () => {
  assert.deepEqual(await resolveWhitelist(undefined), FALLBACK_WHITELIST);
  assert.deepEqual(await resolveWhitelist(undefined, ['custom']), [...FALLBACK_WHITELIST, 'custom']);
});

// --- 纯函数：escape store + 快照 ---------------------------------------------------

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-escape-'));
  return {
    dir,
    escapeFile: join(dir, 'subagent-evolution', 'evolution-escape.json'),
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

test('escape store：add 落盘 + 新实例重载保持 + remove 清空', () => {
  const t = tmpHome();
  try {
    const a = createEscapeStore({ dshHome: t.dir, logger: { warn: () => {} } });
    assert.deepEqual(a.list(), []);
    a.add('custom');
    assert.deepEqual(a.list(), ['custom']);
    const parsed = JSON.parse(readFileSync(t.escapeFile, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.presets, ['custom']);
    const b = createEscapeStore({ dshHome: t.dir, logger: { warn: () => {} } });
    assert.deepEqual(b.list(), ['custom'], '新实例同 dshHome 加载保持');
    b.remove('custom');
    assert.deepEqual(b.list(), []);
  } finally { t.cleanup(); }
});

test('escape store：损坏/形状不符文件 fail-soft 空集（不 throw、warn）', () => {
  const t = tmpHome();
  try {
    mkdirSync(join(t.dir, 'subagent-evolution'), { recursive: true });
    writeFileSync(t.escapeFile, '{ not json', 'utf8');
    const warns = [];
    const a = createEscapeStore({ dshHome: t.dir, logger: { warn: (m) => warns.push(m) } });
    assert.deepEqual(a.list(), [], '损坏文件按空集处理');
    assert.ok(warns.some((m) => m.includes('损坏')), '损坏必须 warn');
    writeFileSync(t.escapeFile, JSON.stringify({ version: 2, presets: ['x'] }), 'utf8');
    const b = createEscapeStore({ dshHome: t.dir, logger: { warn: () => {} } });
    assert.deepEqual(b.list(), [], '版本不符按空集处理');
  } finally { t.cleanup(); }
});

test('escapeGatesSnapshot：抽取 whitelist/cost/intersection/approval verdict', () => {
  const trace = { gates: [
    { name: 'whitelist', verdict: 'pass', output: {} },
    { name: 'cost', verdict: 'pass', output: { checks: [{ field: 'maxTokens', verdict: 'pass' }, { field: 'llm', verdict: 'pass' }] } },
    { name: 'intersection', verdict: 'pass', output: {} },
    { name: 'approval', verdict: 'pass', output: {} },
    { name: 'budget', verdict: 'pass', output: {} },
  ] };
  const snap = escapeGatesSnapshot(trace);
  assert.equal(snap.whitelist, 'pass');
  assert.equal(snap.cost.verdict, 'pass');
  assert.deepEqual(snap.cost.checks, [{ field: 'maxTokens', verdict: 'pass' }, { field: 'llm', verdict: 'pass' }]);
  assert.equal(snap.intersection, 'pass');
  assert.equal(snap.approval, 'pass');
  assert.equal(snap.budget, undefined, 'budget 不进快照（三道闸口径）');
});

test('recordEscapeAllowProvider：provider 渠道放行写治理审计（快照为 provider 口径）', () => {
  const events = [];
  const evoLedger = { recordGovernanceAudit: (entry) => events.push(entry) };
  recordEscapeAllowProvider(evoLedger, { session: { header: { id: 'parent-p' } } }, 'custom-preset');
  assert.equal(events.length, 1, '放行必写审计');
  const event = events[0];
  assert.equal(event.kind, 'escape-allow-provider');
  assert.equal(event.preset, 'custom-preset');
  assert.equal(event.session_id, 'parent-p');
  assert.deepEqual(event.gates_snapshot, { whitelist: 'pass', cost: 'pass', intersection: 'deferred', approval: 'never' });
});

// --- 放行审计：recordGovernanceAudit ----------------------------------------------

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

test('recordGovernanceAudit：追加一行（v/ts/kind 透传），写失败降级 health + lostGovernance', () => {
  const t = tmpHome();
  try {
    const a = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: () => {} });
    a.recordGovernanceAudit({ kind: 'escape-allow', preset: 'p', session_id: null, gates_snapshot: {} });
    const rows = readJsonl(join(t.dir, 'subagent-evolution', 'governance-audit.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].v, 1);
    assert.equal(typeof rows[0].ts, 'number');
    assert.equal(rows[0].kind, 'escape-allow');
    assert.equal(rows[0].preset, 'p');
    assert.deepEqual(a.auditState(), { lostTelemetry: 0, lostGovernance: 0, health: 'ok' }, '写成功不降级');
  } finally { t.cleanup(); }
});

test('recordGovernanceAudit：写失败 fail-soft 降级（health degraded + lostGovernance +1，不 throw）', () => {
  const t = tmpHome();
  try {
    writeFileSync(join(t.dir, 'subagent-evolution'), 'blocker', 'utf8');
    const warns = [];
    const a = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: (m) => warns.push(m) });
    assert.doesNotThrow(() => a.recordGovernanceAudit({ kind: 'escape-allow', preset: 'p', session_id: null, gates_snapshot: {} }));
    assert.equal(a.auditState().health, 'degraded', '审计写失败 health 置 degraded');
    assert.equal(a.auditState().lostGovernance, 1);
    assert.ok(warns.some((m) => m.includes('治理审计事件写入失败')), '审计写失败必须 warn');
  } finally { t.cleanup(); }
});

// --- 派发接线 ---------------------------------------------------------------------

function dispatchTool(records) {
  const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
  assert.ok(tool, 'apply() 必须注册 dispatch 工具');
  return tool;
}

function foregroundParent() {
  return { ctx: { get: () => undefined }, options: {}, session: { header: { id: 'parent-esc' } } };
}

const completedStart = async () => ({
  id: 'child-esc',
  result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
  localAgent: { session: { events: [] } },
  dispose: async () => {},
});

async function setupApp(opts = {}) {
  const { webServer, routes } = makeRouteHarness();
  const ctxOpts = { services: { webServer } };
  if (opts.subagentsStart !== undefined) ctxOpts.subagentsStart = opts.subagentsStart;
  if (opts.services !== undefined) ctxOpts.services = { ...ctxOpts.services, ...opts.services };
  const { ctx, records } = createFakeCtx(ctxOpts);
  await mod.apply(ctx);
  return { handler: routes[0].handler, records };
}

async function enableEscapeMember(handler, preset) {
  const on = await callRoute(handler, 'POST', '/set-escape', { enabled: true });
  assert.equal(on.code, 200);
  assert.equal(on.json.escapeEnabled, true);
  const add = await callRoute(handler, 'POST', '/escape-add', { preset });
  assert.equal(add.code, 200);
  assert.equal(add.json.persisted, true);
  assert.deepEqual(add.json.presets, [preset]);
}

test('逃生舱默认关：非 system 预设 fail-loud（不被放行）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { records } = await setupApp({ subagentsStart: completedStart });
    const tool = dispatchTool(records);
    await assert.rejects(
      () => tool.execute({ prompt: 'task', preset: 'custom-preset' }, { agent: foregroundParent(), signal: undefined }),
      /不在 system-trust 白名单/
    );
  } finally { iso.restore(); iso.teardown(); }
});

test('逃生舱开 + 成员 + 三道闸全过 → 放行', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler, records } = await setupApp({ subagentsStart: completedStart });
    await enableEscapeMember(handler, 'custom-preset');
    const tool = dispatchTool(records);
    const out = await tool.execute({ prompt: 'task', preset: 'custom-preset' }, { agent: foregroundParent(), signal: undefined });
    assert.equal(out.stopReason, 'completed');
    assert.equal(out.preset, 'custom-preset');
  } finally { iso.restore(); iso.teardown(); }
});

test('逃生舱开 + 非成员 → 恒拒（即便开关开）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler, records } = await setupApp({ subagentsStart: completedStart });
    await enableEscapeMember(handler, 'custom-preset');
    const tool = dispatchTool(records);
    await assert.rejects(
      () => tool.execute({ prompt: 'task', preset: 'other-preset' }, { agent: foregroundParent(), signal: undefined }),
      /不在 system-trust 白名单/
    );
  } finally { iso.restore(); iso.teardown(); }
});

test('逃生舱开 + 成员 + 成本闸失败 → 拒（且不写放行审计）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler, records } = await setupApp({ subagentsStart: completedStart });
    await enableEscapeMember(handler, 'custom-preset');
    const tool = dispatchTool(records);
    await assert.rejects(
      () => tool.execute({ prompt: 'task', preset: 'custom-preset', model: 'nonexistent' }, { agent: foregroundParent(), signal: undefined }),
      /模型能力不可验证/
    );
    assert.ok(!existsSync(join(iso.dir, 'subagent-evolution', 'governance-audit.jsonl')), '成本闸失败不写放行审计');
  } finally { iso.restore(); iso.teardown(); }
});

test('放行写治理审计事件：governance-audit.jsonl 含三道闸快照', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler, records } = await setupApp({ subagentsStart: completedStart });
    await enableEscapeMember(handler, 'custom-preset');
    const tool = dispatchTool(records);
    await tool.execute({ prompt: 'task', preset: 'custom-preset' }, { agent: foregroundParent(), signal: undefined });
    const rows = readJsonl(join(iso.dir, 'subagent-evolution', 'governance-audit.jsonl'));
    assert.equal(rows.length, 1, '每个放行恰产生一条审计事件');
    const event = rows[0];
    assert.equal(event.v, 1);
    assert.equal(typeof event.ts, 'number');
    assert.equal(event.kind, 'escape-allow');
    assert.equal(event.preset, 'custom-preset');
    assert.equal(event.session_id, 'parent-esc');
    const snap = event.gates_snapshot;
    assert.equal(snap.whitelist, 'pass');
    assert.equal(snap.cost.verdict, 'pass');
    assert.ok(Array.isArray(snap.cost.checks) && snap.cost.checks.length >= 2, 'cost 快照含三项检查 verdict');
    assert.ok(snap.cost.checks.every((c) => c.verdict === 'pass'), '成本闸三项检查全 pass');
    assert.equal(snap.intersection, 'pass');
    assert.equal(snap.approval, 'pass');
  } finally { iso.restore(); iso.teardown(); }
});

// --- 路由 -------------------------------------------------------------------------

test('路由 /set-escape：开关持久化到 state.json（默认 false）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler } = await setupApp();
    const off = await callRoute(handler, 'GET', '/options/summary');
    assert.equal(off.json.escapeEnabled, false);
    assert.deepEqual(off.json.escapePresets, []);
    const on = await callRoute(handler, 'POST', '/set-escape', { enabled: true });
    assert.equal(on.code, 200);
    assert.equal(on.json.escapeEnabled, true);
    const state = JSON.parse(readFileSync(join(iso.dir, 'subagent-profiles.state.json'), 'utf8'));
    assert.equal(state.escapeEnabled, true, '开关落盘 state.json');
  } finally { iso.restore(); iso.teardown(); }
});

test('路由 /escape-add + /escape-remove：放行集增删 + 非法 preset 400', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler } = await setupApp();
    const add = await callRoute(handler, 'POST', '/escape-add', { preset: 'custom' });
    assert.equal(add.code, 200);
    assert.equal(add.json.persisted, true);
    assert.deepEqual(add.json.presets, ['custom']);
    const summary = await callRoute(handler, 'GET', '/options/summary');
    assert.deepEqual(summary.json.escapePresets, ['custom']);
    const rm = await callRoute(handler, 'POST', '/escape-remove', { preset: 'custom' });
    assert.equal(rm.code, 200);
    assert.deepEqual(rm.json.presets, []);
    const bad = await callRoute(handler, 'POST', '/escape-add', { preset: '   ' });
    assert.equal(bad.code, 400);
  } finally { iso.restore(); iso.teardown(); }
});

test('路由 /escape-add：拒绝已 system-trust 的预设', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const agentPresets = { list: async () => [{ id: 'standard', trust: 'system', name: 'standard' }] };
    const { handler } = await setupApp({ services: { agentPresets } });
    const resp = await callRoute(handler, 'POST', '/escape-add', { preset: 'standard' });
    assert.equal(resp.code, 400);
    assert.match(resp.json.error, /已是 system-trust/);
  } finally { iso.restore(); iso.teardown(); }
});

// --- 设置页代码审查 ----------------------------------------------------------------

test('设置页代码审查：ZH.escapeWarn 键存在且文案精确 + 逃生舱开关接线', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('escapeWarn'), 'client 必须含 escapeWarn ZH 键');
  const exact = '逃生舱已开启：允许派发非 system-trust 预设。风险自负——其余三道安全闸仍全量生效，每个放行都会留审计记录。';
  assert.ok(src.includes(exact), 'escapeWarn 文案必须与规格精确一致');
  assert.ok(src.includes('/set-escape'), 'client 必须调用 /set-escape');
  assert.ok(src.includes('escapeEnabled'), 'client 必须维护 escapeEnabled 状态');
  assert.ok(src.includes('escapeTitle'), 'client 必须含逃生舱标题');
});
