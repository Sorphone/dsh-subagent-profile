// lib/core/presets-sync.mjs — bundled agent 预设自安装（从 index.mjs 逐字移出；
// 仅 node 内置，无 @deepseek-ai 依赖）。
//
// 宿主启动时插件把 bundled `presets/` 树同步进 DSH agent-presets 发现根
// （~/.dsh/.agent-presets），使「编排者模式 V2」无需手动复制就出现在新建会话
// 选择器里——与官方 dsh-liangshen bundle 相同的自安装模式。同步按目录、
// 经哈希门控：per-target sidecar（.dsh-sync.json）记录 bundled 内容哈希与派生树
// 快照哈希，下次运行跳过未变化的树、跳过（绝不覆盖）用户改过的树；两侧都变时
// 先把用户侧归档到 .user-modified-<timestamp>/ 再写入升级后的 bundled 内容。
// bundle 不再提供的目标文件会被剪除；插件不拥有的目录永不触碰。
// 刻意不用 node:fs cpSync：Node 22 的 Windows 上，fs.cpSync({ recursive: true })
// 在源路径含非 ASCII（CJK 主目录，nodejs/node#54476）时可能崩溃进程，故逐条
// 复制并保留源 mtime。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// 本包内 bundled 预设树的绝对路径。本模块在 lib/core/，比包根低两层，URL 必须
// 上爬两段才能指向仓库根 `presets/` 目录（与它还在包根的 index.mjs 时解析到的
// 值相同；写错成 `../` 会指向不存在的 lib/presets，从而静默禁用启动自安装）。
export function bundledPresetsRoot() {
  return fileURLToPath(new URL('../../presets', import.meta.url));
}

export const MTIME_TOLERANCE_MS = 1000;

// 同步元数据：sidecar 记录最近一次 bundled/目标内容哈希，归档前缀命名三方
// 用户编辑备份。两者都是插件本地记账、非 preset 内容——hashTree 排除它们、
// prune 保留它们（否则 sidecar 自身写入会让目标哈希自指漂移，归档会被剪掉）。
export const SIDECAR_NAME = '.dsh-sync.json';
export const ARCHIVE_PREFIX = '.user-modified-';

export function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

// 文件同一性按字节；size/mtime 只作快速否定检查。
export function sameFile(a, b) {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  if (Math.abs(sa.mtimeMs - sb.mtimeMs) > MTIME_TOLERANCE_MS) return false;
  return readFileSync(a).equals(readFileSync(b));
}

export function copyTreeSync(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry);
    const target = join(targetDir, entry);
    const st = statSync(source);
    if (st.isDirectory()) copyTreeSync(source, target);
    else {
      copyFileSync(source, target);
      utimesSync(target, st.atime, st.mtime);
    }
  }
}

// 删除 `keep` 之外的 target 文件，再只删因此清空的目录。
export function pruneExtras(root, keep) {
  const parents = new Set();
  for (const file of filesUnder(root)) {
    if (!keep.has(relative(root, file))) {
      parents.add(dirname(file));
      rmSync(file, { force: true });
    }
  }
  for (const start of parents) {
    let dir = start;
    while (dir !== undefined && relative(root, dir) !== '') {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
        dir = dirname(dir);
      } else dir = undefined;
    }
  }
}

