// test/evolution-persistence.test.mjs — 版本迁移与台账轮转（持久化机制）。
//   迁移：migrateUp 单步/多级链式/当前版本直通；非法/超前/缺步骤抛 MigrationError。
//   loadWithMigration：迁移后原子写回（tmp rename 后无残留）；未知/超前版本、损坏、
//   形状不符 fail-soft 返回 null + onLoss + warn；文件缺失静默 null 不计丢失。
//   轮转：达阈值封存 dispatch-<seq>-<ts>.jsonl、新建空台账、seq 落盘 ledger.meta.json
//   （缺失时初始化）；封存字节不变、新行只进新文件；超保留上限 FCFS 淘汰最旧且
//   每轮转周期最多提示一次；资产不入 .agent-presets。隔离临时 dshHome，不碰真实 ~/.dsh。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MigrationError,
  migrateUp,
  loadWithMigration,
  rotationNeeded,
  createRotation,
  ROTATION_DEFAULT_MAX_BYTES,
} from '../lib/core/evolution-persistence.mjs';
import { createEvolutionLedger } from '../lib/core/evolution-ledger.mjs';

// 样例迁移表：summaries v1→v2 增补字段；v2→v3 再增补（链式两跳）。
const SAMPLE_TABLE = {
  summaries: {
    1: (d) => ({ ...d, v: 2, upgraded_by_v2: true }),
    2: (d) => ({ ...d, v: 3, upgraded_by_v3: true }),
  },
};

