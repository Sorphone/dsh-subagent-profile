// lib/core/evolution-routes.mjs — 进化资产与候选管理路由处理：/evolution/assets 只读
// 列表（含金丝雀回滚建议数据源）、/evolution/apply 应用写路径、/evolution/rollback
// 决议写路径（回滚/显式保留）、/evolution/regenerate 重新生成候选、/advice/save-profile 保存为方案、
// /settings/candidate 候选设置。loopback 与 CSRF 守卫由 createHttpRoutes 入口统一
// 完成，本模块只做 body 解析与响应组装。apply/rollback 拒绝（400）回传原因；成功
// 回传新方案 id、资产状态与 persisted 信号。业务本体（三道闸/审计/锁/金丝雀判定）
// 在 evolution-engine 与 evolution-canary 内，本模块不触碰任何闸判定。

import { sanitizeProfile } from './pure.mjs';
import { computeAdvice } from './evolution-advice.mjs';
import { lowerHyphen, sourceConfigFromKey } from './evolution-draft.mjs';
import { rollbackSuggestionOf } from './evolution-canary.mjs';
import { json, readBody, persistOk } from './http-helpers.mjs';

// ── 资产只读视图（黑盒闭合：观察期/轨迹/徽标统一由 /evolution/assets 下发）──────

// 观察期状态视图：state/label 由后端给出（用户可见面零内部词）；baseline/post 供
// 撤销建议区证据对照；kept = 用户已显式保留。pendingApply = 候选未应用。
const CANARY_VIEW_LABELS = {
  pendingApply: '未应用',
  observing: '观察中',
  stalled: '观察数据不足（未判定），等待更多派发',
  insufficient: '观察数据不足（未判定），等待更多派发',
  inconclusive: '观察数据不足（未判定），等待更多派发',
  applied: '观察期结束：表现未下降，已保留',
  regress: '观察期结束：上次的调整表现变差了',
  aborted: '你手动修改了方案，观察已中止（不会再判定）',
};

export function canaryViewOf(asset) {
  const baseline = asset !== null && typeof asset === 'object' && asset.baseline_metrics !== null && typeof asset.baseline_metrics === 'object' ? asset.baseline_metrics : {};
  const canary = asset !== null && typeof asset === 'object' && asset.canary !== null && typeof asset.canary === 'object' ? asset.canary : null;
  if (canary === null) {
    return { state: 'pendingApply', k: 0, kTotal: 0, verdict: null, label: CANARY_VIEW_LABELS.pendingApply, baseline: { sampleN: baseline.sampleN ?? null, weighted_success: baseline.weighted_success ?? null }, post: null, kept: false };
  }
  const k = Number.isFinite(canary.k) ? canary.k : 0;
  const kTotal = Number.isFinite(canary.kTotal) ? canary.kTotal : 0;
  const samples = Array.isArray(canary.samples) ? canary.samples : [];
  const last = samples.length > 0 && samples[samples.length - 1] !== null && typeof samples[samples.length - 1] === 'object' ? samples[samples.length - 1] : null;
  const kept = asset.keep_at !== undefined || canary.kept_at !== undefined;
  const resolvedRollback = asset.state === 'rolled_back' || Number.isFinite(canary.rollback_at);
  let state = 'observing';
  let label = null;
  if (resolvedRollback) { state = 'applied'; label = '已撤销调整，观察期终止'; }
  else if (kept) { state = 'applied'; label = '观察期结束：已选择继续使用当前配置'; }
  else if (canary.verdict === 'stalled') state = 'stalled';
  else if (canary.insufficient === true || canary.verdict === 'inconclusive') state = 'inconclusive';
  else if (canary.verdict === 'regress') state = 'regress';
  else if (canary.verdict === 'aborted-human-edit') state = 'aborted';
  else if (asset.state === 'applied') state = 'applied';
  if (label === null) label = state === 'observing' ? CANARY_VIEW_LABELS.observing + '（' + k + '/' + kTotal + '）' : CANARY_VIEW_LABELS[state];
  return {
    state,
    k,
    kTotal,
    verdict: canary.verdict ?? null,
    label,
    baseline: { sampleN: baseline.sampleN ?? null, weighted_success: baseline.weighted_success ?? null },
    post: last === null ? null : { sampleN: last.sampleN, weighted_success: last.weighted_success },
    kept,
  };
}

