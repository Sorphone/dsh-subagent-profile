// lib/core/evolution-routes.mjs — 进化资产与候选管理路由处理：/evolution/assets 只读
// 列表、/evolution/apply 应用写路径、/evolution/regenerate 重新生成候选、
// /advice/save-profile 保存为方案、/settings/candidate 候选设置。loopback 与 CSRF
// 守卫由 createHttpRoutes 入口统一完成，本模块只做 body 解析与响应组装。apply 拒绝
// （400）回传原因与可选逐项 checks；成功回传新方案 id、资产状态与 persisted 信号。
// apply 业务本体（三道闸/审计/锁）在 evolution-engine 内，本模块不触碰任何闸判定。

import { sanitizeProfile } from './pure.mjs';
import { computeAdvice } from './evolution-advice.mjs';
import { lowerHyphen, sourceConfigFromKey } from './evolution-draft.mjs';
import { json, readBody, persistOk } from './http-helpers.mjs';

async function handleEvolutionAssets(deps, res) {
  const assets = deps.evolution !== undefined && typeof deps.evolution.list === 'function' ? deps.evolution.list() : [];
  return json(res, 200, { ok: true, assets });
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

// 保存为方案：把建议来源的当前派发配置（身份键可还原的预设/提供方/模型段）存成
// 新方案，便于复用与对比。自定义人格与工具过滤原文未留存（台账只存存在性），
// 不在新方案内。身份键无可还原字段时 400。
async function handleAdviceSaveProfile(deps, req, res) {
  const body = await readBody(req);
  const profileKey = body && typeof body.profileKey === 'string' ? body.profileKey : '';
  if (profileKey === '') return json(res, 400, { ok: false, error: 'profileKey 不能为空' });
  const from = sourceConfigFromKey(profileKey, {});
  const config = {};
  for (const field of ['preset', 'provider', 'model']) {
    if (typeof from[field] === 'string' && from[field] !== '') config[field] = from[field];
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
  const { clean, warnings } = sanitizeProfile({ ...config, id, name, description: '由建议面板保存的当前派发配置，便于复用与对比。' }, { strict: true });
  if (warnings.length > 0) {
    const detail = warnings.map((w) => `${w.field}：${w.reason}`).join('；');
    return json(res, 400, { ok: false, error: `保存被拒绝：${detail}` });
  }
  deps.store.profiles.set(clean.id, { ...clean, persisted: true });
  return persistOk(res, { id: clean.id, name: clean.name }, deps.store.persistProfiles());
}

export { handleEvolutionAssets, handleEvolutionApply, handleEvolutionRegenerate, handleAdviceSaveProfile, handleSettingsCandidate };
