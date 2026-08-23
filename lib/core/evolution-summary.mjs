// lib/core/evolution-summary.mjs — 派发台账（dispatch.jsonl）的确定性双层聚合
// （summaries.json）。纯函数为主：给定输入完全决定输出，可复算、可复现。IO 仅在
// writeSummaries（原子写 tmp+rename）与顶层装配层出现；computeSummaries 不读文件。
//
// 输入口径与派发台账一致（见 evolution-ledger.mjs）：每条 record 为 dispatch.jsonl
// 一行的解析结果，含 requested/effective 双栏 cfg（preset/model/provider/
// reasoningEffort/maxTokens/persona_present/toolFilter_present 等）与可选 outcome
// {status|elapsed_ms|output_len|tool_count}。continuable 无结算（无 outcome 键），
// 不参与 deployments_total/性能聚合，但参与轴分布。
//
// 不变量（可复算）：同输入恒同输出，遍历序稳定；聚合只读台账、不写回；parent_adopted
// 等动态质量信号不在台账内（写入当时不存在），由聚合层惰性 join（本模块只留字段
// 占位与可选输入 seam），原始台账本身不注入。

// 仅 writeSummaries/readSummaries/buildAdviceText 需要 IO（node 内置 fs），与台账采集
// 同种授权面；纯聚合/建议函数零 IO。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// --- 加权成功分 ---------------------------------------------------------------
// 公式：weighted_success = (completed − 0.3·confirmedFalse) / total，下限 0，小数点 3
// 位。每例「已确认未被采纳」的派发（parentAdoptedConfirmedFalse）从分子扣 0.3；
// unknown（未决）计 0 不惩罚——只有确认 false 才有惩罚，避免窗口期未判决的派发过早
// 拉低分数。total = completed+failed+killed。
export function weightedSuccess({ completed, failed, killed, parentAdoptedConfirmedFalse = 0 }) {
  const total = completed + failed + killed;
  if (total <= 0) return 0;
  const falseCount = Number.isFinite(parentAdoptedConfirmedFalse) ? parentAdoptedConfirmedFalse : 0;
  const numerator = Math.max(0, completed - 0.3 * Math.max(0, falseCount));
  return Number((numerator / total).toFixed(3));
}

// --- 采纳判定窗口（三态）------------------------------------------------------
// 参数化判定窗口：窗口内（尚未超过 N 轮 或 T ms）未引用一律 unknown；窗口外已确认未
// 引用（adoptedAt 为 null）落 false；adoptedAt 有值恒 true。N/T 待实测后校准，故均为
// 参数而非常量。
export function adoptStatus({ windowN = null, windowMs = null, dispatchedAt, adoptedAt, now, roundsElapsed = null }) {
  if (adoptedAt !== null && adoptedAt !== undefined) return 'true';
  const base = dispatchedAt !== null && dispatchedAt !== undefined ? dispatchedAt : now;
  const withinMs = windowMs === null || (now - base) < windowMs;
  const withinRounds = windowN === null || (roundsElapsed !== null ? roundsElapsed : 0) < windowN;
  return withinMs && withinRounds ? 'unknown' : 'false';
}

// --- 置信度级别 ---------------------------------------------------------------
// 阈值（3/10）与 min_n_required 为建议初值，待实测后校准。
export function confidenceLevel(n, minN = 3, highN = 10) {
  if (n >= highN) return 'high';
  if (n >= minN) return 'medium';
  return 'low';
}

// --- profile 身份与轴提取（确定性）-------------------------------------------
// L1 key = 生效配置重建的 profile 身份（台账不存 profileId，故从 effective cfg 重建）；
// 无区分性配置时记 '(inline)'。
function cfgSet(cfg) {
  return cfg !== null && typeof cfg === 'object' ? cfg : {};
}

function profileKeyOf(cfg) {
  const c = cfgSet(cfg);
  const parts = [];
  if (c.preset !== undefined && c.preset !== null && c.preset !== 'inherit') parts.push(`preset:${c.preset}`);
  if (c.provider !== undefined && c.provider !== null) parts.push(`provider:${c.provider}`);
  if (c.model !== undefined && c.model !== null) parts.push(`model:${c.model}`);
  if (c.reasoningEffort !== undefined && c.reasoningEffort !== null) parts.push(`effort:${c.reasoningEffort}`);
  if (c.persona_present === true) parts.push('persona:1');
  if (c.toolFilter_present === true) parts.push('toolFilter:1');
  return parts.length > 0 ? parts.join('|') : '(inline)';
}