// 判定短标签（进化轨迹「判定：…」用；未判定空串）。
function verdictShortLabel(verdict) {
  if (verdict === 'regress') return '建议撤销';
  if (verdict === 'applied') return '表现未下降，已保留';
  if (verdict === 'aborted-human-edit') return '观察中止';
  if (verdict === 'stalled' || verdict === 'inconclusive') return '数据不足，未判定';
  return '';
}

// 进化轨迹（≤8 条，按 ts 升序）：生成 → 应用（人工确认）→ 观察（k/kTotal）→
// 判定（短标签）→ 处理（你选择撤销/保留）。无 canary 的资产只有生成事件。
export function lifecycleOf(asset) {
  const events = [];
  const canary = asset !== null && typeof asset === 'object' && asset.canary !== null && typeof asset.canary === 'object' ? asset.canary : null;
  if (asset !== null && typeof asset === 'object' && Number.isFinite(asset.createdAt)) events.push({ ts: asset.createdAt, event: 'generated' });
  if (asset !== null && typeof asset === 'object' && Number.isFinite(asset.applied_at)) events.push({ ts: asset.applied_at, event: 'applied', meta: '人工确认' });
  if (canary !== null) {
    const samples = Array.isArray(canary.samples) ? canary.samples : [];
    const last = samples.length > 0 && Number.isFinite(samples[samples.length - 1]?.ts) ? samples[samples.length - 1].ts : asset.applied_at;
    if (Number.isFinite(last)) events.push({ ts: last, event: 'observed', meta: (Number.isFinite(canary.k) ? canary.k : 0) + '/' + (Number.isFinite(canary.kTotal) ? canary.kTotal : 0) });
    if (Number.isFinite(canary.judged_at)) {
      const verdict = verdictShortLabel(canary.verdict);
      events.push({ ts: canary.judged_at, event: 'judged', meta: verdict !== '' ? verdict : '数据不足，未判定' });
    }
    if (Number.isFinite(canary.rollback_at)) events.push({ ts: canary.rollback_at, event: 'resolved', meta: '你选择撤销调整' });
    else if (canary.kept_at !== undefined) events.push({ ts: canary.kept_at, event: 'resolved', meta: '你选择保留' });
  }
  events.sort((a, b) => a.ts - b.ts);
  return events.slice(-8);
}

// 候选行生命周期徽标（后端给中文；未知状态不渲染）。
export function assetStateLabelOf(asset) {
  if (asset === null || typeof asset !== 'object') return null;
  const canary = asset.canary !== null && typeof asset.canary === 'object' ? asset.canary : null;
  if (asset.invalid === true) return '观察中止';
  if (asset.state === 'draft') return '草稿';
  if (asset.state === 'expired') return '已过期';
  if (asset.state === 'rolled_back') return '已撤销';
  if (asset.state === 'applied') return canary !== null && canary.kept_at !== undefined ? '已保留' : '已应用';
  if (asset.state === 'proposed') return canary !== null && canary.verdict === 'regress' ? '待撤销' : '观察中';
  return null;
}

async function handleEvolutionAssets(deps, res) {
  // 金丝雀判定随只读列表触发（幂等；失败只 warn 不阻断列表）。
  if (typeof deps.evolution?.evaluateCanaries === 'function') {
    try { deps.evolution.evaluateCanaries(); } catch { /* fail-soft，判定失败不阻断只读列表 */ }
  }
  const raw = deps.evolution !== undefined && typeof deps.evolution.list === 'function' ? deps.evolution.list() : [];
  const rollbackSuggestions = raw.map((asset) => rollbackSuggestionOf(asset)).filter((s) => s !== null);
  const assets = raw.map((asset) => ({ ...asset, canary: canaryViewOf(asset), lifecycle: lifecycleOf(asset), stateLabel: assetStateLabelOf(asset) }));
  return json(res, 200, { ok: true, assets, rollbackSuggestions });
}

