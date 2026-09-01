// lib/core/evolution-renewal.mjs — 候选换代判定与换代审计（从 evolution-engine 拆出
// 守行门）：到期判定、有效期初值、数据指纹、显著变化判定（阈值初值，待实测后校准）、
// suggestion-expire / suggestion-refresh 审计条目。纯函数、零 IO、零依赖，可裸 import 单测。

// 候选到期判定：expiry 为 null（不自动过期）恒不到期，否则 now >= expiry。
export function candidateExpired(entry, now) {
  return typeof entry.expiry === 'number' && now >= entry.expiry;
}

// 候选有效期初值：手动维护恒不自动过期；自动换新按设置小时数计算，0 = 不自动过期。
export function candidateExpiryOf(mode, ttlH, now) {
  if (mode === 'manual') return null;
  return ttlH === 0 ? null : now + ttlH * 3600 * 1000;
}

// 数据指纹：该身份键当前聚合的样本数/加权成功分/置信度（换代判定输入）。
export function dataFingerprintOf(item, summaries) {
  const l1 = summaries !== null && typeof summaries === 'object' && summaries.l1 !== null && typeof summaries.l1 === 'object'
    ? summaries.l1
    : {};
  const group = typeof item.profileKey === 'string' ? l1[item.profileKey] : undefined;
  const entry = group !== null && typeof group === 'object' ? group : {};
  return {
    n: Number.isFinite(entry.confidence?.n) ? entry.confidence.n : (Number.isFinite(entry.deployments_total) ? entry.deployments_total : 0),
    score: Number.isFinite(entry.score?.weighted_success) ? entry.score.weighted_success : 0,
    confidence: typeof entry.confidence?.level === 'string' ? entry.confidence.level : '',
  };
}

// 显著变化判定（初值，待实测后校准）：样本数增加 ≥2，或加权成功分变化 ≥0.1，
// 或置信度升级。
const FINGERPRINT_CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
export function dataSignificantlyChanged(prev, next) {
  if (next.n - prev.n >= 2) return true;
  if (Math.abs(next.score - prev.score) >= 0.1) return true;
  return (FINGERPRINT_CONFIDENCE_RANK[next.confidence] ?? -1) > (FINGERPRINT_CONFIDENCE_RANK[prev.confidence] ?? -1);
}

// suggestion-expire 事件：候选到期且数据显著变化、换代时转 expired 的留痕（仅记录）。
export function expireAuditEntry(asset, reason) {
  return {
    event: 'suggestion-expire',
    profile_id: typeof asset.id === 'string' ? asset.id : '',
    from: asset.from,
    to: asset.to,
    axis: asset.axis,
    direction: asset.direction,
    human_confirmed: false,
    reason,
  };
}

// suggestion-refresh 事件：人工触发「重新生成候选」的留痕（人工触发即确认）。
export function refreshAuditEntry({ profileKey, from, to, axis, direction }) {
  return {
    event: 'suggestion-refresh',
    profile_id: profileKey,
    from,
    to,
    axis,
    direction,
    human_confirmed: true,
  };
}
