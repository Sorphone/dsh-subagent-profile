// lib/core/evolution-persistence.mjs — 进化资产持久化机制：版本前向迁移与派发台账轮转。
// 迁移：可重写资产顶层 v 版本号，load 时仅在内存链式前向迁移（v→v+1），迁移完成后
// 原子写回（tmp+rename）；未知/超前版本或缺少迁移步骤一律 fail-soft 跳过并计丢失，
// 绝不阻断其余功能、绝不改写台账号行。
// 轮转：dispatch.jsonl 达阈值（记录数或字节数）时封存为 dispatch-<seq>-<ts>.jsonl，
// 新建空台账续写；封存只 rename + 新建（内容字节不变、封存件不可变）；封存件超过
// 保留份数时按最早封存淘汰，并一次性提示回放窗口缩短。
// import-free（仅 node 内置），可被 bare-CI 单测直接导入。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// --- 版本迁移 ---------------------------------------------------------------

// 各可重写资产的当前版本号。新增资产类型在此登记。
export const CURRENT_VERSIONS = Object.freeze({ summaries: 1 });

// 前向迁移表：<kind, fromV> → 迁移函数（入参 v=n 的数据，须返回 v=n+1 的数据）。
// 当前各资产无跨版本 schema 变化，表为空；机制（链式前向迁移 / 未知版本
// fail-soft / 迁移后写回）由测试注入样例迁移覆盖。出现真实 schema 变化时在此
// 登记步骤并同步提升 CURRENT_VERSIONS 对应项。
export const MIGRATIONS = Object.freeze({});

// 单次加载允许的最多迁移步数（防迁移表被误配成死循环）。
const MAX_MIGRATION_STEPS = 100;

// 迁移错误：版本非法/超前/缺步骤等，由调用方按 fail-soft 处理。
export class MigrationError extends Error {}

// 内存链式前向迁移：v 小于当前版本时逐级执行迁移表步骤，返回 {data, migrated,
// fromV, toV}；v 等于当前版本原样返回；v 非法/超前或缺步骤抛 MigrationError。
export function migrateUp(data, kind, { migrations = MIGRATIONS, currentVersions = CURRENT_VERSIONS } = {}) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MigrationError('数据不是普通对象');
  }
  const current = currentVersions[kind];
  if (typeof current !== 'number' || !Number.isInteger(current)) {
    throw new MigrationError(`未知资产类型：${String(kind)}`);
  }
  const fromV = data.v;
  if (!Number.isInteger(fromV) || fromV < 1) {
    throw new MigrationError(`版本号非法：${String(fromV)}`);
  }
  if (fromV > current) throw new MigrationError(`版本 ${fromV} 超前于当前版本 ${current}`);
  if (fromV === current) return { data, migrated: false, fromV, toV: fromV };
  const steps = (migrations ?? {})[kind] ?? {};
  let cursor = data;
  let v = fromV;
  while (v < current) {
    const step = steps[v];
    if (typeof step !== 'function') {
      throw new MigrationError(`缺少 ${String(kind)} v${v} 到 v${v + 1} 的迁移步骤`);
    }
    cursor = step(cursor);
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      throw new MigrationError(`迁移步骤 v${v} 产出非法数据`);
    }
    v += 1;
    if (v - fromV > MAX_MIGRATION_STEPS) throw new MigrationError('迁移步数超过上限');
  }
  // 归一顶层版本号：迁移步骤可省略写 v，此处强制对齐当前版本。
  cursor.v = current;
  return { data: cursor, migrated: true, fromV, toV: current };
}