function tmpHome(label = 'dsh-persist-') {
  const dir = mkdtempSync(join(tmpdir(), label));
  return {
    dir,
    evolutionDir: join(dir, 'subagent-evolution'),
    dispatchFile: join(dir, 'subagent-evolution', 'dispatch.jsonl'),
    metaFile: join(dir, 'subagent-evolution', 'ledger.meta.json'),
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}
function archiveNames(dir) {
  return readdirSync(dir).filter((name) => /^dispatch-\d+-\d+(?:-\d+)?\.jsonl$/.test(name));
}
function linesOf(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
}

// --- migrateUp / loadWithMigration ---

test('migrateUp：v1→v2 样例迁移字段变换正确', () => {
  const out = migrateUp({ v: 1, l1: { a: 1 } }, 'summaries', {
    migrations: { summaries: { 1: SAMPLE_TABLE.summaries[1] } },
    currentVersions: { summaries: 2 },
  });
  assert.equal(out.migrated, true);
  assert.equal(out.fromV, 1);
  assert.equal(out.toV, 2);
  assert.equal(out.data.v, 2);
  assert.equal(out.data.upgraded_by_v2, true);
  assert.deepEqual(out.data.l1, { a: 1 });
});

test('migrateUp：多级链式（v1→v3 两跳）与当前版本直通', () => {
  const out = migrateUp({ v: 1 }, 'summaries', {
    migrations: SAMPLE_TABLE,
    currentVersions: { summaries: 3 },
  });
  assert.equal(out.toV, 3);
  assert.equal(out.data.upgraded_by_v2, true);
  assert.equal(out.data.upgraded_by_v3, true);
  assert.equal(out.data.v, 3, '顶层 v 归一为当前版本');
  const same = migrateUp({ v: 1, l1: {} }, 'summaries');
  assert.equal(same.migrated, false);
  assert.equal(same.data.v, 1);
});

test('migrateUp：非法/超前版本、缺步骤、未知资产类型抛 MigrationError', () => {
  assert.throws(() => migrateUp({ v: 0 }, 'summaries'), MigrationError);
  assert.throws(() => migrateUp({}, 'summaries'), MigrationError);
  assert.throws(() => migrateUp({ v: 2 }, 'summaries'), MigrationError);
  assert.throws(() => migrateUp({ v: 1 }, 'nonexistent'), MigrationError);
  assert.throws(
    () => migrateUp({ v: 1 }, 'summaries', { migrations: {}, currentVersions: { summaries: 3 } }),
    (error) => error instanceof MigrationError && error.message.includes('缺少')
  );
});

test('loadWithMigration：v1→v2 迁移后原子写回（tmp rename 后无残留）', () => {
  const t = tmpHome();
  try {
    mkdirSync(t.evolutionDir, { recursive: true });
    const file = join(t.evolutionDir, 'summaries.json');
    writeFileSync(file, JSON.stringify({ v: 1, l1: { a: 1 } }), 'utf8');
    const out = loadWithMigration(file, 'summaries', {
      migrations: { summaries: { 1: SAMPLE_TABLE.summaries[1] } },
      currentVersions: { summaries: 2 },
    });
    assert.equal(out.v, 2);
    assert.equal(out.upgraded_by_v2, true);
    assert.deepEqual(out.l1, { a: 1 }, '既有字段保留');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.v, 2, '迁移结果已写回文件');
    assert.ok(!existsSync(file + '.tmp'), 'tmp 已 rename 消失');
  } finally { t.cleanup(); }
});
test('loadWithMigration：多级链式迁移（v1→v3 两跳）并写回', () => {
  const t = tmpHome();
  try {
    mkdirSync(t.evolutionDir, { recursive: true });
    const file = join(t.evolutionDir, 'summaries.json');
    writeFileSync(file, JSON.stringify({ v: 1, l1: {} }), 'utf8');
    const out = loadWithMigration(file, 'summaries', {
      migrations: SAMPLE_TABLE,
      currentVersions: { summaries: 3 },
    });
    assert.equal(out.v, 3);
    assert.equal(out.upgraded_by_v2, true);
    assert.equal(out.upgraded_by_v3, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).v, 3, '迁移结果原子写回');
  } finally { t.cleanup(); }
});
test('loadWithMigration：v 等于当前版本直通且不重写文件', () => {
  const t = tmpHome();
  try {
    mkdirSync(t.evolutionDir, { recursive: true });
    const file = join(t.evolutionDir, 'summaries.json');
    const payload = JSON.stringify({ v: 1, l1: { a: 1 } });
    writeFileSync(file, payload, 'utf8');
    const out = loadWithMigration(file, 'summaries');
    assert.deepEqual(out, { v: 1, l1: { a: 1 } });
    assert.equal(readFileSync(file, 'utf8'), payload, '无迁移不重写文件');
  } finally { t.cleanup(); }
});
test('loadWithMigration：未知/超前版本、损坏、形状不符 → null + onLoss + warn；缺失静默', () => {
  const t = tmpHome();
  try {
    mkdirSync(t.evolutionDir, { recursive: true });
    const file = join(t.evolutionDir, 'summaries.json');
    const warns = [];
    let losses = 0;
    const opts = { logger: { warn: (m) => warns.push(m) }, onLoss: () => { losses += 1; } };
    writeFileSync(file, JSON.stringify({ v: 2, l1: {} }), 'utf8');
    assert.equal(loadWithMigration(file, 'summaries', opts), null, '超前版本跳过');
    assert.equal(losses, 1);
    assert.ok(warns.some((m) => m.includes('版本')), 'warn 提及版本');
    writeFileSync(file, '{broken', 'utf8');
    assert.equal(loadWithMigration(file, 'summaries', opts), null, '损坏跳过');
    assert.equal(losses, 2);
    writeFileSync(file, '[1,2]', 'utf8');
    assert.equal(loadWithMigration(file, 'summaries', opts), null, '非对象跳过');
    assert.equal(losses, 3);
    writeFileSync(file, JSON.stringify({ v: 'x' }), 'utf8');
    assert.equal(loadWithMigration(file, 'summaries', opts), null, '非法版本跳过');
    assert.equal(losses, 4);
    assert.equal(loadWithMigration(join(t.evolutionDir, 'missing.json'), 'summaries', opts), null, '缺失静默 null');
    assert.equal(losses, 4, '缺失不计丢失');
  } finally { t.cleanup(); }
});

// --- 轮转（rotationNeeded / createRotation / ledger 工厂）---

