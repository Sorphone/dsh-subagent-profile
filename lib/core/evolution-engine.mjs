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
// 金丝雀：apply 冻结基线（聚合 + 逐条分）与完整配置快照；观察期 K 次相关派发后
// 判定（跌破基线下沿 → 回滚建议只读挂面板，绝不自动回滚）；回滚需 human_confirmed，
// 恢复快照 + suggestion-rollback 审计。滞后/回滚冷却在 evolution-lag.mjs，判定与
// 回滚本体在 evolution-canary.mjs，cold-start 状态经 evolutionStatus 暴露。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { sanitizeProfile } from './pure.mjs';
import { parseDispatchRecords } from './evolution-summary.mjs';
import { assertCostGuard } from './cost-guard.mjs';
import { matchingRegistryProfiles, profileFingerprint, sourceConfigFromKey } from './evolution-draft.mjs';
import { createEvolutionAssets } from './evolution-assets.mjs';
import { computeAdvice, readSummaries, recentDispatchDetails, writeBackCooldowns, writeBackStreaks } from './evolution-advice.mjs';
import { generateCandidates, regenerateCandidates } from './evolution-generate.mjs';
import { CANARY_K, captureBaseline, captureFromSnapshot, evaluateCanary, executeRollback, evolutionStatusOf, holdoutBacktest, skippedGates } from './evolution-canary.mjs';
import { LAG_N, bumpStreak, createLagStreaks, directionOf, rollbackCooldownBlocks } from './evolution-lag.mjs';

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
// skippedGates 与金丝雀域同源（evolution-canary.mjs），apply/回滚审计闸位口径一致。

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

// 应用数据充分性（冷启动门）：该身份键聚合样本不足 3 → 拒绝应用（数据地基
// 缺失时应用/防退化不可用，状态经 evolutionStatus 暴露）。
function applyDataReadiness(deps, asset) {
  const summaries = deps.getSummaries();
  if (summaries === null) return { ok: false, reason: '聚合数据缺失，暂不支持应用（需积累派发数据）' };
  const l1 = summaries.l1 !== null && typeof summaries.l1 === 'object' ? summaries.l1 : {};
  const group = l1[asset.profile_key];
  if (group === null || typeof group !== 'object') return { ok: false, reason: '聚合组缺失，暂不支持应用' };
  const n = Number.isFinite(group.confidence?.n) ? group.confidence.n : (Number.isFinite(group.deployments_total) ? group.deployments_total : 0);
  if (n < 3) return { ok: false, reason: `派发数据不足（当前 ${n} 次，需 ≥3），暂不支持应用` };
  return { ok: true };
}

// 单次应用（在身份键锁内执行）：确认 → 观察期隔离 → 指纹校验 → 数据充分性 →
// 三道闸 → 基线/快照冻结 → 落写 + 持久化 → 资产转 proposed（挂金丝雀初值）；
// 每个拒绝/通过分支都写审计。
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
  const data = applyDataReadiness(deps, asset);
  if (!data.ok) return reject(data.reason);
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
  return applyWrite(deps, asset, clean, gates, audit);
}

// 落写 + 基线/快照冻结 + 资产转 proposed（挂金丝雀初值）+ 通过审计。基线/快照
// 在写前冻结：fromSnapshot = 完整配置快照（回滚恢复依据）、baseline = apply 时刻
// 聚合 + 逐条分（金丝雀下沿构造依据），时间隔离防自补偿。
async function applyWrite(deps, asset, clean, gates, audit) {
  const now = Date.now();
  const fromSnapshot = captureFromSnapshot(deps.store, asset.profile_key, now);
  const baseline = captureBaseline({
    summaries: deps.getSummaries(),
    records: deps.getDispatchRecords?.() ?? [],
    profileKey: asset.profile_key,
    now,
  });
  deps.store.profiles.set(clean.id, { ...clean, persisted: true });
  const persisted = deps.store.persistProfiles();
  deps.assets.transition(asset.id, 'proposed', {
    applied_at: now,
    fromSnapshot,
    baseline_metrics: { sampleN: baseline.sampleN ?? null, weighted_success: baseline.weighted_success ?? null },
    applied_config: { ...clean },
    canary: { k: 0, kTotal: CANARY_K, appliedAt: now, baseline, samples: [], verdict: null, stalled: false, insufficient: false },
  });
  audit(applyAuditEntry(asset, { profileId: clean.id, gates: gates.gates, humanConfirmed: true }));
  return { ok: true, id: clean.id, persisted: persisted?.persisted === true, state: 'proposed', checks: gates.checks };
}

