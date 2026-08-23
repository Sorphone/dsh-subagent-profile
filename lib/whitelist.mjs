// lib/whitelist.mjs — F6: target-preset whitelist derived from the runtime
// roster, not hard-coded: system-trust presets when agentPresets exists, else
// the shipped fallback names. Moved verbatim from index.mjs (Task 7b);
// import-free (no @deepseek-ai dependency).
//
// Injection note: the original apply-closure version took `agentCtx` and read
// `agentCtx.get('agentPresets')` itself. The caller now injects the service —
// `resolveWhitelist(parent.ctx.get('agentPresets'))` — so the module does not
// depend on apply-closure state. `parent.ctx.get('agentPresets')` yields the
// exact same value (service or undefined), so the fallback semantics are
// unchanged. FALLBACK_WHITELIST is exported for the tests.

// F6: the target-preset whitelist is derived from the runtime roster, not
// hard-coded: system-trust presets when agentPresets exists, else the
// shipped fallback names.
export const FALLBACK_WHITELIST = ['standard', 'code', 'minimal'];

export async function resolveWhitelist(agentPresets) {
  if (agentPresets === undefined) return FALLBACK_WHITELIST;
  const presets = await agentPresets.list();
  return (presets ?? []).filter((preset) => preset && preset.trust === 'system').map((preset) => preset.id);
}
