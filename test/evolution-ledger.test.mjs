// test/evolution-ledger.test.mjs — 派发台账（dispatch.jsonl）全链路。
//   * 纯工厂：appendFileSync 追加不可变（再写一行既有行字节不变）、写失败仅
//     warn + 丢失计数、不 throw。
//   * 指纹：task.structure / persona_fp / toolFilter_fp 为确定性结构指纹，绝不含
//     prompt/persona/toolFilter 原文。
//   * execute 级：foreground 全字段 + outcome；continuable requested.preset(swap) vs
//     effective.preset('inherit') 且无 outcome；后台结算写 outcome；闸 fail（未启动
//     、child 未创建）不写台账。
// 隔离 DSH_HOME（makeIsolatedDshHome）避免触碰真实 ~/.dsh。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvolutionLedger } from '../lib/core/evolution-ledger.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// 台账记录的 plugin_version 与包版本同源（readPluginVersion），断言动态读取，
// 版本号 bump 时不再需要同步改测试。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const PKG_VERSION = pkg.version;

// --- 纯工厂：临时目录下的 createEvolutionLedger ---------------------------------

function tmpLedgerDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-evo-ledger-'));
  return {
    dir,
    file: join(dir, 'subagent-evolution', 'dispatch.jsonl'),
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

function readRecords(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test('工厂 record：追加一行，v=1、ts=epoch ms，JSONL 每行一条', () => {
  const t = tmpLedgerDir();
  try {
    const ledger = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: () => {} });
    ledger.record({ child_id: 'c1', mode: 'continuable' });
    const lines = readFileSync(t.file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.v, 1);
    assert.equal(typeof parsed.ts, 'number');
    assert.equal(parsed.child_id, 'c1');
  } finally { t.cleanup(); }
});

test('append-only：再写一行后，既有行字节不变', () => {
  const t = tmpLedgerDir();
  try {
    const ledger = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: () => {} });
    ledger.record({ child_id: 'c1', mode: 'foreground', outcome: { status: 'completed' } });
    const before = readFileSync(t.file, 'utf8');
    const beforeStats = statSync(t.file);
    ledger.record({ child_id: 'c2', mode: 'background', outcome: { status: 'failed' } });
    const after = readFileSync(t.file, 'utf8');
    assert.ok(after.length > before.length, '新行追加使文件变大');
    assert.ok(after.startsWith(before), '既有行字节必须原样保留（追加不可变）');
    assert.equal(beforeStats.size, Buffer.byteLength(before, 'utf8'), '首次写入即完整落盘');
    const records = readRecords(t.file);
    assert.deepEqual(records.map((r) => r.child_id), ['c1', 'c2']);
  } finally { t.cleanup(); }
});

test('写失败：台账子目录被文件占据 → record 不 throw、warn、丢失计数 +1，重复失败累计', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evo-ledger-'));
  // 把台账目录路径 pre-create 成普通文件 → mkdirSync recursive 抛 EEXIST → append 不执行。
  writeFileSync(join(root, 'subagent-evolution'), 'a regular file', 'utf8');
  const warns = [];
  try {
    const ledger = createEvolutionLedger({ dshHome: root, pluginVersion: '0.3.2', warn: (m) => warns.push(m) });
    assert.doesNotThrow(() => ledger.record({ child_id: 'c1', mode: 'foreground', outcome: { status: 'completed' } }));
    assert.equal(ledger.lostCount(), 1, '首次写失败丢失计数为 1');
    assert.doesNotThrow(() => ledger.record({ child_id: 'c2', mode: 'background', outcome: { status: 'killed' } }));
    assert.equal(ledger.lostCount(), 2, '第二次写失败丢失计数累计为 2');
    assert.ok(!existsSync(join(root, 'subagent-evolution', 'dispatch.jsonl')), '失败时不产生文件');
    assert.equal(warns.length, 2, '每次写失败必须 warn');
    assert.match(warns[0], /派发台账写入失败/);
  } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
});

test('dshHome 缺失 → 工厂构造抛错（配置错配 must-loud，非采集 fail-soft）', () => {
  assert.throws(() => createEvolutionLedger({ pluginVersion: '0.3.2' }), /dshHome/);
});

// --- 指纹：结构指纹绝不含原文（经 execute 记录断言）----------------------------

