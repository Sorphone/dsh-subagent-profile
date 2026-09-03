// lib/core/evolution-canary.mjs — 金丝雀防退化域：观察期计数、判定、人工编辑中止、
// 回滚建议派生与回滚/显式保留执行、冷启动状态、hold-out 回放契约位。判据初值
// （待实测后校准）：跌破基线阈值 = 变更前加权分均值 − 1 标准差；观察期 K = 5 次
// 相关派发；滞后 N、回滚冷却见 evolution-lag.mjs。基线在 apply 时刻冻结（时间隔离
// 防自补偿）；判定只读台账、不产生派发。回滚 = 撤销一次经确认的应用：不重过三道
// 闸（配置曾通过 apply 闸），保留 sanitize strict 校验；任何路径绝不自动写 profile
// ——回滚必须 human_confirmed + suggestion-rollback 审计。写失败纪律：资产/审计走
// 既有 fail-soft 高可见通道，本域不静默吞写失败。触发分离：本域只响应金丝雀触发
// （跌破基线自动判定）；冷态沉淀（用户显式/指纹≥N）是独立线，本域不互触发。

import { sanitizeProfile } from './pure.mjs';
import { profileKeyOf, weightedSuccess } from './evolution-summary.mjs';
import { configIdentityKey, matchingRegistryProfiles, profileFingerprint, sourceConfigFromKey } from './evolution-draft.mjs';
import { ROLLBACK_COOLDOWN_MS } from './evolution-lag.mjs';

// 观察期 K：apply 后观察多少次相关派发才判定（初值，待实测后校准）。
export const CANARY_K = 5;
// 观察期内 24h 无新派发 → stalled（判定延期，不误判好/坏）。
export const CANARY_STALL_MS = 24 * 3600 * 1000;
// 判定所需最少样本数（数据稀疏时判 inconclusive 继续等待）。
export const CANARY_MIN_N = 3;
// 基线逐条分序列长度上限（控制资产文件体积；初值待实测）。
const BASELINE_SCORE_CAP = 100;
// 审计携带的样本点上限（展示截断，不丢判定结论）。
const AUDIT_SAMPLE_CAP = 20;

// 单条派发是否已结算（settle 完成：outcome.status 存在；continuable 无 outcome 不计）。
export function settledDispatch(record) {
  return record !== null && typeof record === 'object' && record.outcome !== null
    && typeof record.outcome === 'object' && typeof record.outcome.status === 'string';
}

// 单条派发表现分（基线/样本同口径 0/1）；confirmed-false −0.3 是聚合层惰性 join，逐条不可得——判据以聚合均值为准、逐条分只供标准差（初值待实测校准）。
export function sampleScoreOf(record) {
  return settledDispatch(record) && record.outcome.status === 'completed' ? 1 : 0;
}

