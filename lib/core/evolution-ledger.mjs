// lib/core/evolution-ledger.mjs — 派发台账（dispatch.jsonl）采集。JSONL 追加不可变：
// 只 appendFileSync 追加一行，绝不改写既有行。import-free（仅 node 内置
// fs/crypto/path + lib/core/pure.mjs），可被 bare-CI 单测直接 import。采集异常只
// warn + 丢失计数，绝不阻断派发（fail-soft）。
//
// 隐私红线：绝不落子 Agent 原始输出 / prompt 原文 / persona 原文——每条记录只有长度
// （min-PII）与确定性结构指纹。persona 只存 present 布尔 + 文本结构指纹；toolFilter 只
// 存 present + allow/deny 数组结构指纹。parent_adopted / goal_achieved / human_edited
// 不入库（写入那个时刻它们尚不存在，事后回填会破坏 append-only 不可变性，只由聚合层
// 惰性 join）。

import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { textFrom } from './pure.mjs';

const LEDGER_VERSION = 1;
const SOURCE = 'system';
const ORIGIN = 'subagent';

// --- 结构指纹（确定性，输入相同恒产出相同指纹）----------------------------------
// 长度做导流 + sha1 前 8 区分内容：仅截断哈希可被碰撞枚举，叠加前缀长度后同时刻画
// 内容形状与体量，避免可枚举碰撞。不含原文。
function fingerprint(text) {
  const value = String(text ?? '');
  const hash = createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 8);
  return `L${value.length}_${hash}`;
}

// prompt 规范化结构指纹：长度 + 换行数 + sha1 前 8（内容形状标识，独缺原文）。
function structureFingerprint(prompt) {
  const value = String(prompt ?? '');
  let newlines = 0;
  for (let i = 0; i < value.length; i += 1) if (value[i] === '\n') newlines += 1;
  return `${fingerprint(value)}_NL${newlines}`;
}

// allow/deny 数组结构指纹：各数组的项数 + 内容 sha1（只对数组结构，不含父级配置）。
function toolFilterFingerprint(toolFilter) {
  const list = (arr) => (Array.isArray(arr) ? arr : []);
  const allow = list(toolFilter?.allow);
  const deny = list(toolFilter?.deny);
  const part = (label, arr) => `${label}:N${arr.length}_${fingerprint(JSON.stringify(arr))}`;
  return `${part('allow', allow)};${part('deny', deny)}`;
}

// cfg（requested/effective 双栏共用）。pending 为 merged（continuable 时部分值会被
// 丢弃）；opts 覆盖生效栏（continuable 生效 preset 恒 'inherit'、reasoningEffort 被
// 宿主忽略应空置）。双栏拆分正是为捕捉「请求了但被宿主丢弃」的失真。空字段统一
// 归一为 null（不写 undefined，保持 JSONL 行形状稳定）。
function cfgOf(merged, opts = {}) {
  const persona = typeof merged?.persona === 'string' ? merged.persona : '';
  const hasPersona = persona.length > 0;
  const toolFilterSet = merged?.toolFilter !== undefined && merged?.toolFilter !== null;
  const str = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
  return {
    preset: opts.preset ?? (typeof merged?.preset === 'string' && merged.preset !== '' ? merged.preset : 'inherit'),
    provider: str(merged?.provider),
    model: str(merged?.model),
    reasoningEffort: opts.reasoningEffort !== undefined ? opts.reasoningEffort : str(merged?.reasoningEffort),
    maxTokens: typeof merged?.maxTokens === 'number' ? merged.maxTokens : null,
    maxDepth: typeof merged?.maxDepth === 'number' ? merged.maxDepth : null,
    persona_present: hasPersona,
    persona_fp: hasPersona ? fingerprint(persona) : null,
    toolFilter_present: toolFilterSet,
    toolFilter_fp: toolFilterSet ? toolFilterFingerprint(merged.toolFilter) : null,
  };
}