test('execute 记录：task.structure/persona_fp/toolFilter_fp 为结构指纹，不含 prompt/persona/toolFilter 原文', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      id: 'child-evo-fp',
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: { events: [] } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const promptText = 'THIS-IS-PROMPT-SECRET';
    const personaText = 'THIS-IS-PERSONA-SECRET';
    await tool.execute(
      { prompt: promptText, persona: personaText, toolFilter: { allow: ['read'], deny: ['write'] } },
      { agent: foregroundParent(), signal: undefined }
    );
    const [record] = readRecords(join(iso.dir, 'subagent-evolution', 'dispatch.jsonl'));
    const dump = JSON.stringify(record);
    assert.ok(!dump.includes(promptText), '绝不落 prompt 原文');
    assert.ok(!dump.includes(personaText), '绝不落 persona 原文');
    assert.equal(typeof record.task.structure, 'string');
    assert.match(record.task.structure, /^L\d+_/, 'structure 以长度前导');
    assert.match(record.task.structure, /_NL\d+$/, 'structure 含换行数');
    assert.equal(record.requested.persona_present, true);
    assert.match(record.requested.persona_fp, /^L\d+_/, 'persona_fp 为结构指纹');
    assert.ok(!String(record.requested.persona_fp).includes('SECRET'), 'persona_fp 不含 persona 原文');
    assert.equal(record.requested.toolFilter_present, true);
    assert.match(record.requested.toolFilter_fp, /^allow:N\d+_/);
    assert.ok(!String(record.requested.toolFilter_fp).includes('read'), 'toolFilter_fp 不含工具数组原文');
  } finally { iso.restore(); iso.teardown(); }
});

// --- execute 级：经 apply 的 dispatch.execute 路径 ---------------------------------

function dispatchTool(records) {
  const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
  assert.ok(tool, 'apply() 必须注册 dispatch 工具');
  return tool;
}

function foregroundParent() {
  return { ctx: { get: () => undefined }, options: {}, session: { header: { id: 'parent-evo' } } };
}

function continuableParent() {
  const llm = {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    resolveCallConfig: async () => ({}),
  };
  return {
    ctx: { get: (name) => (name === 'llm' ? llm : undefined), tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] } },
    options: {},
    session: { header: { id: 'parent-evo-cont' } },
  };
}