// 总体标准差（下沿构造输入；单样本时 σ=0，下沿等于均值）。
function stddevOf(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// 基线下沿 = 加权分均值 − 1 标准差（初值，待实测后校准）；基线缺失/无逐条分返回 null → 判定降级不判。
export function baselineLowerBound(baseline) {
  const scores = Array.isArray(baseline?.scores) ? baseline.scores.filter((v) => Number.isFinite(v)) : [];
  if (typeof baseline?.weighted_success !== 'number' || !Number.isFinite(baseline.weighted_success) || scores.length === 0) return null;
  return baseline.weighted_success - stddevOf(scores);
}

// 变更前基线（apply 时刻冻结）：聚合均值/样本数 + 最近 ≤cap 条逐条分（下沿构造用）。
export function captureBaseline({ summaries, records, profileKey, now }) {
  const l1 = summaries !== null && typeof summaries === 'object' && summaries.l1 !== null && typeof summaries.l1 === 'object' ? summaries.l1 : {};
  const group = l1[profileKey] !== null && typeof l1[profileKey] === 'object' ? l1[profileKey] : {};
  const sampleN = Number.isFinite(group.confidence?.n) ? group.confidence.n : (Number.isFinite(group.deployments_total) ? group.deployments_total : null);
  const weighted = Number.isFinite(group.score?.weighted_success) ? group.score.weighted_success : null;
  const scores = (Array.isArray(records) ? records : [])
    .filter((r) => r !== null && typeof r === 'object' && settledDispatch(r) && Number.isFinite(r.ts)
      && r.ts < now && profileKeyOf(r.effective) === profileKey)
    .sort((a, b) => a.ts - b.ts)
    .slice(-BASELINE_SCORE_CAP)
    .map(sampleScoreOf);
  return { sampleN, weighted_success: weighted, scores };
}

// 变更前完整配置快照（回滚恢复依据）：身份键匹配的全部注册表方案，含 name/description/
// model/provider/preset/persona/toolFilter 等全字段（不是「保存为方案」节选段）；persisted 标记随条目留档。
export function captureFromSnapshot(store, profileKey, now) {
  const cleanList = matchingRegistryProfiles(store, profileKey);
  const values = store.profiles instanceof Map ? [...store.profiles.values()] : [];
  const byId = new Map(values.map((p) => [p.id, p]));
  return {
    v: 1,
    kind: 'full-profile-snapshots',
    profileKey,
    capturedAt: now,
    profiles: cleanList.map((config) => ({ config, persisted: byId.get(config.id)?.persisted === true })),
  };
}

// 观察样本的身份键：应用后方案配置重建（能力轴候选应用后身份键改变才计得到「应用后」派发）；无 applied_config 回退资产身份键。
export function canaryPostKey(asset) {
  const applied = asset !== null && typeof asset === 'object' ? asset.applied_config : null;
  if (applied !== null && typeof applied === 'object') {
    const key = configIdentityKey(applied);
    if (key !== null && key !== '') return key;
  }
  return typeof asset.profile_key === 'string' ? asset.profile_key : '(inline)';
}

// 观察期样本记录：appliedAt 之后、应用后身份键匹配、已结算的派发（时间升序）。
export function canarySampleRecords({ records, postKey, appliedAt }) {
  return (Array.isArray(records) ? records : [])
    .filter((r) => r !== null && typeof r === 'object' && settledDispatch(r) && Number.isFinite(r.ts)
      && r.ts >= appliedAt && profileKeyOf(r.effective) === postKey)
    .sort((a, b) => a.ts - b.ts);
}

// 累计样本点：每点 { ts, sampleN, weighted_success }（与聚合层同口径 running 聚合）。
export function canarySamplesOf(records) {
  let completed = 0;
  let failed = 0;
  let killed = 0;
  const samples = [];
  for (const record of records) {
    if (record.outcome.status === 'completed') completed += 1;
    else if (record.outcome.status === 'failed') failed += 1;
    else if (record.outcome.status === 'killed') killed += 1;
    samples.push({ ts: record.ts, sampleN: completed + failed + killed, weighted_success: weightedSuccess({ completed, failed, killed }) });
  }
  return samples;
}

// 观察期满判定（纯函数）：跌破基线下沿 → regress；≥ 基线均值 → applied；
// ±1σ 内且样本 < 基线样本 → inconclusive（延长观察）；样本不足/基线缺失不判；
// k<K 且 24h 无新派发 → stalled；k<K 正常等待 → pending。
export function decideCanary({ baseline, samples, appliedAt, now, kTotal = CANARY_K, minN = CANARY_MIN_N, stallMs = CANARY_STALL_MS } = {}) {
  const b = baseline !== null && typeof baseline === 'object' ? baseline : {};
  const lastTs = samples.length > 0 ? samples[samples.length - 1].ts : appliedAt;
  const thresholds = { mean: typeof b.weighted_success === 'number' ? b.weighted_success : null, lowerBound: baselineLowerBound(b) };
  if (samples.length < kTotal) {
    if (Number.isFinite(lastTs) && now - lastTs > stallMs) {
      return { verdict: 'stalled', reason: '观察期 24h 无新派发，判定延期（不误判好/坏）', thresholds };
    }
    return { verdict: 'pending', thresholds };
  }
  const post = samples[samples.length - 1];
  const postMetrics = { sampleN: post.sampleN, weighted_success: post.weighted_success };
  if (typeof b.sampleN !== 'number' || typeof b.weighted_success !== 'number') {
    return { verdict: 'inconclusive', reason: '应用时刻聚合缺失（基线 unknown），金丝雀不判', thresholds, postMetrics };
  }
  if (post.sampleN < minN) {
    return { verdict: 'inconclusive', reason: '样本不足，延长观察', insufficient: true, thresholds, postMetrics };
  }
  if (thresholds.lowerBound === null) {
    return { verdict: 'inconclusive', reason: '基线逐条分缺失，无法构造下沿，不判', thresholds, postMetrics };
  }
  if (post.weighted_success < thresholds.lowerBound) {
    return { verdict: 'regress', reason: '观察期表现较基线下降', thresholds, postMetrics };
  }
  if (post.weighted_success >= b.weighted_success) {
    return { verdict: 'applied', reason: '观察期表现未低于基线', thresholds, postMetrics };
  }
  if (post.sampleN < b.sampleN) {
    return { verdict: 'inconclusive', reason: '±1σ 内且样本少于基线，延长观察', insufficient: true, thresholds, postMetrics };
  }
  return { verdict: 'applied', reason: '观察期表现未跌破基线下沿', thresholds, postMetrics };
}

// 回滚审计闸位占位：回滚不重过三道闸（配置曾通过 apply 闸），sanitize strict 保留。
export function skippedGates(reason) {
  const skipped = { verdict: 'skipped', reason };
  return { whitelist: skipped, cost: skipped, intersection: skipped, approval: 'never' };
}

// 应用后方案是否仍与写入时一致（人工编辑过/被删除 → 不一致，回滚与判定中止）。
function appliedConfigMatches(deps, asset) {
  const applied = asset.applied_config;
  if (applied === null || typeof applied !== 'object' || typeof applied.id !== 'string' || applied.id === '') return false;
  const current = deps.store?.profiles instanceof Map ? deps.store.profiles.get(applied.id) : undefined;
  if (current === undefined) return false;
  const { clean } = sanitizeProfile(current, { strict: false });
  return JSON.stringify(clean) === JSON.stringify(applied);
}

// 观察期前变更前方案指纹是否未变（排除应用写入的方案自身）；聚合缺失不中止（基线 unknown 由判定降级），组消失也不视为人工编辑。
function preApplyFingerprintMatches(deps, asset) {
  const summaries = deps.getSummaries?.();
  if (summaries === null || summaries === undefined) return true;
  const l1 = summaries.l1;
  if (l1 === null || typeof l1 !== 'object' || l1[asset.profile_key] === undefined) return true;
  const appliedId = asset.applied_config !== null && typeof asset.applied_config === 'object' ? asset.applied_config.id : null;
  const registry = matchingRegistryProfiles(deps.store, asset.profile_key).filter((p) => p.id !== appliedId);
  const from = sourceConfigFromKey(asset.profile_key, summaries.l2);
  return profileFingerprint({ profileKey: asset.profile_key, from, registryEntries: registry }) === asset.profile_fingerprint;
}

// 人工编辑中止判据：应用后方案被改 / 相关方案指纹变化 → 观测已脏，返回原因。
function canaryAbortReason(deps, asset) {
  if (!appliedConfigMatches(deps, asset)) return '应用后方案已被人工编辑（配置与写入时不一致）';
  if (!preApplyFingerprintMatches(deps, asset)) return '该身份键相关方案在观察期内被人工编辑';
  return null;
}

// golden-canary 治理审计事件：判定结果留痕（写失败走治理审计三件套）。
function goldenCanaryAuditEntry(asset, { verdict, reason, samples, postMetrics, thresholds }) {
  const baseline = asset.baseline_metrics !== null && typeof asset.baseline_metrics === 'object' ? asset.baseline_metrics : {};
  const entry = {
    event: 'golden-canary',
    asset_id: asset.id,
    profile_key: asset.profile_key,
    baseline_metrics: { sampleN: baseline.sampleN ?? null, weighted_success: baseline.weighted_success ?? null },
    samples: (Array.isArray(samples) ? samples : []).slice(-AUDIT_SAMPLE_CAP),
    post_metrics: postMetrics ?? null,
    verdict,
    thresholds: thresholds ?? null,
  };
  if (reason !== undefined && reason !== null) entry.reason = reason;
  return entry;
}

// 人工编辑中止落账：资产标 invalid + 金丝雀判定中止（不沿用旧基线）+ 审计。
function abortCanary(deps, asset, reason, now) {
  const canary = { ...(asset.canary ?? {}), verdict: 'aborted-human-edit', abort_reason: reason, aborted_at: now };
  deps.assets.transition(asset.id, 'proposed', { canary, invalid: true });
  deps.evoLedger.recordGovernanceAudit(goldenCanaryAuditEntry(asset, {
    verdict: 'aborted-human-edit', reason, samples: canary.samples ?? [], postMetrics: null, thresholds: null,
  }));
  return { evaluated: true, verdict: 'aborted-human-edit', reason };
}

// 金丝雀推进：中止检查 → 重算样本 → 判定 → 资产/金丝雀状态落账 → 审计（幂等：状态无变化不重复落账，verdict 或判定样本数变化才写 golden-canary）。
export function evaluateCanary(deps, asset, now = Date.now()) {
  const canary = asset.canary;
  if (asset.state !== 'proposed' || canary === null || typeof canary !== 'object') return { evaluated: false };
  if (asset.invalid === true && canary.verdict === 'aborted-human-edit') return { evaluated: false };
  const abortReason = canaryAbortReason(deps, asset);
  if (abortReason !== null) return abortCanary(deps, asset, abortReason, now);
  const appliedAt = Number.isFinite(canary.appliedAt) ? canary.appliedAt
    : (Number.isFinite(asset.applied_at) ? asset.applied_at : (Number.isFinite(asset.updatedAt) ? asset.updatedAt : now));
  const records = deps.getDispatchRecords?.() ?? [];
  const samples = canarySamplesOf(canarySampleRecords({ records, postKey: canaryPostKey(asset), appliedAt }));
  const decision = decideCanary({ baseline: canary.baseline ?? {}, samples, appliedAt, now });
  if (decision.verdict === 'pending') {
    if (samples.length === (canary.k ?? 0) && (canary.verdict ?? null) === null) return { evaluated: false };
    deps.assets.transition(asset.id, 'proposed', { canary: { ...canary, k: samples.length, kTotal: canary.kTotal ?? CANARY_K, samples, verdict: null, stalled: false } });
    return { evaluated: true, verdict: 'pending' };
  }
  const judged = decision.postMetrics !== undefined ? decision.postMetrics.sampleN : samples.length;
  const next = {
    ...canary,
    k: samples.length,
    kTotal: canary.kTotal ?? CANARY_K,
    samples,
    verdict: decision.verdict,
    stalled: decision.verdict === 'stalled',
    judged_sample_n: judged,
    judged_at: now, rollback_reminder_sent: canary.rollback_reminder_sent === true || decision.verdict === 'regress',
    ...(decision.insufficient === true ? { insufficient: true } : { insufficient: false }),
  };
  deps.assets.transition(asset.id, decision.verdict === 'applied' ? 'applied' : 'proposed', { canary: next });
  const audited = decision.verdict !== (canary.verdict ?? null) || judged !== (canary.judged_sample_n ?? null);
  if (audited) {
    deps.evoLedger.recordGovernanceAudit(goldenCanaryAuditEntry(asset, {
      verdict: decision.verdict, reason: decision.reason, samples, postMetrics: decision.postMetrics, thresholds: decision.thresholds,
    }));
  }
  // 回滚建议生成时提醒一次（观察中/保留/中止不提醒）；mint 失败不阻断判定（fail-soft）。
  if (decision.verdict === 'regress' && canary.rollback_reminder_sent !== true) { try { deps.mintRollbackReminder?.(asset); } catch { /* 提醒 mint 失败不影响判定 */ } }
  return { evaluated: true, verdict: decision.verdict, audited };
}

// 回滚建议条目派生（只读数据源，UI 由建议面板消费；绝不自动执行回滚）。
export function rollbackSuggestionOf(asset) {
  const canary = asset !== null && typeof asset === 'object' ? asset.canary : null;
  if (asset === null || typeof asset !== 'object' || asset.state !== 'proposed' || asset.invalid === true) return null;
  if (canary === null || typeof canary !== 'object' || canary.verdict !== 'regress') return null;
  const samples = Array.isArray(canary.samples) ? canary.samples : [];
  const post = samples.length > 0 ? samples[samples.length - 1] : null;
  const baseline = asset.baseline_metrics !== null && typeof asset.baseline_metrics === 'object' ? asset.baseline_metrics : {};
  const delta = post !== null && Number.isFinite(baseline.weighted_success)
    ? Number((post.weighted_success - baseline.weighted_success).toFixed(3)) : null;
  return {
    assetId: asset.id,
    profileKey: asset.profile_key,
    from: asset.applied_config ?? null,
    to: asset.fromSnapshot ?? null,
    reason: '观察期表现较基线下降',
    evidence: {
      baseline: { sampleN: baseline.sampleN ?? null, weighted_success: baseline.weighted_success ?? null },
      post: post === null ? null : { sampleN: post.sampleN, weighted_success: post.weighted_success },
      delta,
      samples,
    },
    createdAt: canary.judged_at ?? asset.updatedAt ?? null,
    axis: asset.axis,
    direction: asset.direction,
  };
}

// suggestion-rollback 审计条目（通过/拒绝双分支；gates 默认 skipped——回滚不重过
// 三道闸，配置曾通过 apply 闸）。
function rollbackAuditEntry(asset, humanConfirmed, reason, extra = {}) {
  const entry = {
    event: 'suggestion-rollback',
    profile_id: asset.id,
    from: asset.applied_config ?? null,
    to: asset.fromSnapshot ?? null,
    axis: asset.axis,
    direction: asset.direction,
    gates: extra.gates ?? skippedGates(reason ?? '未评估'),
    human_confirmed: humanConfirmed === true,
  };
  if (reason !== undefined && reason !== null) entry.reason = reason;
  return entry;
}

// suggestion-keep 审计条目：用户显式保留当前配置（不认同回滚判断）的留痕；拒绝分支 reason = 拒绝原因，通过分支 reason = 'user-kept'。
function keepAuditEntry(asset, humanConfirmed, reason) {
  return {
    event: 'suggestion-keep',
    asset_id: asset.id,
    profile_key: asset.profile_key,
    human_confirmed: humanConfirmed === true,
    reason: reason ?? 'user-kept',
  };
}

// 恢复 fromSnapshot：逐条 sanitize strict（回滚不重过三道闸，strict 保留）→ 移除
// 应用写入的方案 → 恢复快照方案（含 persisted 语义）→ 持久化。
function restoreFromSnapshot(deps, asset) {
  const snapshot = asset.fromSnapshot;
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.profiles)) {
    return { ok: false, reason: '回滚快照缺失或形状不符，拒绝回滚' };
  }
  const entries = [];
  for (const item of snapshot.profiles) {
    if (item === null || typeof item !== 'object' || item.config === null || typeof item.config !== 'object'
      || typeof item.config.id !== 'string' || item.config.id === '') {
      return { ok: false, reason: '回滚快照条目形状不符，拒绝回滚' };
    }
    const { clean, warnings } = sanitizeProfile(item.config, { strict: true });
    if (warnings.length > 0) {
      return { ok: false, reason: '回滚快照未通过 sanitize strict 校验（' + String(warnings[0].field) + '），拒绝回滚' };
    }
    entries.push({ config: clean, persisted: item.persisted === true });
  }
  const appliedId = asset.applied_config !== null && typeof asset.applied_config === 'object' ? asset.applied_config.id : null;
  if (typeof appliedId === 'string' && appliedId !== '') deps.store.profiles.delete(appliedId);
  for (const entry of entries) deps.store.profiles.set(entry.config.id, { ...entry.config, persisted: entry.persisted });
  const persisted = deps.store.persistProfiles();
  return { ok: true, restored: entries.map((e) => e.config.id), persisted: persisted?.persisted === true };
}

