// lib/core/delegation.mjs — background one-shot settling + delegation metadata
// assembly, moved from index.mjs. Local lib references only: imports
// stopReasonError / withPartialText / textFrom from lib/core/pure.mjs (the shipped
// shims.readResult is NOT used by settleStart — it is used only by the
// foreground result closure in lib/core/profile-provider.mjs); no @deepseek-ai
// dependency.

import { stopReasonError, withPartialText, textFrom } from './pure.mjs';

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
    // 之前读子 session。measureChild 缺失/失败返回 undefined → 省略字段（fail-soft）。
    const childTotalTokens = measureChild(run.localAgent?.session);
    const metaOut = {
      ...meta,
      ...(childTotalTokens !== undefined ? { childTotalTokens } : {}),
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
