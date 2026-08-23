// lib/core/dispatch-tool.mjs — `dispatch` 工具（defineTool schema + execute）、
// 结果 schema 一致性锁与 syncTool 注册/注销逻辑，从 index.mjs 逐字拆出。
// 仅引用 lib + shims；无 @deepseek-ai 依赖（shims 是唯一入口）。
//
// Injection: every apply-closure / ctx dependency is an explicit parameter —
//   register    ctx.tools.register (the tool is registered/unregistered by
//               syncTool, so the settings switch can remove it at runtime),
//   store       the profile store (resolveProfile for the base profile,
//               getAllowFailOpen for the cost guard),
//   getEnabled  reads the apply-closure `enabled` flag (continuable fail-loud
//               gate + syncTool registration condition),
//   getService  request-time service getter (ctx.get('toolResultPruner') /
//               ctx.get('jobs') are read per call, never at apply time),
//   logger      ctx.logger (decision-level dispatch log + continuable warns),
//   subagents   ctx.subagents (start / startContinuable drive the child).
// The factory returns { syncTool, dispose }: syncTool is handed to the HTTP
// routes (/set-enabled), dispose runs on plugin teardown.
//
// execute 按预检段 + 三分支拆为模块级私有函数；parameters / output schema 拆至
// dispatch-schema.mjs，预检闸应用拆至 dispatch-gates.mjs（守文件行门），零漂移。

import { defineTool } from './shims.mjs';
import { textFrom, stopReasonError, withPartialText, pruneBlocks, assertResultSchemaConsistency } from './pure.mjs';
import { resolveWhitelist } from './whitelist.mjs';
import { settleStart, collectChildUsage } from './delegation.mjs';
import { DISPATCH_OUTPUT_SCHEMA, DISPATCH_PARAMETERS } from './dispatch-schema.mjs';
import { createDecisionTrace, finalizeTrace, assertTraceSize, parentContextOf, requestedOf, effectiveMeta, recordApprovalGate, recordFailure } from './decision-trace.mjs';
import { applyWhitelistGate, applyCostGuardGate, applyIntersectionGate, assertContinuableEnabled, readParentToolNames } from './dispatch-gates.mjs';

// 信封骨架：envelope:true 时追加进子 persona 的结构化汇报契约。三分支共享此
// 常量；骨架只进 persona（systemPrompt 影子段、模型可见），不进 descriptor
// （model-hidden、仅 session 记录），故 execute 在三分支创建子 Agent 前统一
// 追加到 merged.persona。
const ENVELOPE_SKELETON = '完成前按以下骨架输出：## 结论（1-2 句）\n## 结构分项（逐项）\n## 关键发现落点（文件路径/数据位置）';

// continuable 丢弃 preset 换用与 reasoningEffort —— 渲染行把 `ignored`
// 列表回显出来（`reasoningEffort=<值>(ignored)`，再加 ignored 项明细），让模型
// 「看见」被丢弃项；background/foreground 无忽略项时该后缀为空。
const DISPATCH_RENDER = (_args, value) => {
  const ignored = value.ignored !== undefined && value.ignored.length > 0
    ? `(ignored: ${value.ignored.join(', ')})`
    : '';
  const tier = typeof value.tokenTier === 'string' && value.tokenTier !== ''
    ? ` · tokenTier=${value.tokenTier}`
    : '';
  const tokens = typeof value.childTotalTokens === 'number'
    ? ` · childTotalTokens=${value.childTotalTokens}`
    : '';
  const elapsed = typeof value.elapsedMs === 'number'
    ? ` · elapsedMs=${value.elapsedMs}`
    : '';
  const stopReason = typeof value.stopReason === 'string' && value.stopReason !== ''
    ? ` · stopReason=${value.stopReason}`
    : '';
  // childUsage 是嵌套对象，render 行是扁平的 key=value，故 JSON 序列化为单段
  // 供 client 侧 parseDispatchText 解析回对象（五段分解）。仅前台 completed 结算
  // 携带；后台结算经 job 结果携带，continuable 不携带，故该段只在 foreground 行。
  const usage = value.childUsage !== undefined && value.childUsage !== null && typeof value.childUsage === 'object'
    ? ` · childUsage=${JSON.stringify(value.childUsage)}`
    : '';
  const text = value.kind === 'background'
    ? `[dispatch] background job ${value.jobId} · profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}${tier}`
    : value.kind === 'continuable'
      ? `[dispatch] started subagent ${value.subagentId} · profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}${tier}`
      : `[dispatch] profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}${tier}${tokens}${usage}${elapsed}${stopReason}\n\n${value.output}`;
  return [{ type: 'text', text }];
};