// 能力轴取值：preset/model/provider 取 effective 值（实数命中）；persona 只存 present
// 布尔（隐私不落原文）；toolFilter_from 取 toolFilter_present 的来源标记（requested/
// effective 在台账内同源，记 'requested'/'effective'/absent）。
function capabilityAxisKeys(profileKey, record) {
  const eff = cfgSet(record?.effective);
  const req = cfgSet(record?.requested);
  const keys = [];
  if (eff.preset !== undefined && eff.preset !== null) keys.push(`${profileKey}:preset:${eff.preset}`);
  if (eff.model !== undefined && eff.model !== null) keys.push(`${profileKey}:model:${eff.model}`);
  if (eff.provider !== undefined && eff.provider !== null) keys.push(`${profileKey}:provider:${eff.provider}`);
  keys.push(`${profileKey}:persona:${eff.persona_present === true ? 'present' : 'absent'}`);
  const from = req.toolFilter_present === true && eff.toolFilter_present === true
    ? 'requested-and-effective'
    : (eff.toolFilter_present === true ? 'effective' : 'absent');
  keys.push(`${profileKey}:toolFilter_from:${from}`);
  return keys;
}

function budgetAxisKeys(profileKey, record) {
  const eff = cfgSet(record?.effective);
  const keys = [];
  if (eff.maxTokens !== undefined && eff.maxTokens !== null) keys.push(`${profileKey}:maxTokens:${eff.maxTokens}`);
  if (eff.reasoningEffort !== undefined && eff.reasoningEffort !== null) {
    keys.push(`${profileKey}:reasoningEffort:${eff.reasoningEffort}`);
  }
  return keys;
}

// --- 单组聚合 -----------------------------------------------------------------
function outcomeCounts(records) {
  const counts = { completed: 0, failed: 0, killed: 0 };
  for (const r of records) {
    if (r !== null && typeof r === 'object' && r.outcome && r.outcome.status === 'completed') counts.completed += 1;
    else if (r !== null && typeof r === 'object' && r.outcome && r.outcome.status === 'failed') counts.failed += 1;
    else if (r !== null && typeof r === 'object' && r.outcome && r.outcome.status === 'killed') counts.killed += 1;
  }
  return counts;
}

function avg(existing, value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return existing;
  if (existing === null) return { sum: value, count: 1 };
  return { sum: existing.sum + value, count: existing.count + 1 };
}

function mean(acc) {
  return acc === null || acc.count === 0 ? null : Number((acc.sum / acc.count).toFixed(2));
}

// 组装一层聚合子集（L1 与 L2 复用）：outcome/score/perf/confidence/cooldown/deployments_total。
function summarizeGroup(records, opts = {}) {
  const counts = outcomeCounts(records);
  const deploymentsTotal = counts.completed + counts.failed + counts.killed;
  const parentAdoptedConfirmedFalse = opts.parentAdoptedConfirmedFalse ?? 0;
  const score = {
    weighted_success: weightedSuccess({ ...counts, parentAdoptedConfirmedFalse }),
    win_rate: deploymentsTotal > 0 ? Number((counts.completed / deploymentsTotal).toFixed(3)) : 0,
  };
  let elapsedAcc = null;
  let outputAcc = null;
  let toolAcc = null;
  for (const r of records) {
    if (!r || typeof r !== 'object' || !r.outcome) continue;
    elapsedAcc = avg(elapsedAcc, r.outcome.elapsed_ms);
    outputAcc = avg(outputAcc, r.outcome.output_len);
    // tool_count 只对 completed 结算（见台账），且无 usage 事件时空值不计。
    if (r.outcome.status === 'completed') toolAcc = avg(toolAcc, r.outcome.tool_count);
  }
  return {
    deployments_total: deploymentsTotal,
    outcome: counts,
    score,
    perf: {
      avg_elapsed_ms: mean(elapsedAcc),
      avg_output_len: mean(outputAcc),
      avg_tool_count: mean(toolAcc),
    },
    confidence: {
      n: deploymentsTotal,
      min_n_required: 3,
      level: confidenceLevel(deploymentsTotal),
    },
    // 冷却期：until_ts/last_apply_ts 由应用层（建议采纳）回填；聚合层尚无来源，置 null。
    cooldown: { until_ts: null, last_apply_ts: null },
  };
}

