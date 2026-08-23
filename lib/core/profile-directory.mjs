// lib/core/profile-directory.mjs — 派发方案目录的单一数据源（Task 37a）。
// profileSectionText（模型可见段）与 profileSnapshotOf（决策轨迹记录面）都从
// 本模块的 profileDirectoryRows 派生，构造保证「模型看到 ≡ 记录面」的 id、顺序与
// 字段集。未来 F 数据层注入 avg_cost / success_rate 只改这里一处。
//
// 仅依赖 lib/core/pure.mjs（tierSortKey）；无 @deepseek-ai 依赖，可被 bare-CI
// 单测直接 import。

import { tierSortKey } from './pure.mjs';

// 决策输入快照阈值：profiles_snapshot 条目数与 description 截断长度。
const MAX_PROFILE_SNAPSHOT_ENTRIES = 6;
const PROFILE_DESC_CHARS = 80;

function snapshotEntry(row, maxDesc) {
  const description = typeof row.description === 'string' ? row.description : '';
  return {
    id: row.id,
    ...(description !== '' ? { description: description.length > maxDesc ? `${description.slice(0, maxDesc)}…` : description } : {}),
    ...(typeof row.preset === 'string' && row.preset !== '' ? { preset: row.preset } : {}),
    ...(typeof row.model === 'string' && row.model !== '' ? { model: row.model } : {}),
    ...(typeof row.provider === 'string' && row.provider !== '' ? { provider: row.provider } : {}),
    ...(typeof row.tokenTier === 'string' && row.tokenTier !== '' ? { tokenTier: row.tokenTier } : {}),
    ...(typeof row.avgCost === 'number' && Number.isFinite(row.avgCost) ? { avgCost: row.avgCost } : {}),
    ...(typeof row.successRate === 'number' && Number.isFinite(row.successRate) ? { successRate: row.successRate } : {}),
  };
}

// 模型可见 profile 目录快照：输入为 profileDirectoryRows 的结构化行。description
// 截断、条目数截到 maxEntries；chosenId 超出 maxEntries 时并入该条并打
// chosenOutsideSnapshot（37b：截断不得制造审计空洞）。
export function profileSnapshotOf(profiles, { maxEntries = MAX_PROFILE_SNAPSHOT_ENTRIES, maxDesc = PROFILE_DESC_CHARS, chosenId } = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  const full = [];
  for (const row of list) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || row.id === '') continue;
    if (row.enabled === false) continue;
    full.push(snapshotEntry(row, maxDesc));
  }
  const entries = full.slice(0, maxEntries);
  let truncated = full.length > maxEntries;
  if (typeof chosenId === 'string' && chosenId !== '' && chosenId !== '(inline)' && !entries.some((e) => e.id === chosenId)) {
    const chosen = full.find((e) => e.id === chosenId);
    if (chosen !== undefined) {
      entries.push({ ...chosen, chosenOutsideSnapshot: true });
      truncated = true;
    }
  }
  return { entries, truncated, total: full.length };
}

// store 兼容 createProfileStore 返回形态（含 profiles Map）；也接受数组（测试与
// 非标准调用方）。只保留启用且 id 合法的方案；按 tokenTier cheap-first 稳定排序，
// tier 相同按 id 升序（确定性，不依赖 Map 插入序的跨运行差异）。
export function profileDirectoryRows(store) {
  const source = store !== null && typeof store === 'object' && store.profiles !== undefined
    ? [...store.profiles.values()]
    : (Array.isArray(store) ? store : []);
  return source
    .filter((p) => p !== null && typeof p === 'object' && typeof p.id === 'string' && p.id !== '' && p.enabled !== false)
    .sort((a, b) => tierSortKey(a.tokenTier) - tierSortKey(b.tokenTier) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => ({
      id: p.id,
      description: typeof p.description === 'string' ? p.description : '',
      ...(typeof p.preset === 'string' && p.preset !== '' ? { preset: p.preset } : {}),
      ...(typeof p.model === 'string' && p.model !== '' ? { model: p.model } : {}),
      ...(typeof p.provider === 'string' && p.provider !== '' ? { provider: p.provider } : {}),
      ...(typeof p.tokenTier === 'string' && p.tokenTier !== '' ? { tokenTier: p.tokenTier } : {}),
      ...(typeof p.avgCost === 'number' && Number.isFinite(p.avgCost) ? { avgCost: p.avgCost } : {}),
      ...(typeof p.successRate === 'number' && Number.isFinite(p.successRate) ? { successRate: p.successRate } : {}),
    }));
}