// 决议公共校验（回滚与显式保留同口径）：人工确认 → 观察期状态 → 判定 regress →
// 当前配置未被动过；返回 null = 通过，否则为拒绝原因。
function resolutionChecks(deps, asset, humanConfirmed, confirmVerb) {
  if (humanConfirmed !== true) return `必须人工确认后才能${confirmVerb}（human_confirmed=true）`;
  if (asset.state !== 'proposed') return `资产状态不允许${confirmVerb}（仅观察期 proposed 可执行）`;
  if (asset.invalid === true || asset.canary?.verdict === 'aborted-human-edit') {
    return '观察期已因人工编辑中止，不支持一键回滚（请手动编辑恢复）';
  }
  if (asset.canary?.verdict !== 'regress') return '金丝雀尚未判定为回退（verdict 非 regress），拒绝执行';
  if (!appliedConfigMatches(deps, asset) || !preApplyFingerprintMatches(deps, asset)) {
    return '当前方案已被编辑，不支持一键回滚';
  }
  return null;
}

// 显式保留（action=keep）：用户不认同回滚判断，保留当前配置。不写 profile、不重过
// 三道闸；资产 proposed→applied + suggestion-keep 审计，同键冷却照常（与回滚同口径）。
function executeKeep(deps, asset, now) {
  const transitioned = deps.assets.transition(asset.id, 'applied', {
    keep_at: now,
    cooldown_until: now + ROLLBACK_COOLDOWN_MS,
    canary: { ...(asset.canary ?? {}), kept_at: now },
  });
  deps.evoLedger.recordGovernanceAudit(keepAuditEntry(asset, true, 'user-kept'));
  try {
    deps.injectRollbackCooldown?.(asset.profile_key, now + ROLLBACK_COOLDOWN_MS);
  } catch { /* 冷却注入失败不阻断保留（fail-soft；候选生成侧另有资产级冷却判据） */ }
  return { ok: true, action: 'keep', state: 'applied', assetPersisted: transitioned.persisted };
}

