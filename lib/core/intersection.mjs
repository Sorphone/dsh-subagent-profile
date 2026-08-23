// lib/core/intersection.mjs — tool intersection（安全门 1）纯函数核心，从 index.mjs
// 的 provider start 拆出。无 @deepseek-ai 依赖。此处只做 allow 收窄计算；
// 调用方（provider start）保留空集 fail-loud throw（错误文案逐字不变）与
// restrict 的 try/catch 包裹。
//
// 与 lib/core/pure.mjs 的 computeContinuableAllow(parentNames, toolFilter) 的关系：
// continuable 变体没有 childNames——它假设子工具集 ≈ 父工具集（continuable 继承
// 父预设，那里无法重算真正的父∩子交集），计算 parent − run_code − deny → allow。
// computeEffectiveAllow 额外与真实子工具集求交（parentNames ∩ childNames），
// 子组合了不同工具集时仍然正确。两者服务于不同的调用路径与安全保证，不得合并。

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