// 从 summaries.json 的 l1/l2 聚合为每个 profile 提取 { avgCost, successRate, n }。
// 匹配优先级：profile.model → L2 model 轴；profile.preset → L2 preset 轴。多个 L1
// 组共享同一轴值时按成本与部署量合并（avg_cost = Σestimated_cost / Σpriced；
// successRate = Σcompleted / Σdeployments）。无数据返回 null，调用方省略显示。
export function profileStatsFromSummaries(store, summaries) {
  const rows = profileDirectoryRows(store);
  const l2 = summaries !== null && typeof summaries === 'object' && summaries.l2 !== null && typeof summaries.l2 === 'object' ? summaries.l2 : {};
  const byModel = new Map();
  const byPreset = new Map();
  for (const [key, group] of Object.entries(l2)) {
    if (group === null || typeof group !== 'object') continue;
    const modelMatch = /:model:([^|]+)$/.exec(key);
    if (modelMatch) {
      const arr = byModel.get(modelMatch[1]) ?? [];
      arr.push(group);
      byModel.set(modelMatch[1], arr);
      continue;
    }
    const presetMatch = /:preset:([^|]+)$/.exec(key);
    if (presetMatch) {
      const arr = byPreset.get(presetMatch[1]) ?? [];
      arr.push(group);
      byPreset.set(presetMatch[1], arr);
    }
  }
  const merge = (groups) => {
    let deployments = 0;
    let completed = 0;
    let priced = 0;
    let cost = 0;
    for (const g of groups) {
      deployments += Number.isFinite(g.deployments_total) ? g.deployments_total : 0;
      completed += Number.isFinite(g.outcome?.completed) ? g.outcome.completed : 0;
      priced += Number.isFinite(g.cost?.priced) ? g.cost.priced : 0;
      cost += Number.isFinite(g.cost?.estimated_cost) ? g.cost.estimated_cost : 0;
    }
    if (deployments <= 0 && priced <= 0) return null;
    return {
      avgCost: priced > 0 ? Number((cost / priced).toFixed(4)) : null,
      successRate: deployments > 0 ? Number((completed / deployments).toFixed(3)) : null,
      n: deployments,
    };
  };
  const out = new Map();
  for (const row of rows) {
    let stats = null;
    if (typeof row.model === 'string' && row.model !== '') stats = merge(byModel.get(row.model) ?? []);
    if (stats === null && typeof row.preset === 'string' && row.preset !== '') stats = merge(byPreset.get(row.preset) ?? []);
    if (stats !== null) out.set(row.id, stats);
  }
  return out;
}

// 用 stats map 为目录行补 avgCost/successRate（F 数据层 join）。stats 为
// profileStatsFromSummaries 的返回值；行上已有 avgCost/successRate 时优先保留
// 显式值（store 侧/测试注入），stats 只补缺失。
export function applyProfileStats(rows, stats) {
  const map = stats instanceof Map ? stats : new Map(Object.entries(stats ?? {}));
  return rows.map((row) => ({
    ...row,
    ...(row.avgCost === undefined && map.get(row.id)?.avgCost !== null && map.get(row.id)?.avgCost !== undefined ? { avgCost: map.get(row.id).avgCost } : {}),
    ...(row.successRate === undefined && map.get(row.id)?.successRate !== null && map.get(row.id)?.successRate !== undefined ? { successRate: map.get(row.id).successRate } : {}),
    ...(map.get(row.id)?.n !== undefined ? { n: map.get(row.id).n } : {}),
  }));
}