// 决议执行（受控路由专用；绝不自动落写）：action='keep' 走显式保留，缺省走回滚。
// 人工确认 → 公共校验 → 回滚：恢复快照 + 持久化 → rolled_back；保留：applied。
// 两分支都写各自审计 + 同键冷却注入建议侧。
export function executeRollback(deps, asset, humanConfirmed, action = 'rollback', now = Date.now()) {
  const keep = action === 'keep';
  const audit = (entry) => deps.evoLedger.recordGovernanceAudit(entry);
  const reject = (reason) => {
    audit(keep ? keepAuditEntry(asset, humanConfirmed, reason) : rollbackAuditEntry(asset, humanConfirmed, reason));
    return { ok: false, reason };
  };
  const check = resolutionChecks(deps, asset, humanConfirmed, keep ? '保留当前方案' : '回滚');
  if (check !== null) return reject(check);
  if (keep) return executeKeep(deps, asset, now);
  const restore = restoreFromSnapshot(deps, asset);
  if (!restore.ok) return reject(restore.reason);
  const transitioned = deps.assets.transition(asset.id, 'rolled_back', {
    rollback_at: now,
    canary: { ...(asset.canary ?? {}), rollback_at: now },
  });
  audit(rollbackAuditEntry(asset, humanConfirmed, null, { gates: skippedGates('回滚不重过三道闸：配置曾通过 apply 闸，只做 sanitize strict 校验') }));
  try {
    deps.injectRollbackCooldown?.(asset.profile_key, now + ROLLBACK_COOLDOWN_MS);
  } catch { /* 冷却注入失败不阻断回滚（fail-soft；候选生成侧另有资产级冷却判据） */ }
  return { ok: true, state: 'rolled_back', restored: restore.restored, persisted: restore.persisted, assetPersisted: transitioned.persisted };
}