// preset 树内容哈希：每文件的相对路径 + 字节喂进 sha1。同步元数据（sidecar 与
// 任何 `.user-modified-*` 归档）被排除——它是插件记账、非 preset 内容，纳入会使
// 派生树哈希在 sidecar 被重写（自指）或归档创建时立即漂移。
export function hashTree(root) {
  const hash = createHash('sha1');
  for (const file of filesUnder(root).sort()) {
    const rel = relative(root, file);
    if (isSyncMetadata(rel)) continue;
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// 相对 preset 根的路径是否为同步元数据（sidecar 文件，或 `.user-modified-*`
// 归档目录下的任何内容）。
export function isSyncMetadata(rel) {
  const head = rel.split(sep)[0];
  return head === SIDECAR_NAME || head.startsWith(ARCHIVE_PREFIX);
}

export function sidecarPath(targetDir) {
  return join(targetDir, SIDECAR_NAME);
}

// 读 sidecar；缺失或畸形（版本错 / 哈希字段缺 / 解析失败）按缺失处理，使下次
// 同步走保守的首跑路径，而不是信任损坏的记账。
function readSidecar(targetDir) {
  const path = sidecarPath(targetDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && parsed.version === 1 && typeof parsed.bundledHash === 'string' && typeof parsed.targetHash === 'string') {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeSidecar(targetDir, bundledHash, targetHash) {
  writeFileSync(sidecarPath(targetDir), `${JSON.stringify({ version: 1, bundledHash, targetHash }, null, 2)}\n`);
}

// 复制一个文件系统条目（文件或目录），保留逐条语义与源 mtime——与 copyTreeSync
// 自身文件分支同形。
function copyEntry(source, dest) {
  const st = statSync(source);
  if (st.isDirectory()) copyTreeSync(source, dest);
  else {
    copyFileSync(source, dest);
    utimesSync(dest, st.atime, st.mtime);
  }
}

// 覆盖前把当前（用户可见的）preset 树归档到
// <targetDir>/.user-modified-<timestamp>/。sidecar 与既有归档被排除，归档不会
// 嵌套。写失败返回 false——调用方必须跳过本次同步、保留用户编辑原样
// （fail-safe：备份失败绝不允许成为销毁用户内容的许可）。
function archiveUserTree(targetDir) {
  const archiveDir = join(targetDir, `${ARCHIVE_PREFIX}${Date.now()}`);
  // 先拍下要归档的条目再创建 archiveDir：归档位于 targetDir 之下，mkdirSync 后
  // 再读目录会把归档本身读进来，无限递归进它自己。
  const entries = [];
  for (const entry of readdirSync(targetDir)) {
    if (entry === SIDECAR_NAME || entry.startsWith(ARCHIVE_PREFIX)) continue;
    entries.push(entry);
  }
  try {
    mkdirSync(archiveDir, { recursive: true });
    for (const entry of entries) {
      copyEntry(join(targetDir, entry), join(archiveDir, entry));
    }
    return true;
  } catch {
    try { rmSync(archiveDir, { recursive: true, force: true }); } catch { /* best effort */ }
    return false;
  }
}

// pruneExtras 的 keep 集：同步后树必须保留的一切——bundled 文件、sidecar、
// 既有 `.user-modified-*` 归档下的每个文件。keep 里没有归档条目的话，
// pruneExtras 会在同步当下删掉归档，静默丢弃它本该保留的用户编辑。
function computeKeep(sourceDir, targetDir) {
  const keep = new Set(filesUnder(sourceDir).map((f) => relative(sourceDir, f)));
  keep.add(SIDECAR_NAME);
  if (existsSync(targetDir)) {
    for (const entry of readdirSync(targetDir)) {
      if (!entry.startsWith(ARCHIVE_PREFIX)) continue;
      const dir = join(targetDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of filesUnder(dir)) keep.add(relative(targetDir, f));
    }
  }
  return keep;
}

// 同步一个 preset 目录。返回 'synced'（写入或升级）、'current'（未变）或
// 'user-modified'（target 偏离上次同步快照而跳过——绝不覆盖用户编辑）。判定表：
//   - target 不存在                  → 复制 + 写 sidecar          → 'synced'
//   - 无 sidecar、target 存在        → 一次性归档 + 同步          → 'synced'
//   - bundled 未变、target 相同      → 'current'
//   - bundled 未变、target 漂移      → 'user-modified'（跳过）
//   - bundled 变了                   → 漂移则先归档，再同步       → 'synced'
export function syncOnePreset(sourceDir, targetDir) {
  const bundledHash = hashTree(sourceDir);
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    // target 意外是文件（同名冲突）时先改名备份再清，避免直接 rmSync 丢失用户内容。
    try { renameSync(targetDir, `${targetDir}.removed-${Date.now()}`); } catch { rmSync(targetDir, { recursive: true, force: true }); }
  }
  if (!existsSync(targetDir)) {
    copyTreeSync(sourceDir, targetDir);
    writeSidecar(targetDir, bundledHash, hashTree(targetDir));
    return 'synced';
  }
  const sidecar = readSidecar(targetDir);
  // 无 sidecar + 既有 target = 门控前状态：无法判断用户是否编辑过，按「可能编辑
  // 过」处理，在首次门控同步前归档一次（一次性迁移）。
  if (sidecar === undefined) {
    if (!archiveUserTree(targetDir)) return 'user-modified';
    copyTreeSync(sourceDir, targetDir);
    pruneExtras(targetDir, computeKeep(sourceDir, targetDir));
    writeSidecar(targetDir, bundledHash, hashTree(targetDir));
    return 'synced';
  }
  const currentTargetHash = hashTree(targetDir);
  if (sidecar.bundledHash === bundledHash) {
    return sidecar.targetHash === currentTargetHash ? 'current' : 'user-modified';
  }
  // bundled 升级。用户也改过 target（快照漂移）时先归档其树，编辑不会静默丢失。
  if (sidecar.targetHash !== currentTargetHash) {
    if (!archiveUserTree(targetDir)) return 'user-modified';
  }
  copyTreeSync(sourceDir, targetDir);
  pruneExtras(targetDir, computeKeep(sourceDir, targetDir));
  writeSidecar(targetDir, bundledHash, hashTree(targetDir));
  return 'synced';
}

// 旧预设收编归档（V2 取代）：bundled 已不再提供 `orchestrator`（由
// `orchestrator-v2` 收编取代），发现根里若残留旧目录（旧版本自装、用户手工创建
// 或恢复的），同步时改名归档为 orchestrator.removed-<stamp>——与卸载清理同一样式：
// 只改名不删除（用户数据保留），幂等（归档后旧名即不存在，下次同步无操作）、
// fail-soft（改名失败不抛不阻断，下次启动重试）。归档名含点号，不满足官方
// PRESET_ID（^[a-z0-9][a-z0-9-]*$），不会出现在预设选择器。
function archiveLegacyOrchestrator(targetRoot) {
  const legacy = join(targetRoot, 'orchestrator');
  if (!existsSync(legacy)) return false;
  try {
    renameSync(legacy, join(targetRoot, `orchestrator.removed-${Date.now()}`));
    return true;
  } catch {
    return false;
  }
}

// 把 `presets/` 下每个 preset 目录同步进目标发现根。
export function syncBundledPresets(targetRoot) {
  const result = { synced: [], current: [], userModified: [], failed: [], archived: [] };
  const sourceRoot = bundledPresetsRoot();
  mkdirSync(targetRoot, { recursive: true });
  if (existsSync(sourceRoot)) {
    for (const entry of readdirSync(sourceRoot)) {
      const source = join(sourceRoot, entry);
      if (!statSync(source).isDirectory()) continue;
      const id = basename(source);
      try {
        const outcome = syncOnePreset(source, join(targetRoot, id));
        if (outcome === 'synced') result.synced.push(id);
        else if (outcome === 'current') result.current.push(id);
        else result.userModified.push(id);
      } catch (error) {
        result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  // 旧名收编归档：仅当 bundled 侧确无 orchestrator 目录时处理（防御：未来若仓库
  // 回补同名 bundled，以 bundled 为准、不误归档其派生树）。
  if (!existsSync(join(sourceRoot, 'orchestrator')) && archiveLegacyOrchestrator(targetRoot)) {
    result.archived.push('orchestrator');
  }
  return result;
}
