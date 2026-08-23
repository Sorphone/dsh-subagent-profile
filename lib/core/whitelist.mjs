// lib/core/whitelist.mjs — target-preset whitelist derived from the runtime
// roster, not hard-coded: system-trust presets when agentPresets exists, else
// the shipped fallback names. Moved verbatim from index.mjs;
// import-free (no @deepseek-ai dependency).
//
// Injection note: the original apply-closure version took `agentCtx` and read
// `agentCtx.get('agentPresets')` itself. The caller now injects the service —
// `resolveWhitelist(parent.ctx.get('agentPresets'))` — so the module does not
// depend on apply-closure state. `parent.ctx.get('agentPresets')` yields the
// exact same value (service or undefined), so the fallback semantics are
// unchanged. FALLBACK_WHITELIST is exported for the tests.

// The target-preset whitelist is derived from the runtime roster, not
// hard-coded: system-trust presets when agentPresets exists, else the
// shipped fallback names.
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
