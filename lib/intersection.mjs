// lib/intersection.mjs — tool intersection（安全门 1）纯函数核心，从 index.mjs
// 的 provider start 拆出。无 @deepseek-ai 依赖。此处只做 allow 收窄计算；
// 调用方（provider start）保留空集 fail-loud throw（错误文案逐字不变）与
// restrict 的 try/catch 包裹。
//
// Relationship to lib/pure.mjs computeContinuableAllow(parentNames, toolFilter):
// the continuable variant has NO childNames — it assumes the child toolset ≈
// parent toolset (continuable inherits the parent preset, so a true parent∩child
// intersection cannot be recomputed there) and computes parent − run_code − deny
// → allow. computeEffectiveAllow additionally intersects with the ACTUAL child
// toolset (parentNames ∩ childNames), so it stays correct even when the child
// composes a different toolset. The two serve different call paths and safety
// guarantees and must NOT be merged.

// parent∩child − run_code − deny → allow 收窄；空集返回 []（fail-loud 由调用方
// provider start 以逐字不变的 error 文案 throw）。
export function computeEffectiveAllow(parentNames, childNames, toolFilter) {
  let effective = childNames.filter((name) =>
    parentNames.has(name) &&
    name !== 'run_code' &&
    !(toolFilter !== undefined && toolFilter.deny !== undefined && toolFilter.deny.includes(name))
  );
  if (toolFilter !== undefined && Array.isArray(toolFilter.allow)) {
    effective = effective.filter((name) => toolFilter.allow.includes(name));
  }
  return effective;
}
