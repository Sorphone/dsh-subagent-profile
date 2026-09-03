// lib/core/evolution-assets.mjs — 进化候选资产域（subagent-evolution/assets/）。
// 与 drafts-store 隔离：drafts 是「存为方案」通道（source='human'/'dispatch'，无
// 生命周期）；evolution 资产带五态生命周期（draft/proposed/applied/expired/
// rolled_back）与治理审计，本域只落进化候选。资产文件与索引各自原子写
// （tmp+rename），损坏/缺失 fail-soft；写失败 warn + 通知治理审计钩子（不抛）。
// 状态流转（本域职责内）：draft →（apply 确认后由装配层驱动）→ proposed；
// 过期判定与换代由装配层驱动（先比对数据变化再转 expired 并留审计）；
// applied/rolled_back 供金丝雀判定与回滚流转。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ASSETS_VERSION = 1;
const ASSET_STATES = new Set(['draft', 'proposed', 'applied', 'expired', 'rolled_back']);
const UNRESOLVED_STATES = new Set(['draft', 'proposed']);
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

// 原子写（tmp+rename）：崩溃不产生截断文件；失败 fail-soft 清理 tmp + warn +
// 治理审计钩子。返回 {persisted, error?} 由调用方按 fail-soft 处理。
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
      logger.warn(`[dsh-subagent-profile] evolution assets: 资产写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
    onGovernanceFailure();
    return { persisted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// 读索引（assets.index.json）；缺失/损坏/形状不符回退空索引并 warn。
function loadIndex(file, logger) {
  if (!existsSync(file)) return { v: ASSETS_VERSION, assets: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && parsed.v === ASSETS_VERSION && Array.isArray(parsed.assets)) {
      return { v: ASSETS_VERSION, assets: parsed.assets.filter((e) => e !== null && typeof e === 'object' && typeof e.id === 'string') };
    }
  } catch { /* fail-soft 从零 */ }
  if (logger !== undefined && typeof logger.warn === 'function') {
    logger.warn('[dsh-subagent-profile] evolution assets: 索引文件形状不符或损坏，按空索引处理');
  }
  return { v: ASSETS_VERSION, assets: [] };
}

// 读单个资产文件；缺失/损坏/状态非法返回 null（fail-soft，索引条目调用方跳过）。
function loadAssetFile(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && parsed.v === ASSETS_VERSION
      && typeof parsed.id === 'string' && ASSET_STATES.has(parsed.state)) {
      return parsed;
    }
  } catch { /* fail-soft */ }
  return null;
}

// 资产 id 白名单校验（文件名直接由 id 拼接，防路径穿越）。
function safeAssetId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : null;
}

// 索引条目 → 完整资产（读文件合并；文件缺失/损坏返回 null 由调用方跳过）。
function readAsset(state, entry) {
  const asset = loadAssetFile(join(state.dir, `${entry.id}.json`));
  if (asset === null) return null;
  return { ...asset, index: entry };
}

// 过期判定与换代由装配层（evolution-engine）驱动：候选过期后需先比对数据变化
// 再决定是否转 expired 并留审计，本域不再按时间盲扫 draft。此函数保留为稳定
// 接口（list/get 的读前钩子），恒返回 0、不改任何资产。
function sweepExpiredAssets() {
  return 0;
}

// 数据维护清理：删除全部资产文件 + 索引置空（审计由调用方记）。返回删除条数；
// 单个文件删除失败不阻断其余（best effort）。
function purgeAllAssets(state) {
  const count = state.index.assets.length;
  for (const entry of state.index.assets) {
    try { rmSync(join(state.dir, `${entry.id}.json`), { force: true }); } catch { /* best effort */ }
  }
  state.index.assets = [];
  state.persistIndex();
  return count;
}

// 状态流转：资产文件先行（合并 patch + 状态 + updatedAt），成功后同步索引。
function transitionAsset(state, id, nextState, patch) {
  const safe = safeAssetId(id);
  if (safe === null) return { persisted: false, error: '资产 id 非法' };
  const entry = state.index.assets.find((e) => e.id === safe);
  if (entry === undefined) return { persisted: false, error: '资产不存在' };
  if (!ASSET_STATES.has(nextState)) return { persisted: false, error: '资产状态非法' };
  const asset = loadAssetFile(join(state.dir, safe + '.json'));
  if (asset === null) return { persisted: false, error: '资产文件缺失或损坏' };
  const next = { ...asset, ...patch, state: nextState, updatedAt: Date.now() };
  const persisted = state.persistAsset(next);
  if (persisted.persisted) {
    entry.state = nextState;
    entry.updatedAt = next.updatedAt;
    // 索引镜像有效期（换代判定按索引条目读 expiry，patch 后必须同步）。
    entry.expiry = typeof next.expiry === 'number' ? next.expiry : null;
    state.persistIndex();
  }
  return persisted;
}

// 新资产落盘：校验 → 写资产文件 → 追加索引条目 → 写索引（文件先行，索引为清单
// 事实源；索引写失败仅告警，内存态继续驱动本进程）。
function addAsset(state, asset) {
  if (asset === null || typeof asset !== 'object') return { persisted: false, error: '资产必须是对象' };
  const safe = safeAssetId(asset.id);
  if (safe === null || asset.state === undefined || !ASSET_STATES.has(asset.state)) {
    return { persisted: false, error: '资产 id 或状态非法' };
  }
  if (state.index.assets.some((e) => e.id === safe)) return { persisted: false, error: '资产 id 已存在' };
  const persisted = state.persistAsset(asset);
  if (!persisted.persisted) return persisted;
  state.index.assets.push({
    id: asset.id,
    source: typeof asset.source === 'string' ? asset.source : 'evolution',
    profileKey: typeof asset.profile_key === 'string' ? asset.profile_key : '',
    state: asset.state,
    axis: asset.axis,
    direction: asset.direction,
    expiry: typeof asset.expiry === 'number' ? asset.expiry : null,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  });
  const indexPersisted = state.persistIndex();
  return indexPersisted.persisted ? { persisted: true, id: asset.id } : { persisted: false, error: indexPersisted.error };
}

// 按 id 读资产（清扫过期草稿后）；id 非法或不存在返回 undefined。
function getAsset(state, id) {
  sweepExpiredAssets(state);
  const safe = safeAssetId(id);
  if (safe === null) return undefined;
  const entry = state.index.assets.find((e) => e.id === safe);
  if (entry === undefined) return undefined;
  return readAsset(state, entry) ?? undefined;
}

export function createEvolutionAssets({ dshHome, logger, onGovernanceFailure = () => {} } = {}) {
  const dir = join(dshHome, 'subagent-evolution', 'assets');
  const indexFile = join(dir, 'assets.index.json');
  const state = {
    dir,
    index: loadIndex(indexFile, logger),
    persistIndex: () => atomicWrite(indexFile, state.index, logger, onGovernanceFailure),
    persistAsset: (asset) => atomicWrite(join(dir, `${asset.id}.json`), asset, logger, onGovernanceFailure),
  };
  return {
    list() {
      sweepExpiredAssets(state);
      return state.index.assets.map((entry) => readAsset(state, entry)).filter((a) => a !== null);
    },
    get: (id) => getAsset(state, id),
    add: (asset) => addAsset(state, asset),
    transition: (id, nextState, patch) => transitionAsset(state, id, nextState, patch),
    // 同身份键是否仍有未处置（draft/proposed）资产——生成去重与观察期隔离判据。
    hasUnresolved: (profileKey) => state.index.assets.some((e) => e.profileKey === profileKey && UNRESOLVED_STATES.has(e.state)),
    findUnresolved: (profileKey) => state.index.assets
      .filter((e) => e.profileKey === profileKey && UNRESOLVED_STATES.has(e.state))
      .map((e) => ({ ...e })),
    countBySource: (source) => state.index.assets.filter((e) => e.source === source).length,
    purgeAll: () => purgeAllAssets(state),
    ids: () => state.index.assets.map((e) => e.id),
    sweepExpired: (now) => sweepExpiredAssets(state, now),
  };
}