// --- execute 预检段（从 execute 拆出；行为逐字不变）-----------------------------

// Resolve the base profile (side channel), then overlay explicit args.
function mergeProfileArgs(args, store) {
  const base = args.profile !== undefined ? store.resolveProfile(args.profile) : {};
  const merged = { ...base };
  for (const key of ['preset', 'model', 'provider', 'reasoningEffort', 'persona', 'toolFilter', 'maxTokens', 'maxDepth', 'tokenTier']) {
    if (args[key] !== undefined) merged[key] = args[key];
  }
  return merged;
}

// Effective delegation values for observability.
function buildMeta(args, merged, parent) {
  return {
    profile: args.profile ?? '(inline)',
    preset: merged.preset ?? 'inherit',
    provider: merged.provider ?? parent.options.provider ?? '(parent)',
    model: merged.model ?? parent.options.model ?? '(parent)',
    reasoningEffort: merged.reasoningEffort ?? '(default)',
    tokenTier: merged.tokenTier ?? 'balanced'
  };
}

// Assemble the foreground/background request (continuable builds its own below).
function buildRequest(args, merged, parent, signal) {
  return {
    label: String(args.prompt ?? '').slice(0, 60),
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
    signal,
    profile: merged,
    ...(merged.persona !== undefined ? { persona: merged.persona } : {}),
    ...(merged.toolFilter !== undefined ? { toolFilter: merged.toolFilter } : {}),
    ...(merged.maxDepth !== undefined ? { maxDepth: merged.maxDepth } : {})
  };
}

// Decision-level log: resolved effective delegation inputs, after the cost
// guard and after request assembly, before dispatch.
function logDispatchDecision(logger, args, merged, parent) {
  logger.info('[dsh-subagent-profile] dispatch:', JSON.stringify({
    profile: args.profile ?? '(inline)',
    preset: merged.preset ?? 'inherit',
    provider: merged.provider ?? parent.options.provider ?? '(parent)',
    model: merged.model ?? parent.options.model ?? '(parent)',
    reasoningEffort: merged.reasoningEffort ?? '(default)',
    maxDepth: merged.maxDepth ?? null,
    background: args.run_in_background === true,
    continuable: args.continuable === true
  }));
}

// --- continuable 分支（从 execute 拆出）------------------------------------------

// 预加工 toolFilter 为闭集 allow（父工具集 − run_code − deny）：continuable
// 走宿主 applyChildComposition→tools.restrict，prepareContinuable 返回 {}，
// 插件侧无法重算父∩子交集，故在此把 allow 预加工为闭集传到 request。
// 假设：continuable 继承父预设（preset swap 被忽略）⇒ 子工具集 ≈ 父工具集；
// 失效条件：任何导致子工具集与父工具集不一致的宿主行为变化，父集都可能含
// 子集上不存在之工具 → tools.restrict 抛「未知工具」→ 本缓解自动降级为
// fail-loud（保守安全）。effectiveAllow 由调用方（runDispatch 交集闸处）算好
// 传入——同一结果同时用于 request 组装与决策轨迹记录，不重复计算。
function buildContinuableRequest(args, merged, parent, effectiveAllow) {
  const hasAgentOptions = merged.provider !== undefined || merged.model !== undefined || merged.maxTokens !== undefined;
  return {
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
    ...(hasAgentOptions ? { agentOptions: {
      ...(merged.provider !== undefined ? { provider: merged.provider } : {}),
      ...(merged.model !== undefined ? { model: merged.model } : {}),
      ...(merged.maxTokens !== undefined ? { maxTokens: merged.maxTokens } : {})
    } } : {}),
    ...(merged.persona !== undefined ? { persona: merged.persona } : {}),
    // 恒传闭集 allow（覆盖原 merged.toolFilter 透传）；空集在
    // computeContinuableAllow 内 fail-loud。
    toolFilter: { allow: effectiveAllow },
    ...(merged.maxDepth !== undefined ? { maxDepth: merged.maxDepth } : {})
  };
}