// --- 顶层聚合（纯函数，无 IO）---------------------------------------------------
// records：dispatch.jsonl 逐行解析结果（调用方可先用 parseDispatchRecords 过滤损坏行）。
// opts.parentAdoptedConfirmedFalse：可选按聚合 key 的「已确认未采纳」计数 map，供外部
// 惰性 join 注入（Task 23 建议层）；缺省视为 0（台账内无该信号）。返回 l1/l2 普通对象。
export function computeSummaries(records, opts = {}) {
  const l1Map = new Map();
  const l2Map = new Map();
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const eff = cfgSet(record.effective);
    const profileKey = profileKeyOf(eff);
    if (!l1Map.has(profileKey)) l1Map.set(profileKey, []);
    l1Map.get(profileKey).push(record);
    for (const axisKey of capabilityAxisKeys(profileKey, record).concat(budgetAxisKeys(profileKey, record))) {
      if (!l2Map.has(axisKey)) l2Map.set(axisKey, []);
      l2Map.get(axisKey).push(record);
    }
  }
  const falseCounts = opts.parentAdoptedConfirmedFalse ?? {};
  const build = (map) => {
    const out = {};
    for (const [key, list] of map) {
      out[key] = summarizeGroup(list, { parentAdoptedConfirmedFalse: falseCounts[key] ?? 0 });
    }
    return out;
  };
  return { l1: build(l1Map), l2: build(l2Map) };
}

// --- 只读建议（suggestAdvice）---------------------------------------------------
// 从单条 L1 聚合（l1Entry）产出「一项确定性建议」或 null。四条件齐备才产出：
//   N>=minN、weighted_success 低于阈值（表现不佳才建议）、置信度达标、cooldown
//   未过期。方向按升/降轴硬规则：能力轴（preset/model/provider/persona/
//   toolFilter）只建议降；预算轴（effort）可建议升；无法定位安全轴的键保守维持
//   （平）。阈值 successThreshold / confidenceMinLevel / cooldownMs 为建议初值，
//   待实测后校准。
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

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