// 冷启动状态（只读暴露，UI 展示归设置面板）：apply/防退化可用性 + 原因清单；minN
// 不足或聚合缺失 → 双禁用并给出原因，不清除既有建议/候选。
export function evolutionStatusOf({ getApplyEnabled, summaries, minN = CANARY_MIN_N }) {
  const switchOn = getApplyEnabled?.() === true;
  const reasons = [];
  const l1 = summaries !== null && typeof summaries === 'object' && summaries.l1 !== null && typeof summaries.l1 === 'object' ? summaries.l1 : {};
  const ready = Object.values(l1).some((g) => g !== null && typeof g === 'object' && (Number.isFinite(g.confidence?.n) ? g.confidence.n : 0) >= minN);
  if (!switchOn) reasons.push('进化 apply 开关未开启（默认关，可在设置页开启）');
  if (summaries === null || summaries === undefined) reasons.push('聚合数据缺失，暂不支持应用与金丝雀判定');
  else if (!ready) reasons.push('派发数据不足（各配置样本 < ' + minN + '），暂不支持应用');
  return { applyEnabled: switchOn && ready, canaryEnabled: ready, reasons };
}

// hold-out 回放契约位（只读 stub）：真实回放引擎与阈值待实测后回填；本函数只
// 验收契约——结果不落写（纯函数零 IO）、规则窗口与验证窗口按时间隔离。
export function holdoutBacktest(records, candidateConfig, { splitTs = null } = {}) {
  const list = Array.isArray(records) ? records : [];
  let split = Number.isFinite(splitTs) ? splitTs : null;
  if (split === null) {
    const stamps = list.map((r) => (r !== null && typeof r === 'object' ? r.ts : null)).filter((ts) => Number.isFinite(ts)).sort((a, b) => a - b);
    split = stamps.length > 0 ? stamps[Math.floor(stamps.length / 2)] : Date.now();
  }
  const withTs = list.filter((r) => r !== null && typeof r === 'object' && Number.isFinite(r.ts));
  const trainingCount = withTs.filter((r) => r.ts < split).length;
  const holdoutCount = withTs.filter((r) => r.ts >= split).length;
  return {
    v: 1,
    engine: 'stub',
    readOnly: true,
    conclusion: '回放引擎与阈值待实测后回填；本结果只验收契约（只读不落写 + 规则/验证时间隔离）',
    candidateKey: candidateConfig !== null && typeof candidateConfig === 'object' ? configIdentityKey(candidateConfig) : null,
    boundary: { splitTs: split, trainingCount, holdoutCount, ruleWindow: 'ts < splitTs', validationWindow: 'ts >= splitTs' },
    verdict: 'hold',
  };
}
