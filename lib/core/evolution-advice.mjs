// lib/core/evolution-advice.mjs — evolution:advice 派发优化建议链（从 evolution-summary.mjs
// 拆出以守文件行门）：suggestAdvice（纯函数四条件 + 升/降轴硬规则）、readSummaries /
// refreshSummaries / computeAdvice / buildAdviceText（生产聚合触发与注入文本）。
// 聚合本体（computeSummaries/writeSummaries）仍驻 evolution-summary.mjs；本模块只读
// 台账并调度聚合，绝无写回台账路径。fail-soft 纪律与 evolution-summary 同源。
//
// 依赖方向：本模块 → evolution-summary.mjs（单向，无环）。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { computeSummaries, parseDispatchRecords, writeSummaries, confidenceLevel, profileKeyOf } from './evolution-summary.mjs';
import { loadWithMigration } from './evolution-persistence.mjs';

// --- 派发优化建议（suggestAdvice）-----------------------------------------------
// 从单条 L1 聚合（l1Entry）产出「一项确定性建议」或 null。四条件齐备才产出：
//   N>=minN、weighted_success 低于阈值（表现不佳才建议）、置信度达标、cooldown
//   未过期。方向按升/降轴硬规则：能力轴（preset/model/provider/persona/
//   toolFilter）只建议降；预算轴（effort）可建议升；无法定位安全轴的键保守维持
//   （平）。阈值 successThreshold / confidenceMinLevel / cooldownMs 为建议初值，
//   待实测后校准。
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
// 置信度级别中文映射（注入文本人话化，与客户端 ZH.confidenceZh 同口径）。
const CONFIDENCE_ZH = { low: '低', medium: '中等', high: '高' };

function hasCapabilityAxis(profileKey) {
  return /(^|\|)(preset|provider|model|persona|toolFilter):/.test(String(profileKey ?? ''));
}

function hasBudgetAxis(profileKey) {
  return /(^|\|)effort:/.test(String(profileKey ?? ''));
}

// 从 profileKey 提取 preset 候选值（无 preset 段返回 null，如 inline / 纯预算键）。
export function presetFromKey(profileKey) {
  if (typeof profileKey !== 'string' || profileKey === '' || profileKey === '(inline)') return null;
  for (const part of profileKey.split('|')) {
    if (part.startsWith('preset:')) return part.slice('preset:'.length);
  }
  return null;
}

// 建议候选校验：preset 候选非 system-trust 白名单即 fail-loud 抛错（与派发守卫
// whitelist 闸一致，不静默滤掉）。whitelist 接受 Set 或数组。
export function assertSystemCandidate(whitelist, preset) {
  if (preset === null || preset === undefined || preset === '' || preset === 'inherit') return;
  const inList = whitelist instanceof Set ? whitelist.has(preset) : Array.isArray(whitelist) && whitelist.includes(preset);
  if (!inList) {
    throw new Error(`evolution:advice: 候选预设 "${preset}" 不在 system-trust 白名单（拒绝非 system 候选）`);
  }
}

function performanceText(entry) {
  const outcome = entry?.outcome ?? {};
  const perf = entry?.perf ?? {};
  const parts = [
    `过去 ${entry?.deployments_total ?? 0} 次：完成 ${outcome.completed ?? 0}、失败 ${outcome.failed ?? 0}、终止 ${outcome.killed ?? 0}`,
    `加权成功分 ${entry?.score?.weighted_success ?? 0}`,
  ];
  if (perf.avg_elapsed_ms !== null && perf.avg_elapsed_ms !== undefined) parts.push(`平均耗时 ${perf.avg_elapsed_ms}ms`);
  if (perf.avg_output_len !== null && perf.avg_output_len !== undefined) parts.push(`平均输出 ${perf.avg_output_len} 字符`);
  return parts.join('，');
}

function directionFor(profileKey, capability, budget) {
  if (budget && !capability) return '升';
  if (capability) return '降';
  return '平';
}

// --- 建议对象与理由（确定性人话）-----------------------------------------------
// objectText：建议直接带对象（模型改用更低档 / 去掉自定义人格……），按最保守改变
// 取一段（自定义人格/工具过滤先、模型次之、预设最后——与候选生成降档的保守序一致）；
// 升预算方向读 L2 预算轴存在性给「推理强度上调一档 / maxTokens 上调」。
// reasonText：理由一句话，从身份键段 + 聚合计数推导（同输入恒同输出，不含任何
// 配置原文）。

