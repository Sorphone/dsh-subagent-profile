// lib/core/cost-guard.mjs — 运行时推导的 cost guard，从 index.mjs 逐字拆出。
// 仅引用 lib/core/pure.mjs 的 assertHardLimits；无 @deepseek-ai 依赖。
//
// 运行时推导的 cost guard，两部分：
//   ① always-on hard caps (assertHardLimits, in lib/core/pure.mjs) — maxTokens /
//      maxDepth are hard delegation caps, independent of the `llm` service, so
//      they must NOT stop applying when `llm` is absent（历史教训：早期版本在
//      llm 缺失时直接 return，连带跳过了硬上限，属缺陷——硬上限永远前置）。
//   ② llm capability — validates provider / model / reasoningEffort against the
//      live provider directory. When the `llm` service is absent OR its provider
//      directory is empty (an adapter without discovery), capability cannot be
//      verified: per `allowFailOpen`（迁移开关）either
//      fail-open compat (warn + skip; v1 数据迁移中) or fail-loud reject. A
//      profile that requests none of provider/model/reasoningEffort has nothing
//      to verify and always passes (valid in a headless deployment).
//
// 目录读取改走共享 catalog 快照（lib/core/catalog-cache.mjs）：assertCostGuard 的
// `catalog` 参数是缓存实例，`catalog.getSnapshot(llm)` 返回缓存过的 providers /
// modelsByProvider。缓存只提速目录解析、不复检安全门——provider/model/effort 的
// 校验逻辑与 fail-loud 文案逐字不变；reasoningEffort 走直连 resolveCallConfig
// （校验调用，非目录读取，不入缓存）。
// Used by both the provider's authoritative check and the dispatch tool's
// pre-check. `allowFailOpen`/`logger` are injected because this function is
// module-scoped and cannot reach the apply closure's `allowFailOpen`/`ctx.logger`.

import { assertHardLimits } from './pure.mjs';

// ② 仅当 profile 请求了需核验能力面的字段时才进入 llm 校验（无头/headless 部署下
// persona-only / toolFilter-only 的 profile 合法，不应被 fail-loud 拒绝）。
function needsLlmCheck(profile) {
  return ['provider', 'model', 'reasoningEffort'].some(
    (key) => typeof profile[key] === 'string' && profile[key].length > 0
  );
}

// llm 缺失或目录为空时统一走 allowFailOpen 门（fail-open warn 或 fail-loud 拒绝）。
function handleUnverifiable(allowFailOpen, logger) {
  if (allowFailOpen === true) {
    logger.warn('llm 不可用：fail-open 兼容模式（v1 数据迁移中，建议保存一次配置以升级到 fail-loud）');
    return;
  }
  throw new Error('dispatch: 模型能力不可验证：fail-loud 拒绝（可在配置中显式开启兼容模式）');
}

// ④ provider 注册校验（目录非空时才能判定「不在目录」）。providers 来自 catalog 快照。
function assertProviderRegistered(dir, profile) {
  if (typeof profile.provider !== 'string' || profile.provider.length === 0) return;
  if (!(dir.providers ?? []).some((provider) => provider && provider.id === profile.provider)) {
    throw new Error(`dispatch: provider "${profile.provider}" is not a registered provider`);
  }
}

// ⑤ model 校验。resolveModelInfo does not reject unknown models (catalog
//    membership is advisory), so validate against the advertised catalog
//    instead. An EMPTY catalog (adapter without discovery) cannot be verified
//    and is skipped — 目录级空集已在 ③ 走 allowFailOpen 分支，此处仅兜底
//    per-provider 空目录。A non-empty catalog that does not advertise the model
//    fails loud. An unverifiable lookup (listModels(undefined) when no provider
//    is known) becomes a clean fail-loud error instead of leaking "undefined".
//    modelsByProvider 来自快照；快照未覆盖的 provider（undefined / 不在名册）
//    走直连 listModels 兜底，保持原 fail-loud 文案逐字。
async function assertModelAdvertised(llm, profile, effectiveProvider, modelsByProvider) {
  if (typeof profile.model !== 'string' || profile.model.length === 0) return;
  const cached = modelsByProvider !== undefined ? modelsByProvider[String(effectiveProvider)] : undefined;
  let models;
  let modelsError;
  if (cached !== undefined) {
    if (cached.ok === true) models = cached.models;
    else modelsError = cached.error;
  } else {
    try {
      models = await llm.listModels(effectiveProvider);
    } catch (error) {
      modelsError = error;
    }
  }
  if (modelsError !== undefined) {
    throw new Error(`dispatch: cannot validate model "${profile.model}" without a provider: ${modelsError instanceof Error ? modelsError.message : String(modelsError)}`, { cause: modelsError });
  }
  const listed = models ?? [];
  const known = listed.length > 0 && listed.some((model) => model && (model.id === profile.model || model.name === profile.model));
  if (listed.length > 0 && !known) {
    throw new Error(`dispatch: model "${profile.model}" is not advertised by provider "${String(effectiveProvider)}"`);
  }
}

// ⑥ reasoningEffort 校验。
async function assertReasoningSupported(llm, profile, effectiveProvider, effectiveModel) {
  if (typeof profile.reasoningEffort !== 'string' || profile.reasoningEffort.length === 0) return;
  try {
    await llm.resolveCallConfig({ provider: effectiveProvider, model: effectiveModel, reasoningEffort: profile.reasoningEffort });
  } catch (error) {
    throw new Error(`dispatch: reasoningEffort "${profile.reasoningEffort}" is not supported by provider "${String(effectiveProvider)}" model "${String(effectiveModel)}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function assertCostGuard(parent, profile, allowFailOpen, logger, catalog) {
  // ① 硬上限 always-on（不依赖 llm）。
  assertHardLimits(profile.maxTokens, profile.maxDepth);

  // ② 无 llm 能力面字段 → 无可核验，直接通过（headless 部署合法）。
  if (!needsLlmCheck(profile)) return;

  const llm = parent.ctx.get('llm');
  // ③ llm 缺失 → 无法核验：按 allowFailOpen 决定 fail-open / fail-loud。
  if (llm === undefined) return handleUnverifiable(allowFailOpen, logger);

  // llm 存在：目录读取走共享 catalog 快照（缓存只提速目录解析，校验逻辑不变）。
  const snapshot = await catalog.getSnapshot(llm);
  const dir = snapshot.llm;
  if (dir.providersError !== undefined || dir.providers.length === 0) {
    return handleUnverifiable(allowFailOpen, logger);
  }

  // ④ provider 注册校验。
  assertProviderRegistered(dir, profile);
  const effectiveProvider = profile.provider !== undefined ? profile.provider : parent.options.provider;
  const effectiveModel = profile.model !== undefined ? profile.model : parent.options.model;
  // ⑤ model 校验 + ⑥ reasoningEffort 校验。
  await assertModelAdvertised(llm, profile, effectiveProvider, dir.modelsByProvider);
  await assertReasoningSupported(llm, profile, effectiveProvider, effectiveModel);
}