// 台账轮转封存件文件名（与 evolution-persistence 轮转同口径）。
const ARCHIVE_PATTERN = /^dispatch-(\d+)-(\d+)(?:-\d+)?\.jsonl$/;

// 派发台账只读解析（金丝雀基线/样本数据源）：活动台账 + 轮转封存件合并读取，观察
// 期跨轮转不丢样本；单文件缺失/损坏跳过，整体缺失回退空表，fail-soft。
function readDispatchRecords(file) {
  if (typeof file !== 'string') return [];
  const dir = dirname(file);
  const names = [basename(file)];
  try {
    for (const name of readdirSync(dir)) if (ARCHIVE_PATTERN.test(name)) names.push(name);
  } catch { /* 目录读失败只读活动台账 */ }
  const records = [];
  for (const name of names) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      records.push(...parseDispatchRecords(readFileSync(path, 'utf8').split('\n')).records);
    } catch { /* 单文件读失败跳过，不影响其余 */ }
  }
  return records;
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

// 决议入口（受控路由专用；回滚=撤销已确认应用，keep=显式保留）：读资产 → 身份键
// 锁内执行（与 apply 共用同一锁串行化）。不受 apply 开关门限制——决议是闭环收口路径。
function rollbackCandidate(deps, locks, { assetId, humanConfirmed, action = 'rollback' }) {
  const asset = deps.assets.get(assetId);
  if (asset === undefined) return { ok: false, reason: '回滚资产不存在（可能已过期或被清理）' };
  const key = typeof asset.profile_key === 'string' ? asset.profile_key : assetId;
  return withApplyLock(locks, key, () => executeRollback(deps, deps.assets.get(assetId), humanConfirmed === true, action));
}

// 金丝雀推进入口：遍历观察期（proposed + 金丝雀未终）资产逐条判定；幂等，可安全
// 随 /list 与资产列表多次调用。
function evaluateCanaries(deps, now = Date.now()) {
  const results = [];
  for (const asset of deps.assets.list()) {
    if (asset !== null && typeof asset === 'object' && asset.state === 'proposed') {
      results.push(evaluateCanary(deps, asset, now));
    }
  }
  return results;
}

