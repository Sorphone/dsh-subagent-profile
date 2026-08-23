// lib/core/delegation.mjs — background one-shot settling + delegation metadata
// assembly, moved from index.mjs. Local lib references only: imports
// stopReasonError / withPartialText / textFrom from lib/core/pure.mjs (the shipped
// shims.readResult is NOT used by settleStart — it is used only by the
// foreground result closure in lib/core/profile-provider.mjs); no @deepseek-ai
// dependency.

import { stopReasonError, withPartialText, textFrom } from './pure.mjs';

// 子 Agent 会话的真实计费 token 五段分解：累加 session.events 里每条
// assistant/message 事件携带的 provider usage（inputTokens / outputTokens /
// cacheReadTokens / cacheWriteTokens / reasoningTokens）。这是宿主 dsh-llm
// assembler 产出、dsh-session-stats 同源读取的真实计费口径，与
// childTotalTokens（tokenMeter 对 surface 的字符密度启发式估算）并存：前者是
// provider 实际报告的用量，后者是估算值，二者语义不同、互不替代。任何字段缺失
// 按 0 累加；可选字段（缓存读/写/推理）全程无一条事件报告时省略该键；无任何
// 事件带 usage 时返回 undefined（调用方不写 meta，向前兼容）。非 object / 非
// number 一律忽略（fail-soft），使累加绝不阻断派发结算。
//
// 只累加 assistant/message：assistant/chunk 的 usage 是同一 step 的早期分片、
// 随后会被该 step 的 message 事件替换——两者都累加会重复计数（若未来改成
// 前缀匹配或累加 chunk，此守卫必须同步改并补测试）。
export function collectChildUsage(session) {
  if (session === undefined || session === null) return undefined;
  const events = session.events;
  if (!Array.isArray(events)) return undefined;
  const totals = { inputTokens: 0, outputTokens: 0 };
  const optionalTotals = { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const seenOptional = new Set();
  let anyUsage = false;
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) continue;
    anyUsage = true;
    for (const key of ['inputTokens', 'outputTokens']) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) totals[key] += value;
    }
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        optionalTotals[key] += value;
        seenOptional.add(key);
      }
    }
  }
  if (!anyUsage) return undefined;
  const out = { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens };
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (seenOptional.has(key)) out[key] = optionalTotals[key];
  }
  return out;
}

// 逐次调用明细：按与 collectChildUsage 同口径遍历 assistant/message 事件，逐条
// 产出单步五段 usage（inputTokens/outputTokens 恒在、缺报按 0；可选字段缓存读/写/
// 推理仅该条报告时携带）。返回前 maxCalls 条 + truncated（总数 > maxCalls）+
// totalCalls（总数）；无任何 usage 事件返回 undefined。与 collectChildUsage 并存：
// 前者是逐次明细（账本展开区），后者是会话总量（结算 meta），互不替代。非 object /
// 非 number 一律忽略（fail-soft），使逐条收集绝不阻断派发结算。
//
// maxCalls 默认 6（非 12）：单条 calls 的五段 JSON 键名主导体积（约 100 字节/条），
// 6 条 ≈ 700 字节，叠加决策轨迹骨架（gates/effective/execution/requested 约 1.5KB）
// 合计约 2.2KB——故 assertTraceSize 的护栏预算为 3072 字节，且超预算时还有
// calls 截断级（截到前 4 条，见 decision-trace.mjs 的 truncateSettledCalls）。
// 若需更严可继续下调 maxCalls。
export function collectChildCalls(session, maxCalls = 6) {
  if (session === undefined || session === null) return undefined;
  const events = session.events;
  if (!Array.isArray(events)) return undefined;
  const calls = [];
  let totalCalls = 0;
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) continue;
    totalCalls += 1;
    if (calls.length >= maxCalls) continue;
    const call = { inputTokens: 0, outputTokens: 0 };
    for (const key of ['inputTokens', 'outputTokens']) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) call[key] = value;
    }
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) call[key] = value;
    }
    calls.push(call);
  }
  if (totalCalls === 0) return undefined;
  return { calls, truncated: totalCalls > maxCalls, totalCalls };
}

