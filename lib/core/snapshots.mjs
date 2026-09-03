// lib/core/snapshots.mjs — 派发配置快照域（subagent-evolution/snapshots/）。
// 开关开启后每次 dispatch effective 形成后写一条完整 config 快照（含 persona 原文
// 与 toolFilter 全量），供「保存为方案」事后完整复现该笔派发；快照是用户显式
// opt-in 的本机私有域（不是台账，dispatch.jsonl 不落原文——隐私红线保持）。
// 原子写（tmp+rename）；索引 snapshots.index.json 记录元数据（无原文），按 ts
// 倒序读取；损坏文件/索引 fail-soft 跳过；总量护栏：快照 ≤200 条，到上限停止
// 新写并提示清理（不自动删旧）。import-free（仅 node 内置），可被裸 CI 单测。
// 审计：snapshot-written（写）/ snapshot-used（保存为方案命中，由调用方记）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 快照总量护栏（B7 定稿值）：到上限停止新写（不自动删旧，提示清理）。
export const SNAPSHOT_CAP = 200;

// 完整 config 字段集：与 dispatch merged 同源（persona 原文、toolFilter 完整对象）。
const CONFIG_FIELDS = ['preset', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'maxDepth', 'persona', 'toolFilter'];

// profileKey 摘要（文件名安全前缀，非可逆）。
function digestOf(profileKey) {
  return createHash('sha256').update(String(profileKey)).digest('hex').slice(0, 12);
}

// 原子写（tmp+rename）：崩溃不产生截断文件；失败清理 tmp + warn + 治理审计钩子。
function atomicWrite(file, payload, logger, onGovernanceFailure) {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
    return { persisted: true };
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn(`[dsh-subagent-profile] 配置快照写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof onGovernanceFailure === 'function') onGovernanceFailure();
    return { persisted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// 读索引；缺失回退空表，损坏/形状不符 fail-soft 从空起步（快照文件仍在，索引可重建）。
function readIndex(indexFile, logger) {
  if (!existsSync(indexFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexFile, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && parsed.v === 1 && Array.isArray(parsed.entries)) {
      return parsed.entries.filter((e) => e !== null && typeof e === 'object' && typeof e.id === 'string');
    }
  } catch { /* fail-soft */ }
  if (logger !== undefined && typeof logger.warn === 'function') {
    logger.warn('[dsh-subagent-profile] 配置快照索引损坏，按空索引处理（快照文件保留）');
  }
  return [];
}

// 读单个快照文件；缺失/损坏/形状不符返回 null（fail-soft，调用方跳过）。
function readSnapshotFile(file, logger) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && parsed.v === 1 && typeof parsed.id === 'string' && parsed.config !== null && typeof parsed.config === 'object') {
      return parsed;
    }
  } catch { /* fail-soft */ }
  if (logger !== undefined && typeof logger.warn === 'function') {
    logger.warn(`[dsh-subagent-profile] 配置快照文件损坏，跳过：${file}`);
  }
  return null;
}

// dispatch effective 形成后调用：开关关恒跳过；到护栏上限停止新写（不自动删旧）。
// 幂等键 = 摘要+ts；同键碰撞跳过。审计只记元数据（无 persona/prompt 原文）。
function captureSnapshot(deps, { profileKey, config, mode }) {
  if (!deps.getEnabled()) return null;
  if (deps.state.index.length >= SNAPSHOT_CAP) {
    if (deps.logger !== undefined && typeof deps.logger.warn === 'function') {
      deps.logger.warn(`[dsh-subagent-profile] 配置快照已达 ${SNAPSHOT_CAP} 条护栏上限，停止新快照（可在设置页数据维护区清理）`);
    }
    return null;
  }
  const key = typeof profileKey === 'string' ? profileKey : '(inline)';
  const ts = Date.now();
  const id = `${digestOf(key)}-${ts}`;
  if (deps.state.index.some((e) => e.id === id)) return null;
  const payload = { v: 1, id, ts, profileKey: key, from: typeof mode === 'string' && mode !== '' ? mode : 'dispatch', config: {} };
  for (const field of CONFIG_FIELDS) {
    if (config !== null && typeof config === 'object' && config[field] !== undefined) payload.config[field] = config[field];
  }
  const size = Buffer.byteLength(JSON.stringify(payload));
  const file = join(deps.dir, `${id}.json`);
  const written = atomicWrite(file, payload, deps.logger, deps.onGovernanceFailure);
  if (!written.persisted) return null;
  deps.state.index.push({ key, ts, size, id, from: payload.from });
  deps.persistIndex();
  deps.recordAudit({ kind: 'snapshot-written', profile_key: key, file: `${id}.json`, size });
  return { id, ts, profileKey: key };
}

// 索引元数据列表（ts 倒序；无 config 原文）。
function listSnapshots(state) {
  return [...state.index].sort((a, b) => b.ts - a.ts);
}

// 单条完整快照（只读查看用；含 persona 原文，UI 默认折叠）。
function viewSnapshot(deps, id) {
  if (typeof id !== 'string' || id === '' || !deps.state.index.some((e) => e.id === id)) return null;
  return readSnapshotFile(join(deps.dir, `${id}.json`), deps.logger);
}

// 「保存为方案」数据源：按 profileKey 匹配最近一条快照（ts 倒序首条命中）。
function latestSnapshot(deps, profileKey) {
  for (const entry of listSnapshots(deps.state)) {
    if (entry.key !== profileKey) continue;
    const snapshot = readSnapshotFile(join(deps.dir, `${entry.id}.json`), deps.logger);
    if (snapshot !== null) return { ...snapshot, file: `${entry.id}.json` };
  }
  return null;
}

// 一键清理：删除全部快照文件 + 索引置空。返回删除条数（审计由调用方记）。
function clearSnapshots(deps) {
  const count = deps.state.index.length;
  for (const entry of deps.state.index) {
    try { rmSync(join(deps.dir, `${entry.id}.json`), { force: true }); } catch { /* 单个删除失败不阻断其余 */ }
  }
  deps.state.index = [];
  try { rmSync(deps.indexFile, { force: true }); } catch { /* best effort */ }
  return count;
}

export function createSnapshotStore({ dshHome, logger, getEnabled = () => false, recordAudit = () => {}, onGovernanceFailure = () => {} } = {}) {
  const dir = join(dshHome, 'subagent-evolution', 'snapshots');
  const indexFile = join(dir, 'snapshots.index.json');
  const state = { index: readIndex(indexFile, logger) };
  const deps = { dir, indexFile, state, logger, getEnabled, recordAudit, onGovernanceFailure, persistIndex: () => atomicWrite(indexFile, { v: 1, entries: state.index }, logger, onGovernanceFailure) };
  return {
    dir,
    indexFile,
    capture: (input) => captureSnapshot(deps, input),
    list: () => listSnapshots(state),
    view: (id) => viewSnapshot(deps, id),
    latestByProfileKey: (profileKey) => latestSnapshot(deps, profileKey),
    count: () => state.index.length,
    clear: () => clearSnapshots(deps),
  };
}