test('rotationNeeded：记录数/字节数任一超限即触发（恰好等于不触发）', () => {
  assert.equal(rotationNeeded(50000, 1), false);
  assert.equal(rotationNeeded(50001, 1), true);
  assert.equal(rotationNeeded(1, ROTATION_DEFAULT_MAX_BYTES), false);
  assert.equal(rotationNeeded(1, ROTATION_DEFAULT_MAX_BYTES + 1), true);
  assert.equal(rotationNeeded(10, 10, { maxRecords: 10, maxBytes: 10 }), false);
});
test('createRotation：阈值判定 + seq/meta 回调顺序（首轮先初始化 seq0 再落盘 seq1）', () => {
  const t = tmpHome();
  try {
    mkdirSync(t.evolutionDir, { recursive: true });
    writeFileSync(t.dispatchFile, 'line-a\n', 'utf8');
    let seq = 0;
    const events = [];
    const check = createRotation({
      dir: t.evolutionDir,
      dispatchFile: t.dispatchFile,
      getRotationSeq: () => seq,
      setRotationSeq: (next) => { seq = next; },
      initMetaIfMissing: () => events.push(['init', seq]),
      persistMeta: () => events.push(['persist', seq]),
      maxRecords: 1,
      maxBytes: Infinity,
      now: () => 1700000000000,
    });
    assert.deepEqual(check(1, 1), { rotated: false }, '未超阈值不轮转');
    const out = check(2, 1);
    assert.equal(out.rotated, true);
    assert.equal(out.seq, 1);
    assert.equal(out.archived, join(t.evolutionDir, 'dispatch-1-1700000000000.jsonl'));
    assert.equal(out.pruned, 0);
    assert.deepEqual(events, [['init', 0], ['persist', 1]], '先建 meta（seq0）再落盘 seq1');
    assert.ok(existsSync(out.archived), '封存件存在');
    assert.equal(readFileSync(t.dispatchFile, 'utf8'), '', '新建空台账');
    assert.equal(readFileSync(out.archived, 'utf8'), 'line-a\n', '封存内容逐字节不变');
  } finally { t.cleanup(); }
});
test('ledger 轮转：达阈值封存、字节不变、新行只进新文件、seq 落盘、meta 缺失时初始化', () => {
  const t = tmpHome();
  try {
    const warns = [];
    const ledger = createEvolutionLedger({
      dshHome: t.dir,
      pluginVersion: '0.3.4',
      warn: (m) => warns.push(m),
      rotation: { maxRecords: 3, maxBytes: Infinity },
    });
    for (let i = 0; i < 3; i += 1) ledger.record({ child_id: 'c' + i });
    assert.equal(archiveNames(t.evolutionDir).length, 0, '未达阈值不轮转');
    const before = readFileSync(t.dispatchFile, 'utf8');
    ledger.record({ child_id: 'c3' });
    const archives = archiveNames(t.evolutionDir);
    assert.equal(archives.length, 1);
    assert.match(archives[0], /^dispatch-1-\d+\.jsonl$/, '封存文件名 dispatch-<seq>-<ts>.jsonl');
    const archivePath = join(t.evolutionDir, archives[0]);
    const archived = readFileSync(archivePath, 'utf8');
    assert.ok(archived.startsWith(before), '封存件保留既有行字节');
    const suffix = archived.slice(before.length);
    assert.equal(linesOf(archivePath).length, 4, '触发行也进封存件');
    assert.equal(JSON.parse(suffix.trim()).child_id, 'c3', '触发行逐字节落在既有行之后');
    assert.equal(readFileSync(t.dispatchFile, 'utf8'), '', '轮转后新建空台账');
    const meta = JSON.parse(readFileSync(t.metaFile, 'utf8'));
    assert.equal(meta.v, 1, 'meta 缺失时轮转流程初始化');
    assert.equal(meta.rotation_seq, 1, 'seq 递增持久化');
    assert.equal(meta.lost_count, 0);
    assert.equal(typeof meta.last_write_ts, 'number');
    const archiveBytes = readFileSync(archivePath, 'utf8');
    ledger.record({ child_id: 'c4' });
    assert.deepEqual(linesOf(t.dispatchFile).map((l) => JSON.parse(l).child_id), ['c4']);
    assert.equal(readFileSync(archivePath, 'utf8'), archiveBytes, '封存件内容不变');
    ledger.record({ child_id: 'd0' });
    ledger.record({ child_id: 'd1' });
    assert.equal(archiveNames(t.evolutionDir).length, 1);
    ledger.record({ child_id: 'd2' });
    assert.ok(archiveNames(t.evolutionDir).some((n) => /^dispatch-2-/.test(n)), '第二次封存 seq=2');
    assert.equal(JSON.parse(readFileSync(t.metaFile, 'utf8')).rotation_seq, 2);
    assert.ok(!existsSync(join(t.dir, '.agent-presets')), '资产不写入 .agent-presets');
  } finally { t.cleanup(); }
});