// 迁移写回（tmp+rename）：崩溃不产生截断文件；失败仅告警（内存迁移结果仍可用），
// 不抛、不重复计丢失。
function writeBack(file, data, warnLog) {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    warnLog(`[dsh-subagent-profile] 资产迁移写回失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

// 读取并迁移单个资产文件。缺失返回 null（不告警不计丢失）；损坏/形状不符/版本
// 无法迁移 → 告警 + onLoss + null（fail-soft 跳过）；迁移发生则原子写回后再返回。
// logger 取带 warn 方法的对象（缺省静默）。
export function loadWithMigration(
  file,
  kind,
  { logger, migrations = MIGRATIONS, currentVersions = CURRENT_VERSIONS, onLoss } = {}
) {
  const warnLog = (message) => {
    if (logger !== undefined && logger !== null && typeof logger.warn === 'function') logger.warn(message);
  };
  const lose = () => { if (typeof onLoss === 'function') onLoss(); };
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    warnLog(`[dsh-subagent-profile] ${String(kind)} 资产损坏，跳过该资产（fail-soft）：${error instanceof Error ? error.message : String(error)}`);
    lose();
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnLog(`[dsh-subagent-profile] ${String(kind)} 资产形状不符，跳过该资产（fail-soft）`);
    lose();
    return null;
  }
  let result;
  try {
    result = migrateUp(parsed, kind, { migrations, currentVersions });
  } catch (error) {
    const version = parsed.v !== undefined ? String(parsed.v) : '未知';
    warnLog(`[dsh-subagent-profile] ${String(kind)} 资产版本 ${version} 无法迁移，跳过该资产（fail-soft）：${error instanceof Error ? error.message : String(error)}`);
    lose();
    return null;
  }
  if (result.migrated) writeBack(file, result.data, warnLog);
  return result.data;
}

// --- 台账轮转 ----------------------------------------------------------------

// 轮转阈值：记录数（>50k）或字节数（>5MB），任一命中即轮转。阈值为建议初值，
// 待实测后校准。
export const ROTATION_DEFAULT_MAX_RECORDS = 50000;
export const ROTATION_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
// 封存件保留上限（回放窗口）：超过按最早封存淘汰。
export const ROTATION_DEFAULT_KEEP = 8;

// 封存件文件名：dispatch-<seq>-<ts>.jsonl（同 seq 同毫秒碰撞时追加 -<n>）。
const ARCHIVE_PATTERN = /^dispatch-(\d+)-(\d+)(?:-\d+)?\.jsonl$/;

// 是否达轮转阈值：记录数超限或字节数超限（任一命中）。
export function rotationNeeded(records, bytes, { maxRecords = ROTATION_DEFAULT_MAX_RECORDS, maxBytes = ROTATION_DEFAULT_MAX_BYTES } = {}) {
  return records > maxRecords || bytes > maxBytes;
}

// 目录内封存件清单（按 seq、ts 升序 = 最早封存在前）。目录缺失/读失败返回空表。
function listArchives(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ARCHIVE_PATTERN.exec(name))
    .filter((match) => match !== null)
    .map((match) => ({ name: match[0], seq: Number(match[1]), ts: Number(match[2]) }))
    .sort((a, b) => a.seq - b.seq || a.ts - b.ts);
}

// 淘汰最早封存件至保留上限；发生淘汰时一次性提示回放窗口缩短（每次轮转最多一次，
// 因本函数每次轮转只执行一次）。单个文件删除失败不阻断其余淘汰。
function pruneArchives(dir, keep, warn) {
  const list = listArchives(dir);
  if (list.length <= keep) return 0;
  const excess = list.slice(0, list.length - keep);
  let removed = 0;
  for (const entry of excess) {
    try {
      rmSync(join(dir, entry.name), { force: true });
      removed += 1;
    } catch { /* 单个封存件删除失败不影响主流程 */ }
  }
  warn(`dispatch ledger: 回放窗口缩短——封存件已超过 ${keep} 份，淘汰最旧 ${removed} 份`);
  return removed;
}

// 创建轮转执行器：check(records, bytes) 在阈值命中时执行一次轮转，返回
// {rotated, archived, seq, pruned}；未命中返回 {rotated:false}。seq 账本与 meta
// 落盘由调用方注入：getRotationSeq/setRotationSeq 管内存 seq，initMetaIfMissing
// 保证首次轮转先建 meta（seq 现值落盘），persistMeta 以更新后的 seq 落盘。
// 文件操作异常向上抛，由调用方按 fail-soft 处理（本条已落盘的追加不受影响）。
export function createRotation({
  dir,
  dispatchFile,
  getRotationSeq = () => 0,
  setRotationSeq = () => {},
  initMetaIfMissing = () => {},
  persistMeta = () => true,
  warn = () => {},
  maxRecords = ROTATION_DEFAULT_MAX_RECORDS,
  maxBytes = ROTATION_DEFAULT_MAX_BYTES,
  keep = ROTATION_DEFAULT_KEEP,
  now = Date.now,
} = {}) {
  return (records, bytes) => {
    if (!rotationNeeded(records, bytes, { maxRecords, maxBytes })) return { rotated: false };
    initMetaIfMissing();
    const seq = getRotationSeq() + 1;
    const stamp = now();
    let archive = join(dir, `dispatch-${seq}-${stamp}.jsonl`);
    let attempt = 0;
    while (existsSync(archive)) {
      attempt += 1;
      archive = join(dir, `dispatch-${seq}-${stamp}-${attempt}.jsonl`);
    }
    // 只 rename + 新建：封存内容字节不变，绝不重写任何已写行。
    renameSync(dispatchFile, archive);
    setRotationSeq(seq);
    persistMeta();
    writeFileSync(dispatchFile, '', 'utf8');
    const pruned = pruneArchives(dir, keep, warn);
    return { rotated: true, archived: archive, seq, pruned };
  };
}