function adviceKeySegments(profileKey) {
  const parsed = { preset: false, model: false, persona: false, toolFilter: false };
  for (const part of String(profileKey ?? '').split('|')) {
    if (part.startsWith('preset:')) parsed.preset = true;
    else if (part.startsWith('model:')) parsed.model = true;
    else if (part === 'persona:1') parsed.persona = true;
    else if (part === 'toolFilter:1') parsed.toolFilter = true;
  }
  return parsed;
}

function downObjectText(segments) {
  if (segments.persona) return '去掉自定义人格';
  if (segments.toolFilter) return '移除工具过滤';
  if (segments.model) return '模型改用更低档';
  if (segments.preset) return '预设改用更低档';
  return '能力配置降级';
}

function budgetObjectText(profileKey, l2) {
  const source = l2 !== null && typeof l2 === 'object' ? l2 : {};
  let hasEffort = false;
  let hasTokens = false;
  for (const axisKey of Object.keys(source)) {
    if (typeof axisKey !== 'string') continue;
    if (axisKey.startsWith(`${profileKey}:reasoningEffort:`)) hasEffort = true;
    else if (axisKey.startsWith(`${profileKey}:maxTokens:`)) hasTokens = true;
  }
  if (hasEffort) return '推理强度上调一档';
  if (hasTokens) return 'maxTokens 上调';
  return '预算上调';
}

function downReasonText(segments, entry) {
  const n = Number.isFinite(entry?.confidence?.n) ? entry.confidence.n : (entry?.deployments_total ?? 0);
  const killed = Number.isFinite(entry?.outcome?.killed) ? entry.outcome.killed : 0;
  if (segments.persona) {
    return killed > 0
      ? `带自定义人格的派发 ${n} 次里 ${killed} 次被终止，去掉后可复用父会话统一提示`
      : '去掉自定义人格后，子 Agent 复用父会话统一提示，配置更简单';
  }
  if (segments.toolFilter) return '移除工具过滤后，子 Agent 的工具面回到父会话范围，配置更简单';
  if (segments.model) return '同类任务改用更低档模型，成本通常更低';
  if (segments.preset) return '相邻低档预设能力相近，成本通常更低';
  return `近期表现低于预期（加权成功分 ${entry?.score?.weighted_success ?? 0}），降低能力配置是更稳妥的方向`;
}

function upReasonText(profileKey, l2) {
  const text = budgetObjectText(profileKey, l2);
  if (text === '推理强度上调一档') return '推理强度上调一档可提升复杂任务完成质量';
  if (text === 'maxTokens 上调') return 'token 上限上调后可减少中途截断';
  return '预算上调后可提升复杂任务完成质量';
}

export function suggestAdvice({
  l1Entry,
  profileKey = '',
  l2 = null,
  minN = 3,
  cooldownMs = 600000,
  now = Date.now(),
  successThreshold = 0.6,
  confidenceMinLevel = 'medium',
} = {}) {
  const entry = l1Entry !== null && typeof l1Entry === 'object' ? l1Entry : {};
  const key = typeof profileKey === 'string' ? profileKey : (typeof entry.profileKey === 'string' ? entry.profileKey : '');
  const n = Number.isFinite(entry.confidence?.n) ? entry.confidence.n : 0;
  const level = typeof entry.confidence?.level === 'string' ? entry.confidence.level : confidenceLevel(n, minN);
  const score = Number.isFinite(entry.score?.weighted_success) ? entry.score.weighted_success : 0;
  const until = entry.cooldown?.until_ts;

  // 四条件齐备才产出（任一不满足返回 null）。
  if (n < minN) return null;
  if ((CONFIDENCE_RANK[level] ?? -1) < (CONFIDENCE_RANK[confidenceMinLevel] ?? 0)) return null;
  if (until !== null && until !== undefined && now < until) return null;
  if (!(score < successThreshold)) return null;

  // 方向判定：优先读组内轴存在性（L1 键去 effort 后由聚合写入）；legacy summaries
  // 无 axes 字段时回退键文本正则判定（保持旧 summaries.json 可读）。
  const axes = entry.axes !== null && typeof entry.axes === 'object' ? entry.axes : null;
  const capability = axes !== null && typeof axes.capability === 'boolean' ? axes.capability : hasCapabilityAxis(key);
  const budget = axes !== null && typeof axes.budget === 'boolean' ? axes.budget : hasBudgetAxis(key);
  const suggestion = directionFor(key, capability, budget);
  const segments = adviceKeySegments(key);

  return {
    profileKey: key,
    performanceText: performanceText(entry),
    suggestion,
    // 建议对象与理由：确定性人话，同输入恒同输出；面板渲染「建议：…」与「理由：…」。
    objectText: suggestion === '降' ? downObjectText(segments) : suggestion === '升' ? budgetObjectText(key, l2) : '',
    reasonText: suggestion === '降' ? downReasonText(segments, entry) : suggestion === '升' ? upReasonText(key, l2) : '',
    confidence: level,
    cooldownUntil: now + cooldownMs,
  };
}

