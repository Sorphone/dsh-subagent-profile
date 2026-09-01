// lib/core/evolution-engine.mjs — 进化候选装配（生成 + 应用写路径）。
// 生成：computeAdvice 之后把每条建议推导成 ≤3 条互斥候选资产（evolution-draft），
// 逐候选过三道闸（复用 assessApplyGates 全量）后落资产域。更新策略与有效期用户
// 可配（state.json）：自动换新在「候选到期且数据显著变化」时把旧候选转 expired
// （留审计）再产新一代；手动维护不自动换代、不自动过期，只经「重新生成候选」
// 刷新（留审计）。建议链开关（evolutionAdvice）与建议面板同生共死；apply 开关
// 只门应用写路径，不门生成。
// 应用：只从受控路由进来——人工确认 → 指纹校验（编辑后过期）→ 观察期隔离 →
// 三道闸（whitelist → cost → intersection，审批永不）→ 落写新 profile 并立即
// 持久化 → 资产 draft→proposed；通过/拒绝两分支都写 suggestion-apply 审计。
// 串行化：进程级按身份键单写锁（同键排队，跨键并行）；候选池恒 system-trust
// 白名单（不叠加逃生舱放行集）；apply 只改新方案默认值，per-call 优先级不变。

import { join } from 'node:path';
import { sanitizeProfile } from './pure.mjs';
import { assertCostGuard } from './cost-guard.mjs';
import { profileFingerprint, sourceConfigFromKey } from './evolution-draft.mjs';
import { createEvolutionAssets } from './evolution-assets.mjs';
import { computeAdvice, readSummaries, recentDispatchDetails } from './evolution-advice.mjs';
import { generateCandidates, regenerateCandidates, matchingRegistryProfiles } from './evolution-generate.mjs';

// --- 三道闸（apply 口径，对齐派发守卫同源逻辑）-------------------------------

function whitelistGate(config, whitelist) {
  const preset = typeof config.preset === 'string' && config.preset !== '' ? config.preset : null;
  if (preset === null || preset === 'inherit') return { verdict: 'pass', reason: '未指定预设' };
  const allowed = whitelist instanceof Set ? whitelist.has(preset) : Array.isArray(whitelist) && whitelist.includes(preset);
  return allowed
    ? { verdict: 'pass' }
    : { verdict: 'fail', reason: `目标预设 ${preset} 不在 system-trust 白名单（候选池恒 system-trust）` };
}

// 成本闸：硬上限 + 能力面核验（与派发 cost guard 同一实现）；parent 用插件 ctx
// 占位（apply 无父会话，llm 取进程级服务）。失败不 throw，返回 verdict+reason。
async function costGate(config, llm, allowFailOpen, logger, catalog) {
  const checks = [];
  const parent = { ctx: { get: (name) => (name === 'llm' ? llm : undefined) }, options: {} };
  try {
    await assertCostGuard(parent, config, allowFailOpen, logger, catalog, (entry) => checks.push(entry));
    return { verdict: 'pass', checks };
  } catch (error) {
    return { verdict: 'fail', reason: error instanceof Error ? error.message : String(error), checks };
  }
}

// 交集闸（apply 口径）：apply 无父/子会话，真交集在派发时由宿主计算——此处按
// 工具目录作父集代理校验 toolFilter 只减不增：allow 必须全部是已知工具，
// 收窄后（去 deny/∩allow）不得为空（空集 fail-loud 语义与派发一致）。
function intersectionGate(config, toolNames) {
  const tf = config.toolFilter;
  if (tf === undefined || tf === null) {
    return { verdict: 'pass', reason: '无工具过滤器（真实交集在派发时由宿主计算）' };
  }
  const allow = Array.isArray(tf.allow) ? tf.allow : [];
  const deny = Array.isArray(tf.deny) ? tf.deny : [];
  const known = new Set(toolNames);
  const unknownAllow = allow.filter((name) => !known.has(name));
  if (unknownAllow.length > 0) {
    return { verdict: 'fail', reason: `toolFilter.allow 含未知工具：${unknownAllow.slice(0, 3).join('、')}` };
  }
  const effective = toolNames.filter((name) => !deny.includes(name) && (allow.length === 0 || allow.includes(name)));
  if (effective.length === 0) {
    return { verdict: 'fail', reason: '工具交集为空：toolFilter 收窄后无可派发工具，拒绝' };
  }
  return { verdict: 'pass' };
}