async function handleEvolutionApply(deps, req, res) {
  const body = await readBody(req);
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  if (assetId === '') return json(res, 400, { ok: false, error: 'assetId 不能为空' });
  if (deps.evolution === undefined || typeof deps.evolution.apply !== 'function') {
    return json(res, 404, { ok: false, error: '进化 apply 引擎未装配' });
  }
  const result = await deps.evolution.apply({ assetId, humanConfirmed: body.human_confirmed === true });
  if (!result.ok) {
    const payload = { ok: false, error: result.reason };
    if (result.checks !== undefined) payload.checks = result.checks;
    return json(res, 400, payload);
  }
  return json(res, 200, {
    ok: true,
    id: result.id,
    state: result.state,
    persisted: result.persisted,
    ...(result.persisted ? {} : { persistWarning: '已应用但未持久化' }),
  });
}

// 候选设置写路径：更新模式（自动换新/手动维护）+ 有效期小时数（0 或 1~8760 整数）。
// 校验失败 400；成功持久化并回传 persisted 信号与归一后的值。
async function handleSettingsCandidate(deps, req, res) {
  const body = await readBody(req);
  const mode = body && typeof body.candidateMode === 'string' ? body.candidateMode : '';
  const ttlH = body && typeof body.candidateTtlH === 'number' ? body.candidateTtlH : NaN;
  if (mode !== 'auto' && mode !== 'manual') {
    return json(res, 400, { ok: false, error: '候选更新模式无效（auto/manual）' });
  }
  if (!Number.isInteger(ttlH) || !(ttlH === 0 || (ttlH >= 1 && ttlH <= 8760))) {
    return json(res, 400, { ok: false, error: '候选有效期无效（0 或 1~8760 小时整数）' });
  }
  const modePersist = deps.store.persistCandidateMode(mode);
  const ttlPersist = deps.store.persistCandidateTtlH(ttlH);
  const persisted = modePersist.persisted !== false && ttlPersist.persisted !== false;
  return persistOk(res, {
    candidateMode: deps.store.loadCandidateMode(),
    candidateTtlH: deps.store.loadCandidateTtlH(),
  }, { persisted });
}

// 决议执行（人工确认）：action='keep' 显式保留当前配置（不写 profile，资产
// proposed→applied + suggestion-keep 审计）；缺省 action='rollback' 走恢复快照。
// 非法 action 400；拒绝分支回传原因。审计与恢复本体在 evolution-canary 内。
async function handleEvolutionRollback(deps, req, res) {
  const body = await readBody(req);
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  if (assetId === '') return json(res, 400, { ok: false, error: 'assetId 不能为空' });
  const rawAction = typeof body.action === 'string' ? body.action : '';
  const action = rawAction === '' ? 'rollback' : (rawAction === 'rollback' || rawAction === 'keep' ? rawAction : '');
  if (action === '') return json(res, 400, { ok: false, error: 'action 无效（rollback/keep）' });
  if (deps.evolution === undefined || typeof deps.evolution.rollback !== 'function') {
    return json(res, 404, { ok: false, error: '进化决议引擎未装配' });
  }
  const result = await deps.evolution.rollback({ assetId, humanConfirmed: body.human_confirmed === true, action });
  if (!result.ok) return json(res, 400, { ok: false, error: result.reason });
  const payload = { ok: true, id: assetId, state: result.state };
  if (result.restored !== undefined) payload.restored = result.restored;
  if (result.persisted !== undefined) {
    payload.persisted = result.persisted;
    if (!result.persisted) payload.persistWarning = '已回滚但未持久化';
  }
  return json(res, 200, payload);
}