// --- 派发优化建议（evolution:advice 注入段，默认关）----------------------------

// 读 summaries.json（存在才读）。版本化经通用持久化机制：v 低于当前版本时内存
// 前向迁移后原子写回；损坏/形状不符/未知或超前版本 fail-soft 返回 null，并告警
// + onLoss（迁移丢失计数）。l1 形状校验保留（读端数据契约）。
export function readSummaries(file, logger, opts = {}) {
  const data = loadWithMigration(file, 'summaries', { logger, onLoss: opts.onLoss });
  if (data === null) return null;
  if (data.l1 === null || typeof data.l1 !== 'object') return null;
  return data;
}

// 生产聚合触发点（T1 修复）：读 dispatch.jsonl → parseDispatchRecords → computeSummaries
// → writeSummaries。opts 可注入 parentAdoptedConfirmedFalse join（adoption-tracker 的
// 「已确认未采纳」计数，惰性 join 进 weighted_success）。缺失台账返回 skipped:'no-ledger'。
export function refreshSummaries({ dispatchFile, summariesFile, logger, opts = {} } = {}) {
  if (!existsSync(dispatchFile)) return { persisted: false, skipped: 'no-ledger' };
  let lines;
  try {
    lines = readFileSync(dispatchFile, 'utf8').split('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn(`[dsh-subagent-profile] evolution:advice 读派发台账失败：${message}`);
    }
    return { persisted: false, error: message };
  }
  const { records, skipped } = parseDispatchRecords(lines);
  const summaries = computeSummaries(records, opts);
  const res = writeSummaries(summariesFile, summaries);
  return { ...res, records: records.length, skippedLines: skipped };
}

// summaries.json 是否过期（缺失但台账存在，或台账 mtime 更新）——惰性重算判据。
function summariesStale(dispatchFile, summariesFile) {
  if (!existsSync(summariesFile)) return existsSync(dispatchFile);
  try {
    return statSync(dispatchFile).mtimeMs > statSync(summariesFile).mtimeMs;
  } catch {
    return false;
  }
}

// 注入段文本：全局聚合摘要 + 各 profile 一条确定性建议（人类读、非指令）。
export function renderAdviceText(advice, global) {
  const direction = (value) => (value === '升' ? '可上调预算' : value === '降' ? '建议降级' : '维持现状');
  const lines = advice.map((a) => {
    const untilText = Number.isFinite(a.cooldownUntil)
      ? `（冷却至 ${new Date(a.cooldownUntil).toLocaleTimeString('zh-CN', { hour12: false })}）`
      : '';
    return `- ${a.profileKey}：${a.performanceText}；${direction(a.suggestion)}（置信度 ${CONFIDENCE_ZH[a.confidence] ?? a.confidence}）${untilText}`;
  });
  const total = global.completed + global.failed + global.killed;
  return `以下为过去派发的只读统计与确定性建议（仅供人类参考，不改变派发行为）：\n` +
    `全局：累计 ${total} 次（完成 ${global.completed}、失败 ${global.failed}、终止 ${global.killed}）。\n${lines.join('\n')}`;
}

// 建议产出后把各 profile 的新 cooldown.until_ts 写回 summaries.json（原子写、
// fail-soft）。写前重读磁盘再合并：并发注入各自基于最新磁盘态写回，把互相覆盖
// 窗口压到最小（残余竞态：读-写间隙，彻底解决需进程内锁，成本不值）。
function writeBackCooldowns(file, data, produced, logger) {
  const fresh = readSummaries(file, logger);
  const base = fresh !== null && typeof fresh === 'object' ? fresh : data;
  const l1 = { ...(base.l1 ?? {}) };
  for (const [profileKey, until] of produced) {
    const group = l1[profileKey];
    l1[profileKey] = { ...group, cooldown: { ...(group?.cooldown ?? {}), until_ts: until } };
  }
  const res = writeSummaries(file, { l1, l2: base.l2 ?? {} });
  if (res.persisted !== true) {
    logger.warn(`[dsh-subagent-profile] evolution:advice cooldown 写回失败：${res.error ?? '未知错误'}`);
  }
}