// 三道闸串行评估：whitelist → cost → intersection（approval 恒 'never'）。
// 任一失败立即返回该闸 verdict+reason；未评估的后续闸保留 skipped 占位（审计
// gates 逐项 verdict 齐全）；全过返回 gates 快照供审计。
async function assessApplyGates(deps, config) {
  const skipped = { verdict: 'skipped', reason: '前序闸未通过，未评估' };
  const gates = { whitelist: { ...skipped }, cost: { ...skipped }, intersection: { ...skipped }, approval: 'never' };
  gates.whitelist = whitelistGate(config, deps.whitelist);
  if (gates.whitelist.verdict === 'fail') return { ok: false, gates, reason: gates.whitelist.reason, checks: [] };
  gates.cost = await costGate(config, deps.getLlm(), deps.getAllowFailOpen(), deps.logger, deps.catalog);
  if (gates.cost.verdict === 'fail') return { ok: false, gates, reason: gates.cost.reason, checks: gates.cost.checks };
  const snapshot = await deps.catalog.getSnapshot();
  const toolNames = (Array.isArray(snapshot.tools) ? snapshot.tools : [])
    .map((t) => t?.name)
    .filter((name) => typeof name === 'string');
  gates.intersection = intersectionGate(config, toolNames);
  if (gates.intersection.verdict === 'fail') return { ok: false, gates, reason: gates.intersection.reason, checks: [] };
  return { ok: true, gates, checks: gates.cost.checks };
}

// --- 审计（suggestion-apply）--------------------------------------------------

function skippedGates(reason) {
  const skipped = { verdict: 'skipped', reason };
  return { whitelist: skipped, cost: skipped, intersection: skipped, approval: 'never' };
}

// suggestion-apply 事件：from/to/axis/direction/gates/human_confirmed/
// baseline_snapshot 字段级齐备；拒绝分支附 reason。
function applyAuditEntry(asset, fields) {
  const entry = {
    event: 'suggestion-apply',
    profile_id: fields.profileId !== undefined ? fields.profileId : asset.id,
    from: asset.from,
    to: asset.to,
    axis: asset.axis,
    direction: asset.direction,
    gates: fields.gates ?? skippedGates(fields.reason ?? '未评估'),
    human_confirmed: fields.humanConfirmed === true,
    baseline_snapshot: asset.baseline_snapshot,
  };
  if (fields.reason !== undefined) entry.reason = fields.reason;
  return entry;
}

// --- 应用写路径（受控路由专用；绝不自动落写）-----------------------------------

// 应用时刻指纹重算：读当前聚合（summaries）+ 当前注册表，与生成时刻指纹比对。
function currentFingerprint(deps, asset) {
  const summaries = deps.getSummaries();
  if (summaries === null) return { ok: false, reason: '聚合数据缺失，无法校验候选指纹' };
  const l1 = summaries.l1 !== null && typeof summaries.l1 === 'object' ? summaries.l1 : {};
  if (l1[asset.profile_key] === undefined) return { ok: false, reason: '候选指纹失配：聚合组已不存在' };
  const from = sourceConfigFromKey(asset.profile_key, summaries.l2);
  const registry = matchingRegistryProfiles(deps.store, asset.profile_key);
  return { ok: true, value: profileFingerprint({ profileKey: asset.profile_key, from, registryEntries: registry }) };
}

// 单次应用（在身份键锁内执行）：确认 → 观察期隔离 → 指纹校验 → 三道闸 →
// 落写 + 持久化 → 资产转 proposed；每个拒绝/通过分支都写审计。
async function applyOnce(deps, asset, humanConfirmed) {
  const audit = (entry) => deps.evoLedger.recordGovernanceAudit(entry);
  const reject = (reason, extra = {}) => {
    audit(applyAuditEntry(asset, { reason, humanConfirmed, ...extra }));
    return { ok: false, reason, ...(extra.checks !== undefined ? { checks: extra.checks } : {}) };
  };
  const expireAndReject = (reason, extra = {}) => {
    deps.assets.transition(asset.id, 'expired');
    return reject(reason, extra);
  };
  if (asset.state === 'proposed' || asset.state === 'applied') {
    return reject('该候选已处置（观察期或已应用），不能重复应用');
  }
  if (asset.state !== 'draft') return reject(`候选状态不允许应用（${String(asset.state)}）`);
  if (typeof asset.expiry === 'number' && Date.now() >= asset.expiry) {
    return expireAndReject('候选已过期，需重新生成');
  }
  if (humanConfirmed !== true) return reject('必须人工确认后才能应用（human_confirmed=true）');
  const otherProposed = deps.assets.findUnresolved(asset.profile_key)
    .some((e) => e.id !== asset.id && e.state === 'proposed');
  if (otherProposed) return reject('该方案处于观察期，禁止再次应用（观察期隔离）');
  const fingerprint = currentFingerprint(deps, asset);
  if (fingerprint.ok !== true) return expireAndReject(fingerprint.reason);
  if (fingerprint.value !== asset.profile_fingerprint) {
    return expireAndReject('候选指纹失配：方案已被编辑或聚合数据已变化，需重新生成');
  }
  if (deps.store.profiles.has(asset.config?.id)) {
    return reject('候选 profile id 已存在（请先删除或改名）');
  }
  const gates = await assessApplyGates(deps, asset.config ?? {});
  if (!gates.ok) return reject(gates.reason, { gates: gates.gates, checks: gates.checks });
  const { clean, warnings } = sanitizeProfile(
    { ...(asset.config ?? {}), name: asset.name, description: asset.description },
    { strict: true }
  );
  if (warnings.length > 0) {
    const detail = warnings.map((w) => `${w.field}：${w.reason}`).join('；');
    return reject(`写入被拒绝：${detail}`, { gates: gates.gates });
  }
  deps.store.profiles.set(clean.id, { ...clean, persisted: true });
  const persisted = deps.store.persistProfiles();
  deps.assets.transition(asset.id, 'proposed', { applied_at: Date.now() });
  audit(applyAuditEntry(asset, { profileId: clean.id, gates: gates.gates, humanConfirmed: true }));
  return { ok: true, id: clean.id, persisted: persisted?.persisted === true, state: 'proposed', checks: gates.checks };
}

