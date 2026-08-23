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

// 仅 writeSummaries 需要 IO（node 内置 fs），与台账采集同种授权面；纯聚合函数零 IO。
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
