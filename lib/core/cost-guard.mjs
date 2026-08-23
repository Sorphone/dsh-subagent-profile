// lib/core/cost-guard.mjs — 运行时推导的 cost guard，从 index.mjs 逐字拆出。
// 仅引用 lib/core/pure.mjs 的 assertHardLimits；无 @deepseek-ai 依赖。
//
// 运行时推导的 cost guard，两部分：
//   * always-on hard caps (assertHardLimits, in lib/core/pure.mjs) — maxTokens /
//     maxDepth are hard delegation caps, independent of the `llm` service, so
//     they must NOT stop applying when `llm` is absent（历史教训：早期版本在
//     llm 缺失时直接 return，连带跳过了硬上限，属缺陷——硬上限永远前置）。
//   * llm capability — validates provider / model / reasoningEffort against the
//     live provider directory. When the `llm` service is absent OR its provider
//     directory is empty (an adapter without discovery), capability cannot be
//     verified: per `allowFailOpen`（迁移开关）either
//     fail-open compat (warn + skip; v1 数据迁移中) or fail-loud reject. A
//     profile that requests none of provider/model/reasoningEffort has nothing
//     to verify and always passes (valid in a headless deployment).
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

// 仅当 profile 请求了需核验能力面的字段时才进入 llm 校验（无头/headless 部署下
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

// provider 注册校验（目录非空时才能判定「不在目录」）。providers 来自 catalog 快照。
function assertProviderRegistered(dir, profile) {
  if (typeof profile.provider !== 'string' || profile.provider.length === 0) return;
  if (!(dir.providers ?? []).some((provider) => provider && provider.id === profile.provider)) {
    throw new Error(`dispatch: provider "${profile.provider}" 未注册（不在当前 provider 目录中，可在设置页改用已注册的 provider）`);
  }
}

// model 校验。resolveModelInfo does not reject unknown models (catalog
//    membership is advisory), so validate against the advertised catalog
//    instead. An EMPTY catalog (adapter without discovery) cannot be verified
//    and is skipped — 目录级空集已在 llm 门走 allowFailOpen 分支，此处仅兜底
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
    throw new Error(`dispatch: 无法校验模型 "${profile.model}"：provider 目录查询失败（${modelsError instanceof Error ? modelsError.message : String(modelsError)}），可稍后重试或在设置页关闭模型能力校验`, { cause: modelsError });
  }
  const listed = models ?? [];
  const known = listed.length > 0 && listed.some((model) => model && (model.id === profile.model || model.name === profile.model));
  if (listed.length > 0 && !known) {
    throw new Error(`dispatch: 模型 "${profile.model}" 不在 provider "${String(effectiveProvider)}" 的目录中（可换用该 provider 已发布的模型）`);
  }
}

// reasoningEffort 校验。
async function assertReasoningSupported(llm, profile, effectiveProvider, effectiveModel) {
  if (typeof profile.reasoningEffort !== 'string' || profile.reasoningEffort.length === 0) return;
  try {
    await llm.resolveCallConfig({ provider: effectiveProvider, model: effectiveModel, reasoningEffort: profile.reasoningEffort });
  } catch (error) {
    throw new Error(`dispatch: reasoningEffort "${profile.reasoningEffort}" 不受 provider "${String(effectiveProvider)}" 的模型 "${String(effectiveModel)}" 支持（${error instanceof Error ? error.message : String(error)}），可改用一个该模型支持的 effort 值`, { cause: error });
  }
}

// 能力面逐项校验的统一接线：判定通过回调 verdict:'pass'；失败先回调 verdict:'fail'
// （含 error.message 作 detail）再 rethrow 原错误（文案不变）。
async function runChecked(check, field, checkedAgainst, fn) {
  try {
    await fn();
    check({ field, checkedAgainst, verdict: 'pass' });
  } catch (error) {
    check({ field, checkedAgainst, verdict: 'fail', detail: error.message });
    throw error;
  }
}

// llm 门的逐项记录：verdict 对应实际走向，detail 注明 fail-open/fail-loud。
function checkLlmGate(check, allowFailOpen, detailFailLoud, detailFailOpen) {
  check({ field: 'llm', verdict: allowFailOpen === true ? 'pass' : 'fail', detail: allowFailOpen === true ? detailFailOpen : detailFailLoud });
}

export async function assertCostGuard(parent, profile, allowFailOpen, logger, catalog, onCheck) {
  // 可选逐项回调；onCheck 缺省时归一为 no-op，行为逐字不变（现有调用点不加参数，零漂移）。
  const check = typeof onCheck === 'function' ? onCheck : () => {};

  // 硬上限 always-on（不依赖 llm）。
  assertHardLimits(profile.maxTokens, profile.maxDepth);

  // 无 llm 能力面字段 → 无可核验，直接通过（headless 部署合法）。
  if (!needsLlmCheck(profile)) {
    check({ field: 'llm', verdict: 'pass', detail: '无需核验（未请求 provider/model/reasoningEffort）' });
    return;
  }

  const llm = parent.ctx.get('llm');
  // llm 缺失 → 无法核验：按 allowFailOpen 决定 fail-open / fail-loud。
  if (llm === undefined) {
    checkLlmGate(check, allowFailOpen, 'llm 缺失：fail-loud 拒绝', 'llm 缺失：fail-open 跳过核验');
    return handleUnverifiable(allowFailOpen, logger);
  }

  // llm 存在：目录读取走共享 catalog 快照（缓存只提速目录解析，校验逻辑不变）。
  const snapshot = await catalog.getSnapshot(llm);
  const dir = snapshot.llm;
  if (dir.providersError !== undefined || dir.providers.length === 0) {
    checkLlmGate(check, allowFailOpen, 'provider 目录为空：fail-loud 拒绝', 'provider 目录为空：fail-open 跳过核验');
    return handleUnverifiable(allowFailOpen, logger);
  }

  // provider 注册校验。
  await runChecked(check, 'provider', 'catalogProviders', () => assertProviderRegistered(dir, profile));
  const effectiveProvider = profile.provider !== undefined ? profile.provider : parent.options.provider;
  const effectiveModel = profile.model !== undefined ? profile.model : parent.options.model;
  // model 校验 + reasoningEffort 校验。
  await runChecked(check, 'model', 'providerModelList', () => assertModelAdvertised(llm, profile, effectiveProvider, dir.modelsByProvider));
  await runChecked(check, 'reasoningEffort', 'resolveCallConfig', () => assertReasoningSupported(llm, profile, effectiveProvider, effectiveModel));
}