test('ledger 轮转：构造时读现有台账行数续算（跨实例计数）', () => {
  const t = tmpHome();
  try {
    mkdirSync(t.evolutionDir, { recursive: true });
    writeFileSync(t.dispatchFile, 'a\nb\n', 'utf8');
    const ledger = createEvolutionLedger({
      dshHome: t.dir,
      pluginVersion: '0.3.4',
      warn: () => {},
      rotation: { maxRecords: 2, maxBytes: Infinity },
    });
    ledger.record({ child_id: 'c' });
    const archives = archiveNames(t.evolutionDir);
    assert.equal(archives.length, 1);
    const archived = readFileSync(join(t.evolutionDir, archives[0]), 'utf8');
    assert.ok(archived.startsWith('a\nb\n'), '既有行原样入封存件');
    assert.equal(JSON.parse(readFileSync(t.metaFile, 'utf8')).rotation_seq, 1);
  } finally { t.cleanup(); }
});
test('ledger 轮转：封存件超保留上限 FCFS 淘汰最旧 + 每轮转周期最多提示一次', () => {
  const t = tmpHome();
  try {
    const warns = [];
    const ledger = createEvolutionLedger({
      dshHome: t.dir,
      pluginVersion: '0.3.4',
      warn: (m) => warns.push(m),
      rotation: { maxRecords: 1, maxBytes: Infinity, keep: 2 },
    });
    for (let i = 0; i < 6; i += 1) ledger.record({ child_id: 'p' + i });
    let archives = archiveNames(t.evolutionDir);
    assert.equal(archives.length, 2, '超出保留上限被淘汰');
    assert.ok(!archives.some((n) => /^dispatch-1-/.test(n)), '最早封存件被淘汰');
    assert.equal(warns.filter((m) => m.includes('回放窗口缩短')).length, 1, '每轮转周期最多提示一次');
    ledger.record({ child_id: 'p6' });
    ledger.record({ child_id: 'p7' });
    archives = archiveNames(t.evolutionDir);
    assert.equal(archives.length, 2);
    assert.ok(!archives.some((n) => /^dispatch-1-/.test(n) || /^dispatch-2-/.test(n)), '继续淘汰最早封存件');
    assert.equal(warns.filter((m) => m.includes('回放窗口缩短')).length, 2);
    assert.ok(!existsSync(join(t.dir, '.agent-presets')), '资产不写入 .agent-presets');
  } finally { t.cleanup(); }
});

test('迁移丢失计数：markMigrationLoss 累计并随 meta 落盘，新实例保持', () => {
  const t = tmpHome();
  try {
    const a = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.4', warn: () => {} });
    a.markMigrationLoss();
    a.markMigrationLoss();
    assert.equal(a.migrationLostCount(), 2);
    assert.equal(JSON.parse(readFileSync(t.metaFile, 'utf8')).lost_count, 2, 'lost_count 落盘');
    const b = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.4', warn: () => {} });
    assert.equal(b.migrationLostCount(), 2, '新实例从文件保持计数');
  } finally { t.cleanup(); }
});