// Settle one background one-shot run into a job outcome with the same
// observability metadata the foreground path reports. Non-completed stop reasons
// become failed (aborted => killed, shipped vocabulary) with partial output
// attached; hard failures never reject the job.
// `prune` is the result-recycle pre-clipper: the caller (dispatch
// execute) injects a closure that calls the host toolResultPruner.pruneContent
// before textFrom; defaulting to identity keeps the background path safe when no
// pruner is available. `t0` is the dispatch execute entry timestamp; the settled
// outcome carries `elapsedMs = now - t0` and the underlying `stopReason` (the
// shipped terminal vocabulary). Defaulting t0 to now keeps direct callers (tests)
// working without threading a timestamp.
export async function settleStart(start, signal, meta, prune = (blocks) => blocks, measureChild = () => undefined, t0 = Date.now()) {
  let run;
  try {
    run = await start;
    const result = await run.result;
    const failure = stopReasonError(result);
    if (failure !== undefined) {
      return {
        status: result.stopReason === 'aborted' ? 'killed' : 'failed',
        detail: withPartialText(failure, result.output),
        ...meta,
        elapsedMs: Date.now() - t0,
        stopReason: result.stopReason
      };
    }
    // 仅 completed 结算时测量（非 completed 走上方失败分支，不测）；在 dispose
    // 之前读子 session，保证测量拿到完整事件流。measureChild 缺失/失败返回
    // undefined → 省略字段（fail-soft）；childUsage 同样只在可累加时携带。
    const childSession = run.localAgent?.session;
    const childTotalTokens = measureChild(childSession);
    const childUsage = collectChildUsage(childSession);
    const childCalls = collectChildCalls(childSession);
    const metaOut = {
      ...meta,
      ...(childTotalTokens !== undefined ? { childTotalTokens } : {}),
      ...(childUsage !== undefined ? { childUsage } : {}),
      ...(childCalls !== undefined ? { calls: childCalls } : {}),
      elapsedMs: Date.now() - t0,
      stopReason: 'completed'
    };
    return { status: 'completed', output: textFrom(prune(result.output)), ...metaOut };
  } catch (error) {
    return signal.aborted
      ? { status: 'killed', ...meta, elapsedMs: Date.now() - t0, stopReason: 'aborted' }
      : { status: 'failed', detail: String(error), ...meta, elapsedMs: Date.now() - t0, stopReason: 'error' };
  } finally {
    // Release the child handle no matter how the result settled — run.result
    // rejecting must not leak the subagent (same discipline as the foreground
    // try/finally).
    if (run !== undefined) await run.dispose().catch(() => {});
  }
}

// Verbatim from the shipped SUBAGENT_DELEGATION_CONTEXT.
export const DELEGATION_CONTEXT = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.';

// Provider start 内 CUSTOM childSessionMeta 对象的纯组装，从 provider start
// 抽出的可安全移动部分。取值侧仍留在 provider start（调用方
// 注入）：cwd / parentSession 取自 parent.session.header，parentComposed /
// swapPreset 由 agentPresets.composedPreset 与 profile.preset 算出，childDepth
// 来自 resolveChildDepth。hasPresets=false（rosterless）时 agentPreset 整个省略
// （非 rosterless 才记录——语义与原始内联对象逐字一致）。
export function buildDispatchMeta({ cwd, hasPresets, swapPreset, preset, parentComposed, parentSession, childDepth }) {
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(hasPresets
      ? swapPreset
        ? { agentPreset: preset }
        : parentComposed !== undefined
          ? { agentPreset: parentComposed }
          : {}
      : {}),
    parentSession,
    origin: 'subagent',
    delegationDepth: childDepth
  };
}