test('execute foreground completed：dispatch.jsonl 追加一条含全 schema 字段与 outcome', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      id: 'child-evo-fg',
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      localAgent: { session: { events: [] } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const out = await tool.execute(
      { prompt: 'do the evo task', preset: 'standard' },
      { agent: foregroundParent(), signal: undefined }
    );
    assert.equal(out.stopReason, 'completed');
    assert.ok(existsSync(join(iso.dir, 'subagent-evolution', 'dispatch.jsonl')), '前台派发后台账落盘');
    const [record] = readRecords(join(iso.dir, 'subagent-evolution', 'dispatch.jsonl'));
    // 全 schema 字段在记录顶层 + task 子对象里（两栏 cfg 各含 8 个子字段）。
    for (const key of ['v', 'ts', 'session_id', 'child_id', 'mode', 'origin', 'requested', 'effective', 'outcome', 'task', 'source', 'provenance', 'plugin_version']) {
      assert.ok(key in record, `record 必须含字段 ${key}`);
    }
    assert.equal(record.v, 1);
    assert.equal(record.session_id, 'parent-evo');
    assert.equal(record.child_id, 'child-evo-fg');
    assert.equal(record.mode, 'foreground');
    assert.equal(record.origin, 'subagent');
    assert.equal(record.source, 'system');
    assert.match(record.provenance, /^dispatch:v\d/);
    assert.equal(record.plugin_version, PKG_VERSION);
    assert.equal(typeof record.ts, 'number');
    // 结构指纹不含 prompt 原文。
    assert.equal(typeof record.task.len, 'number');
    assert.ok(!JSON.stringify(record.task).includes('do the evo task'), 'task 不落 prompt 原文');
    // outcome：status/stop_reason/elapsed_ms/output_len/tool_count。
    assert.equal(record.outcome.status, 'completed');
    assert.equal(record.outcome.stop_reason, 'completed');
    assert.equal(typeof record.outcome.elapsed_ms, 'number');
    assert.equal(typeof record.outcome.output_len, 'number');
    assert.equal(record.outcome.tool_count, null, '无 usage 事件时 tool_count 记 null');
    // 前台（非 continuable）：requested 与 effective 的 preset 一致（无丢弃）。
    assert.equal(record.requested.preset, 'standard');
    assert.equal(record.effective.preset, 'standard');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute continuable：requested.preset(swap) vs effective.preset(inherit)，无 outcome 键', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const startContinuable = async () => ({ childId: 'child-evo-cont' });
    const { ctx, records } = createFakeCtx({ startContinuable });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const out = await tool.execute(
      { prompt: 'evo cont task', continuable: true, preset: 'standard', reasoningEffort: 'high' },
      { agent: continuableParent(), signal: undefined }
    );
    assert.equal(out.kind, 'continuable');
    const [record] = readRecords(join(iso.dir, 'subagent-evolution', 'dispatch.jsonl'));
    assert.equal(record.mode, 'continuable');
    assert.equal(record.child_id, 'child-evo-cont');
    // 双栏拆分：requested 保留 swap 目标，effective 落真实生效值 'inherit'。
    assert.equal(record.requested.preset, 'standard', 'requested.preset=swap 目标');
    assert.equal(record.effective.preset, 'inherit', 'effective.preset=真实生效值');
    assert.equal(record.requested.reasoningEffort, 'high');
    assert.ok(!('outcome' in record), 'continuable 无结算 → 省略 outcome');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute 闸 fail（未启动，child 未创建）：不写台账', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const parent = foregroundParent();
    await assert.rejects(
      () => tool.execute({ prompt: 'bad preset', preset: 'nonexistent' }, { agent: parent, signal: undefined }),
      /不在 system-trust 白名单/
    );
    assert.ok(!existsSync(join(iso.dir, 'subagent-evolution', 'dispatch.jsonl')), '预检闸 fail 不写台账');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute 前台非 completed：仍写 outcome（status=failed），然后抛错', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      id: 'child-evo-fgate',
      result: { stopReason: 'max-tokens', output: [{ type: 'text', text: 'partial out' }] },
      localAgent: { session: { events: [] } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    await assert.rejects(
      () => tool.execute({ prompt: 'evo fails' }, { agent: foregroundParent(), signal: undefined }),
      /token limit/
    );
    const [record] = readRecords(join(iso.dir, 'subagent-evolution', 'dispatch.jsonl'));
    assert.equal(record.mode, 'foreground');
    assert.equal(record.outcome.status, 'failed', '前台非 completed 写 failed');
    assert.equal(record.outcome.stop_reason, 'max-tokens');
    assert.equal(record.outcome.tool_count, null);
    assert.ok(!JSON.stringify(record).includes('partial out'), '失败记录不落子输出原文');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute 后台结算：onSettled 追加一条带 outcome 的记录', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      id: 'child-evo-bg',
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'bg done' }] },
      localAgent: { session: { events: [] } },
      dispose: async () => {},
    });
    let captured;
    const jobs = {
      start(spec) { captured = spec.run(); return 'job-evo-bg'; },
      kill() { return 'requested'; },
    };
    const { ctx, records } = createFakeCtx({ subagentsStart, services: { jobs } });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    const out = await tool.execute(
      { prompt: 'evo bg task', run_in_background: true },
      { agent: foregroundParent(), signal: undefined }
    );
    assert.equal(out.kind, 'background');
    assert.equal(out.jobId, 'job-evo-bg');
    const settled = await captured.done;
    assert.equal(settled.status, 'completed');
    const file = join(iso.dir, 'subagent-evolution', 'dispatch.jsonl');
    assert.ok(existsSync(file), '后台结算后台账落盘');
    const [record] = readRecords(file);
    assert.equal(record.mode, 'background');
    assert.equal(record.child_id, 'job-evo-bg');
    assert.equal(record.outcome.status, 'completed', '后台结算写 outcome');
    assert.equal(record.outcome.stop_reason, 'completed');
    assert.equal(typeof record.outcome.elapsed_ms, 'number');
    assert.equal(typeof record.outcome.output_len, 'number');
    assert.equal(record.outcome.tool_count, null);
    assert.ok(!JSON.stringify(record).includes('bg done'), '后台记录不落子输出原文');
  } finally { iso.restore(); iso.teardown(); }
});