// Continuable (durable) path — startContinuable publishes a persistent child
// and returns its durable id; the official send_message tool drives later
// turns. Treated first so a caller asking for both background and continuable
// gets the continuable child.
async function runContinuable(args, merged, meta, parent, exec, deps, trace, effectiveAllow) {
  // provider `start` 的 !enabled 检查只拦
  // `start`，不拦 `startContinuable` —— 这里显式补上。当前 syncTool 会在
  // 禁用时注销 dispatch 工具（间接门），此处是防御性兜底：禁用后
  // dispatch(continuable:true) 必须 fail-loud，不得静默派生子树。
  if (!deps.getEnabled()) {
    throw new Error('dispatch: 插件已禁用（设置 → 子 Agent 方案 重新启用）');
  }
  if (args.run_in_background === true) {
    deps.logger.warn('[dsh-subagent-profile] dispatch: both continuable and run_in_background are true; continuable takes precedence');
  }
  // 已知降级：continuable 标准路径不支持 preset swap 和 reasoningEffort（subagent 包的 SubagentStartRequest 无 preset 字段、AgentOptions 无 reasoningEffort 字段）
  if (merged.preset !== undefined && merged.preset !== 'inherit') {
    deps.logger.warn(`[dsh-subagent-profile] continuable mode cannot swap preset; ignoring "${merged.preset}" (child inherits the parent preset)`);
  }
  if (merged.reasoningEffort !== undefined) {
    deps.logger.warn(`[dsh-subagent-profile] continuable mode cannot set reasoningEffort; ignoring "${merged.reasoningEffort}"`);
  }
  const continuableRequest = buildContinuableRequest(args, merged, parent, effectiveAllow);
  const { childId } = await deps.subagents.startContinuable({
    provider: 'profile',
    label: String(args.prompt ?? '').slice(0, 60),
    request: continuableRequest,
    signal: exec.signal
  });
  // Continuable drops the profile's preset swap and reasoningEffort (the child
  // inherits the parent preset), so the observability meta must report what
  // actually took effect, not the requested-but-ignored values.
  // 可见性修复：`reasoningEffort` 回显**请求值**（经 meta.reasoningEffort），
  // `preset:'inherit'` 是真实生效值；`ignored` 明确列出被丢弃项。
  const out = {
    kind: 'continuable',
    subagentId: childId,
    profile: meta.profile,
    preset: 'inherit',
    provider: meta.provider,
    model: meta.model,
    reasoningEffort: meta.reasoningEffort,
    tokenTier: meta.tokenTier,
    ignored: ['preset', 'reasoningEffort']
  };
  finalizeTrace(trace, {
    effective: effectiveMeta({ ...meta, preset: 'inherit' }, ['preset', 'reasoningEffort']),
    execution: { kind: 'continuable', parentSessionId: parent.session?.header?.id, childSessionId: childId, mode: 'continuable' },
  });
  out.decisionTrace = assertTraceSize(trace);
  return out;
}

// --- 后台 / 前台分支（从 execute 拆出）--------------------------------------------

// Background one-shot (job) path — jobs.start wraps start() with a native
// AbortController (a Node global in a bundle; the dynamic-plugin sandbox needed
// the hand-rolled shim instead); still one turn, not continuable.
async function runBackground(args, meta, request, parent, deps, pruneResultOutput, t0, trace) {
  const jobs = deps.getService('jobs');
  if (jobs === undefined) {
    throw new Error('dispatch: background jobs unavailable (load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs)');
  }
  const jobId = jobs.start({
    kind: 'subagent',
    label: String(args.prompt ?? '').slice(0, 60),
    owner: parent,
    run: () => {
      const controller = new AbortController();
      return {
        cancel: (reason) => controller.abort(reason ?? 'dispatch: background subagent task killed'),
        done: settleStart(
          deps.subagents.start('profile', { ...request, signal: controller.signal }),
          controller.signal,
          meta,
          pruneResultOutput,
          (session) => measureChildTokens(deps.getService, session),
          t0
        )
      };
    }
  });
  // 后台：execute 返回时 start 尚未 resolve，无 settled（结算经 job 结果携带，不入会话块）。
  const out = { kind: 'background', jobId, ...meta };
  finalizeTrace(trace, { effective: effectiveMeta(meta, []), execution: { kind: 'background', parentSessionId: parent.session?.header?.id, jobId, mode: 'one-shot' } });
  out.decisionTrace = assertTraceSize(trace);
  return out;
}

