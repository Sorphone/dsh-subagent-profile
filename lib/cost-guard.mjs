// lib/cost-guard.mjs — F5: runtime-derived cost guard (SPEC §7.3), moved
// verbatim from index.mjs (Task 7b). Local lib reference only: imports
// assertHardLimits from lib/pure.mjs; no @deepseek-ai dependency.

// F5: runtime-derived cost guard. Two parts (SPEC §7.3):
//   ① always-on hard caps (assertHardLimits, in lib/pure.mjs) — maxTokens /
//      maxDepth are hard delegation caps, independent of the `llm` service, so
//      they must NOT stop applying when `llm` is absent (the old `if (llm ===
//      undefined) return` skipped them).
//   ② llm capability — validates provider / model / reasoningEffort against the
//      live provider directory. When the `llm` service is absent OR its provider
//      directory is empty (an adapter without discovery), capability cannot be
//      verified: per `allowFailOpen` (SPEC §12.1 migration switch) either
//      fail-open compat (warn + skip; v1 数据迁移中) or fail-loud reject. A
//      profile that requests none of provider/model/reasoningEffort has nothing
//      to verify and always passes (valid in a headless deployment).
// Used by both the provider's authoritative check and the dispatch tool's
// pre-check. `allowFailOpen`/`logger` are injected because this function is
// module-scoped and cannot reach the apply closure's `allowFailOpen`/`ctx.logger`.

import { assertHardLimits } from './pure.mjs';

export async function assertCostGuard(parent, profile, allowFailOpen, logger) {
  // ① 硬上限 always-on（不依赖 llm）。
  assertHardLimits(profile.maxTokens, profile.maxDepth);

  // ② 仅当 profile 请求了需核验能力面的字段时才进入 llm 校验（无头/headless 部署下
  //    persona-only / toolFilter-only 的 profile 合法，不应被 fail-loud 拒绝）。
  const needsLlm = ['provider', 'model', 'reasoningEffort'].some(
    (key) => typeof profile[key] === 'string' && profile[key].length > 0
  );
  if (!needsLlm) return;

  const llm = parent.ctx.get('llm');
  // ③ 目录为空检测：llm 存在但其 provider 目录为空（无发现能力）→ 无法核验。
  let emptyDirectory = false;
  if (llm !== undefined) {
    try {
      const providers = await llm.listProviders();
      emptyDirectory = (providers ?? []).length === 0;
    } catch {
      emptyDirectory = true;
    }
  }
  if (llm === undefined || emptyDirectory) {
    if (allowFailOpen === true) {
      logger.warn('llm 不可用：fail-open 兼容模式（v1 数据迁移中，建议保存一次配置以升级到 fail-loud）');
      return;
    }
    throw new Error('dispatch: 模型能力不可验证：fail-loud 拒绝（可在配置中显式开启兼容模式）');
  }

  // ④ provider 注册校验（目录非空时才能判定「不在目录」）。
  if (typeof profile.provider === 'string' && profile.provider.length > 0) {
    const providers = await llm.listProviders();
    if (!(providers ?? []).some((provider) => provider && provider.id === profile.provider)) {
      throw new Error(`dispatch: provider "${profile.provider}" is not a registered provider`);
    }
  }
  const effectiveProvider = profile.provider !== undefined ? profile.provider : parent.options.provider;
  const effectiveModel = profile.model !== undefined ? profile.model : parent.options.model;
  // ⑤ model 校验。resolveModelInfo does not reject unknown models (catalog
  //    membership is advisory), so validate against the advertised catalog
  //    instead. An EMPTY catalog (adapter without discovery) cannot be verified
  //    and is skipped — 目录级空集已在 ③ 走 allowFailOpen 分支，此处仅兜底
  //    per-provider 空目录。A non-empty catalog that does not advertise the model
  //    fails loud. An unverifiable lookup (listModels(undefined) when no provider
  //    is known) becomes a clean fail-loud error instead of leaking "undefined".
  if (typeof profile.model === 'string' && profile.model.length > 0) {
    let models;
    try {
      models = await llm.listModels(effectiveProvider);
    } catch (error) {
      throw new Error(`dispatch: cannot validate model "${profile.model}" without a provider: ${error instanceof Error ? error.message : String(error)}`);
    }
    const listed = models ?? [];
    const known = listed.length > 0 && listed.some((model) => model && (model.id === profile.model || model.name === profile.model));
    if (listed.length > 0 && !known) {
      throw new Error(`dispatch: model "${profile.model}" is not advertised by provider "${String(effectiveProvider)}"`);
    }
  }
  // ⑥ reasoningEffort 校验。
  if (typeof profile.reasoningEffort === 'string' && profile.reasoningEffort.length > 0) {
    try {
      await llm.resolveCallConfig({ provider: effectiveProvider, model: effectiveModel, reasoningEffort: profile.reasoningEffort });
    } catch (error) {
      throw new Error(`dispatch: reasoningEffort "${profile.reasoningEffort}" is not supported by provider "${String(effectiveProvider)}" model "${String(effectiveModel)}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