// 进程级按身份键单写锁：同键 apply 排队（并发只生效一次），跨键并行。
function withApplyLock(locks, key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

// 应用入口：apply 开关门 → 读资产 → 在身份键锁内执行单次应用。
function applyCandidate(deps, locks, { assetId, humanConfirmed }) {
  if (!deps.getApplyEnabled()) return { ok: false, reason: '进化 apply 开关未开启（默认关，可在设置页开启）' };
  const asset = deps.assets.get(assetId);
  if (asset === undefined) return { ok: false, reason: '候选资产不存在（可能已过期或被清理）' };
  const key = typeof asset.profile_key === 'string' ? asset.profile_key : assetId;
  return withApplyLock(locks, key, () => applyOnce(deps, deps.assets.get(assetId), humanConfirmed === true));
}

// 进化装配 helper：资产域 + 引擎 + 建议/候选生成 helper。adviceSource 是
// /list（建议面板数据）的唯一入口——computeAdvice 之后随建议链开关把建议推导
// 成候选资产（换代判定按用户设置），避免多处重复生成；生成失败只 warn 不影响
// 建议展示（fail-soft）。注入段文本走 buildAdviceText。
export function createEvolutionAssembly({
  ctx,
  home,
  store,
  catalog,
  evoLedger,
  adviceWhitelist,
  getEvolutionAdvice,
  pluginVersion,
}) {
  const logger = ctx.logger;
  const assets = createEvolutionAssets({ dshHome: home, logger, onGovernanceFailure: () => evoLedger.markGovernanceFailure() });
  const applyEnabled = store.loadApplyEnabled();
  const summariesFile = join(home, 'subagent-evolution', 'summaries.json');
  const dispatchFile = join(home, 'subagent-evolution', 'dispatch.jsonl');
  const engine = createEvolutionEngine({
    store,
    catalog,
    assets,
    evoLedger,
    whitelist: adviceWhitelist,
    logger,
    getApplyEnabled: () => applyEnabled,
    getAdviceEnabled: getEvolutionAdvice,
    getAllowFailOpen: () => store.getAllowFailOpen(),
    getLlm: () => ctx.get('llm'),
    getSummaries: () => readSummaries(summariesFile, logger, { onLoss: () => evoLedger.markMigrationLoss() }),
    getCandidateMode: () => store.loadCandidateMode(),
    getCandidateTtlH: () => store.loadCandidateTtlH(),
    pluginVersion,
  });
  const adviceSource = async () => {
    const result = computeAdvice({ summariesFile, dispatchFile, whitelist: adviceWhitelist, logger, onLoss: () => evoLedger.markMigrationLoss() });
    // 候选生成与建议链开关同生共死（同一 getter）：面板开才生成与下发候选，
    // 面板关不悄悄生成；apply 开关只门应用写路径。
    let generated = { generated: [], skipped: [] };
    let candidates = [];
    if (getEvolutionAdvice()) {
      try {
        generated = await engine.generate({ advice: result.advice, summaries: result.summaries });
        candidates = engine.list().filter((a) => a !== null && typeof a === 'object' && a.source === 'evolution' && a.state === 'draft');
      } catch (error) {
        logger.warn(`[dsh-subagent-profile] 进化候选生成失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const adviceDetails = recentDispatchDetails(dispatchFile, result.advice.map((a) => a.profileKey), { limit: 5 }); // 近期派发明细：按建议键读台账最近 5 次（只含渲染字段，无原文）
    return { ...result, generated, candidates, adviceDetails };
  };
  return { assets, evolution: engine, adviceSource };
}

export function createEvolutionEngine({
  store,
  catalog,
  assets,
  evoLedger,
  whitelist,
  logger,
  getApplyEnabled,
  getAdviceEnabled,
  getAllowFailOpen,
  getLlm,
  getSummaries,
  pluginVersion,
  getCandidateMode = () => 'auto',
  getCandidateTtlH = () => 24,
}) {
  const deps = { store, catalog, assets, evoLedger, whitelist, logger, getApplyEnabled, getAdviceEnabled, getAllowFailOpen, getLlm, getSummaries, pluginVersion, getCandidateMode, getCandidateTtlH, assessGates: (config) => assessApplyGates(deps, config) };
  const applyLocks = new Map();
  return {
    list: () => assets.list(),
    generate: (input) => generateCandidates(deps, input),
    regenerate: (input) => regenerateCandidates(deps, input),
    apply: (input) => applyCandidate(deps, applyLocks, input),
  };
}
