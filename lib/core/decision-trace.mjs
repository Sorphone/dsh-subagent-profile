// lib/core/decision-trace.mjs — dispatch 决策轨迹（decisionTrace）的纯组装与
// 进程内失败台账。纯记录层：只「记录」不参与任何派发行为；轨迹经
// output.presentationMeta 投影进会话块 meta 供客户端账本展示，绝不进模型可见面
// （render 行 / 结果文本）。
//
// 边界（后来开发者须知）：
//   * 本模块 import-free（无 @deepseek-ai 依赖），可被 bare-CI 单测直接 import。
//   * 台账是会话级内存结构，进程重启即失——持久化由后续 JSONL 台账接手。
//   * 体积护栏分两级：recordGate 内工具/预设名单类数组截断前 8 项并打
//     truncated:true 标记；assertTraceSize 保证单条 trace JSON ≤ 2048 字节，
//     超出时逐级截断（detail/reason 长文本 → checks 数组 → 丢弃超长 detail）。
//   * 截断阈值（2048 字节 / 200 字符 / 6 条 / 8 项）为建议值，待实测后校准。

const MAX_LIST_ITEMS = 8;
const MAX_TRACE_BYTES = 2048;
const MAX_TEXT_CHARS = 200;
const MAX_CHECKS = 6;

// 名单类数组截断：长度超过 MAX_LIST_ITEMS 且元素全为字符串的数组（工具/预设名
// 单）替换为 { values: 前 8 项, truncated: true }。数值类数组（如 usage）元素非
// 字符串，不截断，避免误伤。
function truncateLists(value) {
  if (Array.isArray(value)) {
    const isNameList = value.length > MAX_LIST_ITEMS && value.every((item) => typeof item === 'string');
    return isNameList ? { values: value.slice(0, MAX_LIST_ITEMS), truncated: true } : value;
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = truncateLists(value[key]);
    return out;
  }
  return value;
}

// 单条 trace 骨架。parentContext / requested 由调用方组装后传入（调用方能拿到
// 运行时的父会话快照与请求参数）。gates 初始为空，逐道闸经 recordGate 追加。
export function createDecisionTrace(parentContext, requested, startedAt = Date.now()) {
  return {
    version: 1,
    startedAt,
    parentContext: parentContext ?? {},
    requested: requested ?? {},
    gates: [],
    effective: undefined,
    execution: undefined,
    settled: undefined,
  };
}

// 记录一道闸。gate = { name, input, output, verdict, reason }；input/output 内的
// 名单类数组在此截断（见 truncateLists）。reason 缺省时不写入（保持体积）。
export function recordGate(trace, gate) {
  trace.gates.push({
    name: gate.name,
    input: truncateLists(gate.input ?? {}),
    output: truncateLists(gate.output ?? {}),
    verdict: gate.verdict,
    ...(gate.reason !== undefined ? { reason: gate.reason } : {}),
  });
  return trace;
}

// 定稿：写入 effective / execution / settled（三者均缺省时不写）。后台/continuable
// 无 settled，早期拒绝无 effective——缺省跳过，保证三分支轨迹结构一致且可空。
export function finalizeTrace(trace, parts = {}) {
  if (parts.effective !== undefined) trace.effective = parts.effective;
  if (parts.execution !== undefined) trace.execution = parts.execution;
  if (parts.settled !== undefined) trace.settled = parts.settled;
  return trace;
}

// 父会话上下文快照（判定依据的输入部分）。parentPreset 拿不到记 undefined。
export function parentContextOf({ parentPreset, parentProvider, parentModel, parentToolCount, allowFailOpen }) {
  return { parentPreset, parentProvider, parentModel, parentToolCount, allowFailOpen };
}

// 请求参数快照。requested.prompt 原文绝不进 trace（体积 + 隐私），只记
// persona / toolFilter 的存在性布尔。
export function requestedOf(args) {
  return {
    profile: args.profile,
    preset: args.preset,
    provider: args.provider,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    persona_present: typeof args.persona === 'string' && args.persona.length > 0,
    toolFilter_present: args.toolFilter !== undefined,
    maxTokens: args.maxTokens,
    maxDepth: args.maxDepth,
    envelope: args.envelope === true,
  };
}

// 生效值（与 buildMeta 同源字段 + ignored 列表）。ignored 与结果块的 ignored
// 列表同源：continuable 为 ['preset','reasoningEffort']，前/后台为空数组。
export function effectiveMeta(meta, ignored = []) {
  return {
    profile: meta.profile,
    preset: meta.preset,
    provider: meta.provider,
    model: meta.model,
    reasoningEffort: meta.reasoningEffort,
    tokenTier: meta.tokenTier,
    ignored,
  };
}

// 成本闸 ① 硬上限（maxTokens / maxDepth）的预判条目。cap 由调用方注入（自
// pure.mjs 的 MAX_TOKENS / MAX_DEPTH 读取）；这里只判、不 throw——真正的硬上限
// throw 仍在 assertCostGuard 内的 assertHardLimits 完成。
export function hardLimitChecks(args, maxTokensCap, maxDepthCap) {
  const verdict = (value, cap) => (typeof value === 'number' && value > cap ? 'fail' : 'pass');
  return [
    { field: 'maxTokens', checkedAgainst: 'hardCap', input: args.maxTokens, cap: maxTokensCap, verdict: verdict(args.maxTokens, maxTokensCap) },
    { field: 'maxDepth', checkedAgainst: 'hardCap', input: args.maxDepth, cap: maxDepthCap, verdict: verdict(args.maxDepth, maxDepthCap) },
  ];
}

