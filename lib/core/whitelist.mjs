// lib/core/whitelist.mjs — 目标预设白名单：从运行时名册推导，不硬编码——
// agentPresets 存在时取 system-trust 预设，否则用官方回退名单。从 index.mjs
// 逐字移出；import-free（无 @deepseek-ai 依赖）。
//
// 注入说明：原 apply 闭包版本自带 `agentCtx` 并自己读
// `agentCtx.get('agentPresets')`。调用方现在注入服务——
// `resolveWhitelist(parent.ctx.get('agentPresets'))`——使模块不依赖 apply 闭包
// 状态。`parent.ctx.get('agentPresets')` 得到完全相同的结果（服务或 undefined），
// 回退语义不变。FALLBACK_WHITELIST 导出供测试用。
export const FALLBACK_WHITELIST = ['standard', 'code', 'minimal'];

// 逃生舱叠加（可选）：escapeSet 是非 system-trust 预设的显式放行集（Set 或数组，
// 由调用方在开关打开时传入）。只叠加——base 集原样保留、去重；逃生舱绝不替代或
// 缩减 base 集，也不升级 base 成员的语义（逃生舱成员仍属「非 system 放行」）。
// escapeSet 缺省/为空时零叠加（行为与旧单参调用完全一致）。
function withEscapeSet(base, escapeSet) {
  if (escapeSet === undefined) return base;
  const extras = [...escapeSet].filter((id) => typeof id === 'string' && id !== '');
  if (extras.length === 0) return base;
  return [...new Set([...base, ...extras])];
}

export async function resolveWhitelist(agentPresets, escapeSet) {
  if (agentPresets === undefined) return withEscapeSet(FALLBACK_WHITELIST, escapeSet);
  const presets = await agentPresets.list();
  const base = (presets ?? []).filter((preset) => preset && preset.trust === 'system').map((preset) => preset.id);
  return withEscapeSet(base, escapeSet);
}
