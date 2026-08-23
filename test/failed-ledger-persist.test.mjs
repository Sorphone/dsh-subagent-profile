// test/failed-ledger-persist.test.mjs — 失败台账落盘（createFailureLedger 可选
// stateFile）：record/take 后全量同步原子落盘、构造时加载（fail-soft），不传
// stateFile 仍是纯内存（行为不变）。覆盖 round-trip、损坏/未知版本/形状不符
// fail-soft、record/take 文件同步、DSH_HOME 隔离下的装配落盘、写失败不 throw。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFailureLedger } from '../lib/core/decision-trace.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// 临时目录 + 落盘文件路径；teardown 递归删除。
function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-failed-ledger-'));
  return {
    dir,
    file: join(dir, 'subagent-profiles.failed-traces.json'),
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

// --- 纯函数层：createFailureLedger + stateFile ---------------------------------

test('round-trip：record 落盘后新实例同 stateFile 加载，get/count 完整', () => {
  const t = tmpStateFile();
  try {
    const a = createFailureLedger({ warn: () => {}, stateFile: t.file });
    a.record('s1', { n: 1, reason: 'boom' });
    a.record('s1', { n: 2 });
    a.record('s2', { n: 3 });
    const b = createFailureLedger({ warn: () => {}, stateFile: t.file });
    assert.deepEqual(b.get('s1'), [{ n: 1, reason: 'boom' }, { n: 2 }]);
    assert.deepEqual(b.get('s2'), [{ n: 3 }]);
    assert.equal(b.count(), 3);
  } finally { t.cleanup(); }
});

test('损坏 JSON：加载 fail-soft 空台账、不 throw、warn', () => {
  const t = tmpStateFile();
  try {
    writeFileSync(t.file, '{ not json', 'utf8');
    const warns = [];
    const ledger = createFailureLedger({ warn: (m) => warns.push(m), stateFile: t.file });
    assert.equal(ledger.count(), 0);
    assert.deepEqual(ledger.get('any'), []);
    assert.ok(warns.length >= 1, '损坏文件必须 warn');
  } finally { t.cleanup(); }
});

test('未知 version：加载 fail-soft 空台账、不 throw、warn', () => {
  const t = tmpStateFile();
  try {
    writeFileSync(t.file, JSON.stringify({ version: 999, sessions: { s1: [{ a: 1 }] } }), 'utf8');
    const warns = [];
    const ledger = createFailureLedger({ warn: (m) => warns.push(m), stateFile: t.file });
    assert.equal(ledger.count(), 0);
    assert.ok(warns.length >= 1, '未知 version 必须 warn');
  } finally { t.cleanup(); }
});

test('形状不符（sessions 为数组 / 值为非数组）：加载 fail-soft 空台账、不 throw', () => {
  const t = tmpStateFile();
  try {
    writeFileSync(t.file, JSON.stringify({ version: 1, sessions: [{ a: 1 }] }), 'utf8');
    const warns = [];
    const ledger = createFailureLedger({ warn: (m) => warns.push(m), stateFile: t.file });
    assert.equal(ledger.count(), 0);
    assert.deepEqual(ledger.get('s1'), []);
    assert.ok(warns.length >= 1, '形状不符必须 warn');
  } finally { t.cleanup(); }
});

test('record 后文件同步：全量 JSON {version:1,sessions}，无 .tmp 残留', () => {
  const t = tmpStateFile();
  try {
    const ledger = createFailureLedger({ warn: () => {}, stateFile: t.file });
    ledger.record('s1', { a: 1 });
    assert.ok(existsSync(t.file), 'record 后必须写出文件');
    assert.ok(!existsSync(`${t.file}.tmp`), '原子写成功后不留 .tmp');
    const parsed = JSON.parse(readFileSync(t.file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.sessions, { s1: [{ a: 1 }] });
  } finally { t.cleanup(); }
});

test('take 后文件同步：删除会话写回，新实例不再读到该会话', () => {
  const t = tmpStateFile();
  try {
    const ledger = createFailureLedger({ warn: () => {}, stateFile: t.file });
    ledger.record('s1', { a: 1 });
    ledger.record('s2', { a: 2 });
    assert.deepEqual(ledger.take('s1'), [{ a: 1 }]);
    const parsed = JSON.parse(readFileSync(t.file, 'utf8'));
    assert.deepEqual(parsed.sessions, { s2: [{ a: 2 }] }, 'take 后文件只含剩余会话');
    const b = createFailureLedger({ warn: () => {}, stateFile: t.file });
    assert.deepEqual(b.get('s1'), []);
    assert.deepEqual(b.get('s2'), [{ a: 2 }]);
  } finally { t.cleanup(); }
});

test('纯内存：不传 stateFile 不写任何文件，record/get 行为不变', () => {
  const t = tmpStateFile();
  try {
    const ledger = createFailureLedger({ warn: () => {} });
    ledger.record('s1', { a: 1 });
    assert.equal(ledger.get('s1').length, 1);
    assert.ok(!existsSync(t.file), '不传 stateFile 不落盘');
    assert.ok(!existsSync(`${t.file}.tmp`), '不传 stateFile 不产生 .tmp');
  } finally { t.cleanup(); }
});

test('写失败：stateFile 父路径为普通文件 → record 不 throw、内存保留、warn', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-failed-ledger-'));
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'x', 'utf8');
  const stateFile = join(blocker, 'failed-traces.json'); // 父路径是文件 → writeFileSync 抛
  const warns = [];
  try {
    const ledger = createFailureLedger({ warn: (m) => warns.push(m), stateFile });
    assert.doesNotThrow(() => ledger.record('s1', { a: 1 }));
    assert.equal(ledger.get('s1').length, 1, '写失败仍保持内存记录');
    assert.ok(warns.length >= 1, '写失败必须 warn');
  } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// --- 装配层：index.mjs 注入 stateFile = join(dshHome(), ...) ---------------------

test('装配：DSH_HOME 隔离下 dispatch 失败落盘到 <home>/subagent-profiles.failed-traces.json，新实例可加载', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    assert.ok(tool, 'apply() 必须注册 dispatch 工具');
    const parent = { ctx: { get: () => undefined }, options: {}, session: { header: { id: 'sess-persist' } } };
    await assert.rejects(
      () => tool.execute({ prompt: 'task', preset: 'nonexistent' }, { agent: parent, signal: undefined }),
      /not in the target-preset whitelist/
    );
    const file = join(iso.dir, 'subagent-profiles.failed-traces.json');
    assert.ok(existsSync(file), '失败台账必须落盘到隔离 DSH_HOME 内');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.sessions['sess-persist']), '该会话失败记录已落盘');
    assert.equal(parsed.sessions['sess-persist'].length, 1);
    const reloaded = createFailureLedger({ warn: () => {}, stateFile: file });
    assert.equal(reloaded.get('sess-persist').length, 1);
    assert.ok(reloaded.get('sess-persist')[0].gates.some((g) => g.name === 'whitelist' && g.verdict === 'fail'));
  } finally { iso.restore(); iso.teardown(); }
});