export function suggestAdvice({
  l1Entry,
  profileKey = '',
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

  return {
    profileKey: key,
    performanceText: performanceText(entry),
    suggestion: directionFor(key, hasCapabilityAxis(key), hasBudgetAxis(key)),
    confidence: level,
    cooldownUntil: now + cooldownMs,
  };
}

// --- 损坏行解析（纯函数，fail-soft 跳过 + 计数）-------------------------------
// 逐行 JSON.parse；损坏/空行跳过并计数，不影响有效记录。
export function parseDispatchRecords(lines) {
  let skipped = 0;
  const records = [];
  for (const line of lines) {
    if (typeof line !== 'string' || line.trim().length === 0) {
      skipped += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      records.push(parsed);
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

// --- 原子写入（tmp+rename；profiles-store 模式）------------------------------
// 写 <file>.tmp 后 rename 覆盖，崩溃不产生截断文件。失败不 throw，返回 {persisted,
// error?} 由调用方按 fail-soft 处理。何时重算由调度层（审计分层/手动触发）决定，本
// 模块只提供写入原语。目录缺失时 mkdir recursive 补齐。
export function writeSummaries(file, data) {
  const tmp = `${file}.tmp`;
  try {
    // 顶层带 v 版本号（台账按行带 v 同源），改 schema 时递增。
    const payload = { v: 1, ...data, _computed_at: Date.now() };
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
    return { persisted: true };
  } catch (error) {
    // 尽力清理未 rename 的残留 tmp。
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return { persisted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- 只读建议（evolution:advice 注入段，默认关）--------------------------------

// 读 summaries.json（存在才读；损坏/形状不符 → null，调用方按 fail-soft 空处理）。
export function readSummaries(file) {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || parsed.l1 === null || typeof parsed.l1 !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// 生产聚合触发点（T1 修复）：读 dispatch.jsonl → parseDispatchRecords → computeSummaries
// → writeSummaries。此前 computeSummaries/writeSummaries/parseDispatchRecords 只被测试
// 调用，summaries.json 无初始生成路径，evolution:advice 恒空转。opts 可注入
// parentAdoptedConfirmedFalse join（F3 尚未接线，缺省空对象）。dispatch.jsonl 缺失
// 返回 { persisted:false, skipped:'no-ledger' }（不写空 summaries）；读失败 fail-soft。
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

// summaries.json 是否过期（缺失但台账存在，或派发台账 mtime 更新）。惰性重算判据：
// 只在有新派发落地后才重算，避免每次提示装配都全量读盘（M2 的「每次读写磁盘」）。
function summariesStale(dispatchFile, summariesFile) {
  if (!existsSync(summariesFile)) return existsSync(dispatchFile);
  try {
    return statSync(dispatchFile).mtimeMs > statSync(summariesFile).mtimeMs;
  } catch {
    return false;
  }
}

// 注入段文本：全局聚合摘要 + 各 profile 一条确定性建议（人类读、非指令，不含任何
// 子 Agent 派生原文）。cooldown 提示随建议附上（四要素：表现 + 建议 + 置信度 + 冷却）。
export function renderAdviceText(advice, global) {
  const direction = (value) => (value === '升' ? '可上调预算' : value === '降' ? '建议降级' : '维持现状');
  const lines = advice.map((a) => {
    const untilText = Number.isFinite(a.cooldownUntil)
      ? `（冷却至 ${new Date(a.cooldownUntil).toLocaleTimeString('zh-CN', { hour12: false })}）`
      : '';
    return `- ${a.profileKey}：${a.performanceText}；${direction(a.suggestion)}（置信度 ${a.confidence}）${untilText}`;
  });
  const total = global.completed + global.failed + global.killed;
  return `以下为过去派发的只读统计与确定性建议（仅供人类参考，不改变派发行为）：\n` +
    `全局：累计 ${total} 次（完成 ${global.completed}、失败 ${global.failed}、终止 ${global.killed}）。\n${lines.join('\n')}`;
}

// 建议产出后把各 profile 的新 cooldown.until_ts 写回 summaries.json（复用原子写；
// 失败 fail-soft，仅 warn，不阻断注入）。
function writeBackCooldowns(file, data, produced, logger) {
  const l1 = { ...(data.l1 ?? {}) };
  for (const [profileKey, until] of produced) {
    const group = l1[profileKey];
    l1[profileKey] = { ...group, cooldown: { ...(group?.cooldown ?? {}), until_ts: until } };
  }
  const res = writeSummaries(file, { l1, l2: data.l2 ?? {} });
  if (res.persisted !== true) {
    logger.warn(`[dsh-subagent-profile] evolution:advice cooldown 写回失败：${res.error ?? '未知错误'}`);
  }
}

// 只读建议段文本生成：读 summaries → 逐 profile 校验候选（非 system fail-loud）→
// suggestAdvice → 写回 cooldown → 渲染。无数据/无建议返回 ''（不注入）。
// 空组（null/非对象）跳过候选校验（不抛）——只有实际产出的建议键才要求 system-trust。
// 人工确认流与 MAX_TOKENS 帽属应用路径（应用具体变更时才需要），本层只产出定性建议。
export function buildAdviceText({ summariesFile, dispatchFile, whitelist, logger }) {
  // T1 惰性重算：summaries.json 缺失或派发台账已更新时先 refreshSummaries，再读。
  // 只在有新派发落地（dispatch.jsonl mtime 更新）时才重算，避免每次提示装配全量读盘。
  if (dispatchFile !== undefined && summariesStale(dispatchFile, summariesFile)) {
    refreshSummaries({ dispatchFile, summariesFile, logger });
  }
  const data = readSummaries(summariesFile);
  if (data === null) return '';
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
    const suggestion = suggestAdvice({ l1Entry: group, profileKey });
    if (suggestion === null) continue;
    // F4：候选校验移到「实际产出建议」之后——N<3 组不产出建议，不应因非 system
    // 候选而抛（校验先于判定与模块注释「只有实际产出的建议键才要求 system-trust」矛盾）。
    assertSystemCandidate(whitelist, presetFromKey(profileKey));
    advice.push(suggestion);
    produced.push([profileKey, suggestion.cooldownUntil]);
  }
  if (advice.length === 0) return '';
  writeBackCooldowns(summariesFile, data, produced, logger);
  return renderAdviceText(advice, global);
}