// 审批闸（声明性不变量，非运行时判定）：宿主未暴露可读的会话审批策略值，按
// 子 Agent 权限范围在启动时固定（委派不豁免审批）记 'never'。
export function recordApprovalGate(trace) {
  recordGate(trace, {
    name: 'approval',
    input: { policy: 'never' },
    output: { applied: 'never' },
    verdict: 'pass',
    reason: '派发不豁免审批：子 Agent 权限范围在启动时固定（DELEGATION_CONTEXT 语义）',
  });
}

// 失败路径定稿 + 记账：拿不到 sessionId 时跳过（createFailureLedger.record 内部
// 也拒绝空 id）。调用方随后 rethrow 原错误对象（文案逐字不变）。
export function recordFailure(ledger, parent, trace) {
  ledger.record(parent?.session?.header?.id, assertTraceSize(trace));
}

// --- 体积护栏：单条 trace JSON ≤ MAX_TRACE_BYTES --------------------------------

// 逐级截断 detail/reason 长文本到 MAX_TEXT_CHARS（仅命中键名为 detail/reason 的
// 字符串字段）。
function truncateLongTexts(node, max) {
  if (Array.isArray(node)) {
    for (const item of node) truncateLongTexts(item, max);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'string' && (key === 'detail' || key === 'reason') && value.length > max) {
        node[key] = value.slice(0, max);
      } else {
        truncateLongTexts(value, max);
      }
    }
  }
}

// 截断 cost 闸的 checks 数组到前 MAX_CHECKS 条。
function truncateChecks(gates, max) {
  for (const gate of gates) {
    const checks = gate.output?.checks;
    if (Array.isArray(checks) && checks.length > max) gate.output.checks = checks.slice(0, max);
  }
}

// 丢弃 detail 字段（最后一级兜底）：detail 是冗长自由文本，field/checkedAgainst/
// verdict 才是结构化摘要——仍超限时整体移除 detail，保留结构化键。
function dropDetails(node) {
  if (Array.isArray(node)) {
    for (const item of node) dropDetails(item);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (key === 'detail') delete node[key];
      else dropDetails(node[key]);
    }
  }
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// 单条 trace 体积护栏：JSON 序列化后须 ≤ MAX_TRACE_BYTES，超出时逐级收敛——
//   ① 截 gates 的 detail/reason 长文本到 MAX_TEXT_CHARS；
//   ② 截 cost 闸 checks 数组到前 MAX_CHECKS 条；
//   ③ 仍超则整体移除 detail 字段（保留 field/checkedAgainst/verdict 结构化摘要）。
// 三步均不改派发行为，只丢展示冗余；护栏不 throw（fail-soft），trace 始终可写。
export function assertTraceSize(trace) {
  if (byteLength(trace) <= MAX_TRACE_BYTES) return trace;
  truncateLongTexts(trace.gates, MAX_TEXT_CHARS);
  if (byteLength(trace) <= MAX_TRACE_BYTES) return trace;
  truncateChecks(trace.gates, MAX_CHECKS);
  if (byteLength(trace) <= MAX_TRACE_BYTES) return trace;
  dropDetails(trace.gates);
  return trace;
}

// --- 进程内失败台账 -------------------------------------------------------------

// 会话级内存失败台账（Map<sessionId, Array<trace>>）。参数注入、弃单例；每会话
// 上限 maxPerSession、总量上限 maxTotal，超限丢弃最旧并 warn（fail-soft，绝不
// 阻断派发失败路径）。warn 由调用方注入（宿主 logger 或测试捕获器）。
export function createFailureLedger({ maxPerSession = 50, maxTotal = 500, warn = () => {} } = {}) {
  const sessions = new Map();

  function count() {
    let total = 0;
    for (const list of sessions.values()) total += list.length;
    return total;
  }

  function dropOldestOverall() {
    const firstKey = sessions.keys().next();
    if (firstKey.done) return;
    const list = sessions.get(firstKey.value);
    list.shift();
    if (list.length === 0) sessions.delete(firstKey.value);
  }

  function record(sessionId, trace) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return;
    let list = sessions.get(sessionId);
    if (list === undefined) {
      list = [];
      sessions.set(sessionId, list);
    }
    list.push(trace);
    if (list.length > maxPerSession) {
      list.shift();
      warn(`dispatch ledger: 会话 ${sessionId} 失败记录超过每会话上限 ${maxPerSession}，已丢弃最旧一条`);
    }
    while (count() > maxTotal) {
      dropOldestOverall();
      warn(`dispatch ledger: 失败台账总量超过上限 ${maxTotal}，已丢弃最旧一条`);
    }
  }

  function get(sessionId) {
    const list = sessions.get(sessionId);
    return list === undefined ? [] : [...list];
  }

  function take(sessionId) {
    const list = sessions.get(sessionId);
    if (list === undefined) return [];
    sessions.delete(sessionId);
    return [...list];
  }

  function clear() {
    sessions.clear();
  }

  return { record, get, take, clear, count };
}