// 候选生成前置闸（滞后防振荡）：cooldown 优先抑制（回滚冷却轮不计数），连续同方向
// 建议不足 N 次不产候选；人工强制键（重新生成候选）豁免。
async function generateWithLag(deps, input) {
  const advice = Array.isArray(input?.advice) ? input.advice : [];
  const summaries = input?.summaries ?? deps.getSummaries?.() ?? null;
  const now = Date.now();
  const gated = [];
  const lagSkipped = [];
  for (const item of advice) {
    if (item === null || typeof item !== 'object') continue;
    const forced = typeof input?.forceProfileKey === 'string' && input.forceProfileKey === item.profileKey;
    if (!forced && rollbackCooldownBlocks(deps.assets.list(), item.profileKey, directionOf(item), now)) {
      lagSkipped.push({ profileKey: item.profileKey, reason: 'rollback-cooldown' });
      continue;
    }
    if (!forced && bumpStreak(deps.streaks, item, summaries, now) < LAG_N) {
      lagSkipped.push({ profileKey: item.profileKey, reason: 'lag-not-reached' });
      continue;
    }
    gated.push(item);
  }
  const result = await generateCandidates(deps, { advice: gated, summaries, forceProfileKey: input?.forceProfileKey });
  return {
    generated: result.generated ?? [],
    skipped: [...lagSkipped, ...(result.skipped ?? [])],
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
}

// 引擎构造（从装配层拆出守行门）：注入读台账/streak 落盘/回滚冷却注入/回滚建议提醒等闭环依赖。
function buildEngine({ ctx, store, catalog, assets, evoLedger, adviceWhitelist, logger, getEvolutionAdvice, applyEnabled, summariesFile, dispatchFile, pluginVersion, mintRollbackReminder }) {
  return createEvolutionEngine({
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
    getDispatchRecords: () => readDispatchRecords(dispatchFile),
    saveStreaks: (list) => writeBackStreaks(summariesFile, list, logger),
    injectRollbackCooldown: (profileKey, untilTs) => {
      const data = readSummaries(summariesFile, logger, { onLoss: () => evoLedger.markMigrationLoss() });
      writeBackCooldowns(summariesFile, data, [[profileKey, untilTs]], logger);
    },
    mintRollbackReminder,
    pluginVersion,
  });
}

// 进化装配 helper：资产域 + 引擎 + 建议/候选生成 helper。adviceSource 是
// /list（建议面板数据）的唯一入口——computeAdvice 之后随建议链开关把建议推导
// 成候选资产（换代判定按用户设置），避免多处重复生成；生成失败只 warn 不影响
// 建议展示（fail-soft）。面板文本走 renderAdviceText/buildAdviceText（模型侧注入下架）。
export function createEvolutionAssembly({
  ctx,
  home,
  store,
  catalog,
  evoLedger,
  adviceWhitelist,
  getEvolutionAdvice,
  getReminderStore,
  pluginVersion,
}) {
  const logger = ctx.logger;
  const assets = createEvolutionAssets({ dshHome: home, logger, onGovernanceFailure: () => evoLedger.markGovernanceFailure() });
  const applyEnabled = store.loadApplyEnabled();
  const summariesFile = join(home, 'subagent-evolution', 'summaries.json');
  const dispatchFile = join(home, 'subagent-evolution', 'dispatch.jsonl');
  const engine = buildEngine({ ctx, store, catalog, assets, evoLedger, adviceWhitelist, logger, getEvolutionAdvice, applyEnabled, summariesFile, dispatchFile, pluginVersion, mintRollbackReminder: getReminderStore });
  const adviceSource = async () => {
    // 金丝雀判定先于建议/候选生成：观察期满自动出 verdict（回滚建议只读挂面板），
    // 失败只 warn 不阻断建议展示（fail-soft）。
    try {
      engine.evaluateCanaries();
    } catch (error) {
      logger.warn(`[dsh-subagent-profile] 金丝雀判定失败：${error instanceof Error ? error.message : String(error)}`);
    }
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
  getDispatchRecords = () => [],
  saveStreaks = () => {},
  injectRollbackCooldown = () => {},
  getHoldoutBacktest = () => holdoutBacktest,
  mintRollbackReminder = () => {},
}) {
  const applyLocks = new Map();
  const streaks = createLagStreaks({ save: (list) => saveStreaks(list) });
  const deps = { store, catalog, assets, evoLedger, whitelist, logger, getApplyEnabled, getAdviceEnabled, getAllowFailOpen, getLlm, getSummaries, pluginVersion, getCandidateMode, getCandidateTtlH, getDispatchRecords, saveStreaks, injectRollbackCooldown, getHoldoutBacktest, mintRollbackReminder, streaks, assessGates: (config) => assessApplyGates(deps, config) };
  return {
    list: () => assets.list(),
    generate: (input) => generateWithLag(deps, input),
    regenerate: (input) => regenerateCandidates(deps, input),
    apply: (input) => applyCandidate(deps, applyLocks, input),
    rollback: (input) => rollbackCandidate(deps, applyLocks, input),
    evaluateCanaries: (now = Date.now()) => evaluateCanaries(deps, now),
    evolutionStatus: () => evolutionStatusOf({ getApplyEnabled: deps.getApplyEnabled, summaries: deps.getSummaries() }),
    backtest: (records, candidateConfig, opts) => deps.getHoldoutBacktest()(records, candidateConfig, opts),
    purgeCandidates: () => assets.purgeAll(),
  };
}