// 记录静态元数据（写入即知的共享字段，不含 ts/v——由 record 落盘时补）。三分支各自
// 在此基础上补 child_id 与 outcome 后调用 record。pluginVersion 由工厂闭包注入。
function buildBase({ parent, args, merged, mode, pluginVersion }) {
  const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
  const effectivePreset = mode === 'continuable' ? 'inherit' : (merged?.preset ?? 'inherit');
  // continuable 下宿主忽略 reasoningEffort（决策轨迹侧将其列入 ignored），生效栏
  // 空置以保持「生效值」语义与聚合层读值不失真。
  const effectiveReasoningEffort = mode === 'continuable' ? null : (merged?.reasoningEffort ?? null);
  return {
    // session_id 空值归一 null：它是未来聚合层惰性 join 的键，静默缺失会破坏
    // join 且难察觉，显式 null 至少保持 JSONL 行形状稳定。
    session_id: parent?.session?.header?.id ?? null,
    mode,
    origin: ORIGIN,
    requested: cfgOf(merged),
    effective: cfgOf(merged, { preset: effectivePreset, reasoningEffort: effectiveReasoningEffort }),
    task: {
      len: prompt.length,
      structure: structureFingerprint(prompt),
    },
    source: SOURCE,
    provenance: `dispatch:v${pluginVersion}`,
    plugin_version: pluginVersion,
  };
}

// --- outcome 组装（前台/后台结算时携带；continuable 无结算 → 不产 outcome）--------

// tool_count 为「携带 usage 的 assistant/message 事件数」（collectChildCalls 的
// totalCalls），是工具调用次数的可测代理而非字面计数值——宿主会话面无更直接的
// 工具调用计数字段；拿不到记 null。
function foregroundOutcome({ result, elapsedMs, prunedOutputLen, toolCount }) {
  const stopReason = result?.stopReason ?? 'completed';
  const completed = stopReason === 'completed';
  return {
    status: completed ? 'completed' : (stopReason === 'aborted' ? 'killed' : 'failed'),
    stop_reason: stopReason,
    elapsed_ms: elapsedMs,
    output_len: prunedOutputLen,
    tool_count: completed ? toolCount : null,
  };
}

function backgroundOutcome(settled) {
  const s = settled !== null && typeof settled === 'object' ? settled : {};
  const totalCalls = s.calls !== null && typeof s.calls === 'object' && typeof s.calls.totalCalls === 'number'
    ? s.calls.totalCalls
    : null;
  return {
    status: s.status ?? 'failed',
    stop_reason: s.stopReason ?? 'error',
    elapsed_ms: s.elapsedMs,
    output_len: typeof s.output === 'string' ? s.output.length : 0,
    tool_count: totalCalls,
  };
}

// --- 三分支 finish 助手：每条派发只加一行调用（守 dispatch-tool 行门）------------

export function finishForegroundLedger(ledger, base, childId, result, prunedBlocks, elapsedMs, childCalls) {
  const calls = childCalls ?? {};
  ledger.record({
    ...base,
    child_id: childId,
    mode: 'foreground',
    outcome: foregroundOutcome({
      result,
      elapsedMs,
      prunedOutputLen: textFrom(prunedBlocks).length,
      toolCount: typeof calls.totalCalls === 'number' ? calls.totalCalls : null,
    }),
  });
}

export function finishBackgroundLedger(ledger, base, childId, settled) {
  ledger.record({ ...base, child_id: childId, mode: 'background', outcome: backgroundOutcome(settled) });
}

export function finishContinuableLedger(ledger, base, childId) {
  ledger.record({ ...base, child_id: childId, mode: 'continuable' });
}

// --- 工厂 -----------------------------------------------------------------------

export function createEvolutionLedger({ dshHome, pluginVersion, warn = () => {} } = {}) {
  if (typeof dshHome !== 'string' || dshHome.length === 0) {
    throw new Error('dispatch ledger: 派发台账需要 dshHome 目录');
  }
  const dir = join(dshHome, 'subagent-evolution');
  const file = join(dir, 'dispatch.jsonl');
  let lost = 0;
  return {
    baseEntry: (input) => buildBase({ ...input, pluginVersion }),
    // 追加不可变：mkdir recursive + appendFileSync。写失败只 warn + 丢失计数 ++，
    // 绝不抛错、绝不阻断派发（dispatch-tool 在分支结算处调用，异常不得外泄）。
    record(entry) {
      const line = JSON.stringify({ v: LEDGER_VERSION, ts: Date.now(), ...entry });
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(file, `${line}\n`, 'utf8');
      } catch (error) {
        lost += 1;
        warn(`dispatch ledger: 派发台账写入失败，已丢失 ${lost} 条（${error instanceof Error ? error.message : String(error)}）`);
      }
    },
    lostCount: () => lost,
  };
}