// childTotalTokens：子 Agent 会话的宿主启发式估算 token 总量（surface 口径），
// 非 provider 计费 usage token。仅 completed 结算时测量；tokenMeter 服务缺失、
// measure 非函数、返回缺 totalTokens 或抛错时均返回 undefined（fail-soft），
// 使测量绝不阻断派发结算。
function measureChildTokens(getService, session) {
  if (session === undefined || session === null) return undefined;
  const meter = getService('tokenMeter');
  if (meter === undefined || typeof meter.measure !== 'function') return undefined;
  try {
    const measured = meter.measure(session);
    return measured !== null && typeof measured === 'object' && typeof measured.totalTokens === 'number'
      ? measured.totalTokens
      : undefined;
  } catch {
    return undefined;
  }
}

// Foreground: collect, always release the handle (dispose even when
// run.result rejects), then fail loud on a non-completed stop reason.
async function runForeground(meta, request, parent, deps, pruneResultOutput, t0, trace) {
  const run = await deps.subagents.start('profile', request);
  finalizeTrace(trace, { execution: { kind: 'foreground', parentSessionId: parent.session?.header?.id, childSessionId: run.id, mode: 'one-shot' } });
  let result;
  let childTotalTokens;
  let childUsage;
  try {
    result = await run.result;
    // 仅 completed 结算时测量；dispose 前读子 session 保证事件流完整。
    if (result.stopReason === 'completed') {
      const childSession = run.localAgent?.session;
      childTotalTokens = measureChildTokens(deps.getService, childSession);
      childUsage = collectChildUsage(childSession);
    }
  } finally {
    await run.dispose().catch(() => {});
  }
  // 非 completed 视为失败，附子输出部分文本。
  const failure = stopReasonError(result);
  if (failure !== undefined) throw new Error(withPartialText(failure, result.output));
  // 结算 meta：elapsedMs 自 t0；stopReason 取底层值（此分支必 completed）；
  // childTotalTokens / childUsage 仅可测量时携带。
  const metaOut = {
    ...meta,
    ...(childTotalTokens !== undefined ? { childTotalTokens } : {}),
    ...(childUsage !== undefined ? { childUsage } : {}),
    elapsedMs: Date.now() - t0,
    stopReason: result.stopReason
  };
  finalizeTrace(trace, {
    effective: effectiveMeta(metaOut, []),
    settled: {
      stopReason: result.stopReason,
      elapsedMs: metaOut.elapsedMs,
      ...(childTotalTokens !== undefined ? { childTotalTokens } : {}),
      ...(childUsage !== undefined ? { childUsage } : {}),
    },
  });
  return { output: textFrom(pruneResultOutput(result.output)), ...metaOut, decisionTrace: assertTraceSize(trace) };
}

// 预检段读取：whitelist / parentComposed / parentToolNames 只读取一次，同时喂闸
// 与轨迹（避免重复 list() / schemas()），并组装 trace 骨架与交集闸 input。
async function prepareTrace(args, parent, deps) {
  const agentPresets = parent.ctx.get('agentPresets');
  const whitelist = new Set(await resolveWhitelist(agentPresets));
  const parentComposed = agentPresets !== undefined ? agentPresets.composedPreset(parent.ctx) : undefined;
  const parentToolNames = readParentToolNames(parent);
  const parentToolCount = parentToolNames.length;
  const trace = createDecisionTrace(
    parentContextOf({
      parentPreset: parentComposed,
      parentProvider: parent.options.provider,
      parentModel: parent.options.model,
      parentToolCount,
      allowFailOpen: deps.store.getAllowFailOpen(),
    }),
    requestedOf(args)
  );
  const mode = args.continuable === true ? 'continuable' : (args.run_in_background === true ? 'background' : 'foreground');
  const intersectionInput = { parentToolCount, requestedToolFilter: args.toolFilter, mode };
  return { whitelist, parentComposed, parentToolNames, trace, mode, intersectionInput };
}