// 结构化建议（读+算，不写回 cooldown、不渲染文本）：供注入段与只读面板共用。
export function computeAdvice({ summariesFile, dispatchFile, whitelist, logger, onLoss }) {
  if (dispatchFile !== undefined && summariesStale(dispatchFile, summariesFile)) refreshSummaries({ dispatchFile, summariesFile, logger });
  let data = readSummaries(summariesFile, logger, { onLoss });
  // summaries.json 存在但不可读（损坏/版本不符）→ fail-soft 重建（幂等可复算），
  // 损坏资产不阻断建议产出；台账缺失时维持空建议（refreshSummaries 的 no-ledger 语义）。
  if (data === null && dispatchFile !== undefined && existsSync(summariesFile)) {
    refreshSummaries({ dispatchFile, summariesFile, logger });
    data = readSummaries(summariesFile, logger, { onLoss });
  }
  if (data === null) return { advice: [], global: { completed: 0, failed: 0, killed: 0, total: 0 }, produced: [], summaries: null };
  const l1 = data.l1 ?? {};
  const keys = Object.keys(l1).sort();
  const advice = [];
  const produced = [];
  const global = { completed: 0, failed: 0, killed: 0 };
  for (const profileKey of keys) {
    const group = l1[profileKey];
    if (group === null || typeof group !== 'object') continue;
    global.completed += group.outcome?.completed ?? 0;
    global.failed += group.outcome?.failed ?? 0;
    global.killed += group.outcome?.killed ?? 0;
    const suggestion = suggestAdvice({ l1Entry: group, profileKey, l2: data.l2 });
    if (suggestion === null) continue;
    // 只对实际产出的建议键校验候选（N 不足不产出建议的组不要求 system-trust）。
    assertSystemCandidate(whitelist, presetFromKey(profileKey));
    advice.push(suggestion);
    produced.push([profileKey, suggestion.cooldownUntil]);
  }
  return { advice, global: { ...global, total: global.completed + global.failed + global.killed }, produced, summaries: data };
}

// 派发优化建议段文本生成：computeAdvice → 写回 cooldown（防每请求重复注入）→ 渲染；空建议返回空串。
export function buildAdviceText({ summariesFile, dispatchFile, whitelist, logger, onLoss }) {
  const { advice, global, produced, summaries } = computeAdvice({ summariesFile, dispatchFile, whitelist, logger, onLoss });
  if (advice.length === 0) return '';
  writeBackCooldowns(summariesFile, summaries, produced, logger);
  return renderAdviceText(advice, global);
}

// --- 近期派发明细（面板折叠表数据源）------------------------------------------
// 从派发台账读行，用「行生效配置 → profileKeyOf（与聚合层同口径）」匹配各建议键，
// 取最近 limit 条（按 ts 倒序）。只取渲染所需字段（时间/会话/子 Agent/结果/耗时/模式），
// 不含任何原文。台账缺失/读失败/无匹配 → 空表（fail-soft，面板显示 0 次）。
export function recentDispatchDetails(dispatchFile, profileKeys, { limit = 5 } = {}) {
  const out = {};
  const wanted = new Set(Array.isArray(profileKeys) ? profileKeys.filter((key) => typeof key === 'string') : []);
  if (typeof dispatchFile !== 'string' || !existsSync(dispatchFile) || wanted.size === 0) return out;
  let lines;
  try {
    lines = readFileSync(dispatchFile, 'utf8').split('\n');
  } catch {
    return out;
  }
  const { records } = parseDispatchRecords(lines);
  const byKey = new Map();
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const key = profileKeyOf(record.effective);
    if (!wanted.has(key)) continue;
    const rows = byKey.get(key) ?? [];
    rows.push({
      ts: typeof record.ts === 'number' ? record.ts : null,
      sessionId: typeof record.session_id === 'string' ? record.session_id : null,
      childId: typeof record.child_id === 'string' ? record.child_id : null,
      mode: typeof record.mode === 'string' ? record.mode : '',
      outcome: record.outcome !== null && typeof record.outcome === 'object' && typeof record.outcome.status === 'string' ? record.outcome.status : '',
      elapsedMs: record.outcome !== null && typeof record.outcome === 'object' && Number.isFinite(record.outcome.elapsed_ms) ? record.outcome.elapsed_ms : null,
    });
    byKey.set(key, rows);
  }
  for (const [key, rows] of byKey) {
    rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    out[key] = rows.slice(0, limit);
  }
  return out;
}