// 重新生成候选（人工触发）：该身份键所有未处置候选先转 expired，再按当前建议
// 产新一代；审计由引擎写 suggestion-refresh。无当前建议时只清理不产新候选。
async function handleEvolutionRegenerate(deps, req, res) {
  const body = await readBody(req);
  const profileKey = body && typeof body.profileKey === 'string' ? body.profileKey : '';
  if (profileKey === '') return json(res, 400, { ok: false, error: 'profileKey 不能为空' });
  if (deps.evolution === undefined || typeof deps.evolution.regenerate !== 'function') {
    return json(res, 404, { ok: false, error: '候选重新生成入口未装配' });
  }
  const computed = computeAdvice({ summariesFile: deps.summariesFile, dispatchFile: deps.dispatchFile, whitelist: deps.adviceWhitelist, logger: deps.logger });
  const item = (Array.isArray(computed.advice) ? computed.advice : []).find((a) => a !== null && typeof a === 'object' && a.profileKey === profileKey);
  const result = await deps.evolution.regenerate({ profileKey, advice: item !== undefined ? [item] : [], summaries: computed.summaries });
  return json(res, 200, { ok: true, ...result });
}

// 保存为方案：优先从配置快照取（同 profileKey 最近一条快照 → 完整 config，含
// persona 原文与 toolFilter 全量，可完整复现该笔派发并记 snapshot-used 审计）；
// 未命中回退「可还原段」逻辑（仅预设/提供方/模型，副注说明隐私取舍）。
// 身份键无可保存字段时 400。
async function handleAdviceSaveProfile(deps, req, res) {
  const body = await readBody(req);
  const profileKey = body && typeof body.profileKey === 'string' ? body.profileKey : '';
  if (profileKey === '') return json(res, 400, { ok: false, error: 'profileKey 不能为空' });
  const snapshot = deps.snapshots !== undefined && typeof deps.snapshots.latestByProfileKey === 'function'
    ? deps.snapshots.latestByProfileKey(profileKey)
    : null;
  const config = {};
  if (snapshot !== null && snapshot.config !== null && typeof snapshot.config === 'object') {
    for (const field of ['preset', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'maxDepth', 'persona', 'toolFilter']) {
      if (snapshot.config[field] !== undefined) config[field] = snapshot.config[field];
    }
  } else {
    const from = sourceConfigFromKey(profileKey, {});
    for (const field of ['preset', 'provider', 'model']) {
      if (typeof from[field] === 'string' && from[field] !== '') config[field] = from[field];
    }
  }
  if (Object.keys(config).length === 0) {
    return json(res, 400, { ok: false, error: '该配置无可保存字段（未指定预设/提供方/模型）' });
  }
  const slug = lowerHyphen(profileKey).slice(0, 24) || 'config';
  const base = `advice-${slug}`.slice(0, 32);
  const taken = new Set(deps.store.profiles.keys());
  let id = base;
  for (let attempt = 2; taken.has(id) && attempt <= 6; attempt += 1) {
    id = `${base}-${attempt}`.slice(0, 32);
  }
  if (taken.has(id)) return json(res, 400, { ok: false, error: '方案编号冲突，无法保存' });
  const name = slug.length > 0 ? `建议配置-${slug.slice(0, 16)}` : '建议配置';
  const description = snapshot !== null
    ? '来自建议面板的配置快照（含自定义人格与工具过滤，取自本机快照）。便于复用与对比分析。'
    : '来自建议面板的配置快照（仅预设/模型/提供方；人格与工具过滤不落盘，按隐私设计）。便于复用与对比分析。';
  const { clean, warnings } = sanitizeProfile({ ...config, id, name, description }, { strict: true });
  if (warnings.length > 0) {
    const detail = warnings.map((w) => `${w.field}：${w.reason}`).join('；');
    return json(res, 400, { ok: false, error: `保存被拒绝：${detail}` });
  }
  deps.store.profiles.set(clean.id, { ...clean, persisted: true });
  if (snapshot !== null && typeof deps.recordAudit === 'function') {
    deps.recordAudit({ kind: 'snapshot-used', profile_key: profileKey, file: typeof snapshot.file === 'string' ? snapshot.file : '' });
  }
  return persistOk(res, { id: clean.id, name: clean.name, fromSnapshot: snapshot !== null }, deps.store.persistProfiles());
}

export { handleEvolutionAssets, handleEvolutionApply, handleEvolutionRollback, handleEvolutionRegenerate, handleAdviceSaveProfile, handleSettingsCandidate };