// execute 主体：预检段 + 三分支分派。任一闸 fail 先记 fail 闸再 rethrow 原错误
// 对象，失败 trace 进进程内台账（deps.ledger）。
async function runDispatch(args, exec, deps) {
  const parent = exec.agent;
  if (!parent) throw new Error('dispatch requires calling agent');
  // 派发耗时基准：execute 入口记 t0，前台/后台各自在结算处算 elapsedMs。
  const t0 = Date.now();
  const merged = mergeProfileArgs(args, deps.store);
  // 信封模式 opt-in：三分支创建子 Agent 前，把信封骨架追加进子 persona（systemPrompt
  // 影子段、模型可见），不触碰 descriptor；既有 persona 非空时以空行衔接追加。
  if (args.envelope === true) {
    const hasPersona = merged.persona !== undefined && merged.persona.trim() !== '';
    merged.persona = hasPersona ? `${merged.persona}\n\n${ENVELOPE_SKELETON}` : ENVELOPE_SKELETON;
  }
  const { whitelist, parentComposed, parentToolNames, trace, mode, intersectionInput } = await prepareTrace(args, parent, deps);
  try {
    assertContinuableEnabled(deps, args);
    applyWhitelistGate(trace, merged, whitelist, parentComposed);
    // Cost guard（运行时推导；硬上限始终生效，llm 能力核验由 allowFailOpen 门控）。
    await applyCostGuardGate(trace, merged, parent, deps);
    // 交集闸（三分支统一闸序，见 dispatch-gates.mjs）；continuable 的 effectiveAllow
    // 同时用于 request 组装。
    const effectiveAllow = applyIntersectionGate(trace, mode, intersectionInput, merged, parentToolNames);
    recordApprovalGate(trace);
    const meta = buildMeta(args, merged, parent);
    const request = buildRequest(args, merged, parent, exec.signal);
    // 结果回收默认剪枝：在 textFrom 前复用宿主 toolResultPruner.pruneContent 预剪；
    // pruner 缺失时 pruneBlocks 回退为不剪（剪枝是增强、非硬依赖）。
    const pruneResultOutput = (blocks) => pruneBlocks(blocks, deps.getService('toolResultPruner'));
    logDispatchDecision(deps.logger, args, merged, parent);
    if (args.continuable === true) return runContinuable(args, merged, meta, parent, exec, deps, trace, effectiveAllow);
    if (args.run_in_background === true) return runBackground(args, meta, request, parent, deps, pruneResultOutput, t0, trace);
    return runForeground(meta, request, parent, deps, pruneResultOutput, t0, trace);
  } catch (error) {
    recordFailure(deps.ledger, parent, trace);
    throw error;
  }
}

export function createDispatchTool({ register, store, getEnabled, getService, logger, subagents, catalog, ledger }) {
  const deps = { store, getEnabled, getService, logger, subagents, catalog, ledger };
  const dispatchTool = defineTool({
    name: 'dispatch',
    description: 'Dispatch a subtask to a derived subagent, optionally overriding its preset, model, provider, reasoning effort, persona, tool whitelist, token budget, or recursion depth. Foreground waits for the result; run_in_background: true starts a background job (single turn); continuable: true starts a durable subagent whose conversation stays available for later turns via the send_message tool. 前瞻：continuable 模式忽略 preset 换用与 reasoningEffort（结果以 ignored 提示）。',
    parameters: DISPATCH_PARAMETERS,
    output: {
      schema: DISPATCH_OUTPUT_SCHEMA,
      render: DISPATCH_RENDER,
      // 决策轨迹经 presentationMeta 投影进会话块 meta（客户端账本数据源），不进 render 行。
      presentationMeta: (_args, value) => value.decisionTrace,
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => runDispatch(args, exec, deps),
  });
  // 共享一致性规则 lock: the closed oneOf result schema must carry an identical
  // shared meta key set across all three branches. Fires only at apply time; a
  // future meta-field add that forgets one 分支 throws here (once), so the
  // model-side schema never silently rejects a分支.
  assertResultSchemaConsistency(dispatchTool.output.schema);
  // Register the tool only while enabled; unregister it the moment the switch
  // turns off so it disappears from the model's tool list without a restart.
  let disposeTool;
  function syncTool() {
    if (getEnabled() && disposeTool === undefined) {
      disposeTool = register(dispatchTool);
    } else if (!getEnabled() && disposeTool !== undefined) {
      const dispose = disposeTool;
      disposeTool = undefined;
      dispose();
    }
  }
  syncTool();
  return {
    syncTool,
    dispose() {
      if (disposeTool !== undefined) {
        const dispose = disposeTool;
        disposeTool = undefined;
        dispose();
      }
    }
  };
}
