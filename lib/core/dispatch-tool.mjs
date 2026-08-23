// lib/core/dispatch-tool.mjs — `dispatch` 工具（defineTool schema + execute）、
// 结果 schema 一致性锁与 syncTool 注册/注销逻辑，从 index.mjs 逐字拆出。
// 仅引用 lib + shims；无 @deepseek-ai 依赖（shims 是唯一入口）。
//
// 注入：所有 apply 闭包 / ctx 依赖都是显式参数——
//   register    ctx.tools.register（工具由 syncTool 注册/注销，设置开关可运行时移除），
//   store       profile store（resolveProfile 取基方案、getAllowFailOpen 供 cost guard），
//   getEnabled  读取 apply 闭包 `enabled` 标志（continuable fail-loud 门 +
//               syncTool 注册条件），
//   getService  请求时服务 getter（ctx.get('toolResultPruner') / ctx.get('jobs')
//               按次读取，绝不在 apply 时读），
//   logger      ctx.logger（决策级派发日志 + continuable 告警），
//   subagents   ctx.subagents（start / startContinuable 驱动子 Agent），
//   guard       dispatch guard（execute 入口 acquire / 结算 release+记账 /
//               syncTool 禁用时 cancelAll+reset）。
// 工厂返回 { syncTool, dispose }：syncTool 交给 HTTP 路由（/set-enabled），
// dispose 在插件卸载时运行。
//
// execute 按预检段 + 三分支拆为模块级私有函数；parameters / output schema 拆至
// dispatch-schema.mjs，预检闸应用拆至 dispatch-gates.mjs（守文件行门），零漂移。

import { defineTool } from './shims.mjs';
import { textFrom, stopReasonError, withPartialText, pruneBlocks, assertResultSchemaConsistency, trustLabel, trustAudit, dispatchLabel } from './pure.mjs';
import { resolveWhitelist } from './whitelist.mjs';
import { recordEscapeAllow } from './escape.mjs';
import { settleStart, collectChildUsage, collectChildCalls } from './delegation.mjs';
import { DISPATCH_OUTPUT_SCHEMA, DISPATCH_PARAMETERS, DISPATCH_RENDER } from './dispatch-schema.mjs';
import { createDecisionTrace, finalizeTrace, assertTraceSize, parentContextOf, requestedOf, effectiveMeta, recordApprovalGate, recordFailure, profileSnapshotOf } from './decision-trace.mjs';
import { profileDirectoryRows } from './profile-directory.mjs';
import { applyWhitelistGate, applyCostGuardGate, applyIntersectionGate, assertContinuableEnabled, readParentToolNames, applyBudgetGate } from './dispatch-gates.mjs';
import { trackForegroundInflight, trackBackgroundInflight, trackContinuableInflight } from './dispatch-guard.mjs';
import { finishForegroundLedger, finishBackgroundLedger, finishContinuableLedger } from './evolution-ledger.mjs';

// 信封骨架：envelope:true 时追加进子 persona 的结构化汇报契约（三分支共享）；骨架
// 只进 persona（systemPrompt 影子段、模型可见），不进 descriptor（model-hidden，仅 session 记录）。
const ENVELOPE_SKELETON = '完成前按以下骨架输出：## 结论（1-2 句）\n## 结构分项（逐项）\n## 关键发现落点（文件路径/数据位置）';

// --- execute 预检段（从 execute 拆出；行为逐字不变）-----------------------------

// 解析基方案（旁路），再叠加显式参数。
function mergeProfileArgs(args, store) {
  const base = args.profile !== undefined ? store.resolveProfile(args.profile) : {};
  const merged = { ...base };
  for (const key of ['preset', 'model', 'provider', 'reasoningEffort', 'persona', 'toolFilter', 'maxTokens', 'maxDepth', 'tokenTier']) {
    if (args[key] !== undefined) merged[key] = args[key];
  }
  return merged;
}

// 生效的委派值（供可观测元数据）。
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

// 组装前台/后台请求（continuable 在下方自建）。
function buildRequest(args, merged, parent, signal) {
  return {
    label: dispatchLabel(args, merged),
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
    signal,
    profile: merged,
    ...(merged.persona !== undefined ? { persona: merged.persona } : {}),
    ...(merged.toolFilter !== undefined ? { toolFilter: merged.toolFilter } : {}),
    ...(merged.maxDepth !== undefined ? { maxDepth: merged.maxDepth } : {})
  };
}

// 决策级日志：经 cost guard 与请求组装之后、派发之前的生效委派输入。
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

// Continuable（持久）路径：startContinuable 发布持久子会话并返回其持久 id，
// 后续轮次由官方 send_message 工具驱动。优先处理——同时要 background 与
// continuable 的调用方得到 continuable 子会话。
async function runContinuable(args, merged, meta, parent, exec, deps, trace, effectiveAllow, base) {
  // provider `start` 的 !enabled 检查只拦 `start` 不拦 `startContinuable`——此处
  // 显式兜底（syncTool 注销工具是间接门）：禁用后不得静默派生子树，必须 fail-loud。
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
    label: dispatchLabel(args, merged),
    request: continuableRequest,
    signal: exec.signal
  });
  trackContinuableInflight(deps.guard, deps.subagents, childId, parent.session?.header?.id);
  // Continuable 丢弃方案的 preset swap 与 reasoningEffort（子继承父预设），
  // 故可观测 meta 必须报告实际生效值，而非被忽略的请求值。
  // 可见性修复：`reasoningEffort` 回显**请求值**（经 meta.reasoningEffort），
  // `preset:'inherit'` 是真实生效值；`ignored` 明确列出被丢弃项。
  // 信任标注不适用：continuable 只回 subagentId、无文本 output（后续经宿主的
  // send_message 流转），没有可加前缀的回收文本，故此处不加 trustLabel。
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
  finishContinuableLedger(deps.evoLedger, base, childId); // 无结算：continuable 只写静态元数据（无 outcome）
  return out;
}

// --- 后台 / 前台分支（从 execute 拆出）--------------------------------------------

// 后台 one-shot（job）路径：jobs.start 包 start() 并提供原生
// AbortController；仍是一轮即弃，非 continuable。
async function runBackground(args, merged, meta, request, parent, deps, pruneResultOutput, t0, trace, guardHandle, base) {
  const jobs = deps.getService('jobs');
  if (jobs === undefined) {
    throw new Error('dispatch: 后台派发不可用：缺少 jobs 服务（请安装 @deepseek-ai/dsh-jobs 与 @deepseek-ai/dsh-tool-jobs，或改用前台派发）');
  }
  // jobId 由 jobs.start 同步返回，故用提升的 let 在结算（异步）时读取。
  let jobId;
  const onSettled = (settled) => {
    guardHandle.finish(jobId, settled.childTotalTokens);
    finishBackgroundLedger(deps.evoLedger, base, jobId, settled);
  };
  jobId = jobs.start({
    kind: 'subagent',
    label: dispatchLabel(args, merged),
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
          t0,
          deps.logger,
          onSettled
        )
      };
    }
  });
  trackBackgroundInflight(deps.guard, jobs, jobId, parent);
  // 后台：execute 返回时 start 尚未 resolve，无 settled（结算经 job 结果携带，不入会话块）。
  const out = { kind: 'background', jobId, ...meta };
  finalizeTrace(trace, { effective: effectiveMeta(meta, []), execution: { kind: 'background', parentSessionId: parent.session?.header?.id, jobId, mode: 'one-shot' } });
  out.decisionTrace = assertTraceSize(trace);
  return out;
}

// childTotalTokens：宿主 tokenMeter 启发式估算（surface 口径，非计费 usage）。
// 仅 completed 结算时测量；服务缺失/非函数/抛错均返回 undefined（fail-soft）。
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

// 仅 completed 结算时测量一次（tokenMeter 估算 + usage 分解 + 调用明细），dispose
// 前读子 session 保证事件流完整；全 fail-soft（缺失/抛错 → undefined）绝不阻断结算。
function measureForegroundRun(deps, run) {
  const childSession = run.localAgent?.session;
  return {
    childTotalTokens: measureChildTokens(deps.getService, childSession),
    childUsage: collectChildUsage(childSession),
    childCalls: collectChildCalls(childSession),
  };
}

// 前台：收集结果，无论 reject 与否都释放句柄，非 completed 停因 fail-loud；
// run.result reject（undefined）也写失败 outcome（M9）。
async function runForeground(meta, request, parent, deps, pruneResultOutput, t0, trace, guardHandle, base) {
  const run = await deps.subagents.start('profile', request);
  finalizeTrace(trace, { execution: { kind: 'foreground', parentSessionId: parent.session?.header?.id, childSessionId: run.id, mode: 'one-shot' } });
  trackForegroundInflight(deps.guard, run);
  let result;
  let measurement;
  try {
    result = await run.result;
    if (result.stopReason === 'completed') measurement = measureForegroundRun(deps, run);
  } finally {
    if (result === undefined) finishForegroundLedger(deps.evoLedger, base, run.id, { stopReason: 'error', output: [] }, [], Date.now() - t0, undefined);
    await run.dispose().catch(() => {});
    guardHandle.finish(run.id, measurement?.childTotalTokens); // untrack + recordTokens + release
  }
  const childTotalTokens = measurement?.childTotalTokens;
  const childUsage = measurement?.childUsage;
  const childCalls = measurement?.childCalls;
  // 台账：completed 与非 completed 都写 outcome（对照 settleStart 语义），随后非 completed 仍 throw。
  const pruned = pruneResultOutput(result.output);
  const elapsedMs = Date.now() - t0;
  finishForegroundLedger(deps.evoLedger, base, run.id, result, pruned, elapsedMs, childCalls, childTotalTokens, childUsage);
  const failure = stopReasonError(result);
  if (failure !== undefined) throw new Error(withPartialText(failure, result.output));
  const metaOut = {
    ...meta,
    ...(childTotalTokens !== undefined ? { childTotalTokens } : {}),
    ...(childUsage !== undefined ? { childUsage } : {}),
    elapsedMs,
    stopReason: result.stopReason
  };
  finalizeTrace(trace, {
    effective: effectiveMeta(metaOut, []),
    settled: {
      stopReason: result.stopReason,
      elapsedMs: metaOut.elapsedMs,
      ...(childTotalTokens !== undefined ? { childTotalTokens } : {}),
      ...(childUsage !== undefined ? { childUsage } : {}),
      ...(childCalls !== undefined ? { calls: childCalls } : {}),
    },
  });
  // 信任标注：completed 子结果回灌父上下文前加结构化前缀（profile/preset 元数据、
  // 无 prompt 原文），审计同字段 JSON 只进 logger、不进结果字符串。render 行首部
  // 格式不变——前缀只进 output 文本（模型看到的正文带头）。
  const output = `${trustLabel(metaOut)}${textFrom(pruned)}`;
  deps.logger.info('[dsh-subagent-profile] trusted-output: ' + trustAudit(metaOut));
  return { output, ...metaOut, decisionTrace: assertTraceSize(trace) };
}

// 预检段读取：whitelist / parentComposed / parentToolNames 只读取一次，同时喂闸
// 与轨迹（避免重复 list() / schemas()），并组装 trace 骨架与交集闸 input。
async function prepareTrace(args, parent, deps) {
  const agentPresets = parent.ctx.get('agentPresets');
  const whitelist = new Set(await resolveWhitelist(agentPresets, deps.getEscapeSet()));
  const parentComposed = agentPresets !== undefined ? agentPresets.composedPreset(parent.ctx) : undefined;
  const parentToolNames = readParentToolNames(parent);
  const parentToolCount = parentToolNames.length;
  // 决策输入快照：与 dispatch:profiles section 同源同序（profileDirectoryRows，
  // enabled、cheap-first）——「模型当时看到哪些候选」是回答「为什么这么选」的记录面。
  const rows = profileDirectoryRows(deps.store);
  const snapshot = profileSnapshotOf(rows, { chosenId: args.profile });
  const advicePresent = typeof deps.getEvolutionAdvice === 'function' && deps.getEvolutionAdvice() === true && parentComposed === 'orchestrator';
  const trace = createDecisionTrace(
    parentContextOf({
      parentPreset: parentComposed,
      parentProvider: parent.options.provider,
      parentModel: parent.options.model,
      parentToolCount,
      allowFailOpen: deps.store.getAllowFailOpen(),
    }),
    requestedOf(args, { profiles: snapshot.entries, advicePresent })
  );
  const mode = args.continuable === true ? 'continuable' : (args.run_in_background === true ? 'background' : 'foreground');
  const intersectionInput = { parentToolCount, requestedToolFilter: args.toolFilter, mode };
  return { whitelist, parentComposed, parentToolNames, trace, mode, intersectionInput };
}

// execute 主体：预检段 + 三分支分派。任一闸 fail 先记 fail 闸再 rethrow 原错误
// 对象，失败 trace 进进程内台账（deps.ledger）。
async function runDispatch(args, exec, deps) {
  const parent = exec.agent;
  if (!parent) throw new Error('dispatch: 缺少调用 Agent（值需来自模型/编排者会话，请勿直接调用本工具）');
  // 派发耗时基准：execute 入口记 t0，前台/后台各自在结算处算 elapsedMs。
  const t0 = Date.now();
  const { whitelist, parentComposed, parentToolNames, trace, mode, intersectionInput } = await prepareTrace(args, parent, deps);
  // 预算闸句柄提至 try 外：任何分支 throw（前台 start reject / 后台 jobs 缺失等）
  // 都在 catch 里幂等 release 并发槽——防错误路径把父会话的并发额度永久耗尽
  // （正常路径 finish 已 release，catch 再调为 no-op）。
  let guardHandle = { release: () => {} };
  try {
    const merged = mergeProfileArgs(args, deps.store);
    // 信封模式 opt-in：三分支创建子 Agent 前，把信封骨架追加进子 persona（systemPrompt
    // 影子段、模型可见），不触碰 descriptor；既有 persona 非空时以空行衔接追加。
    if (args.envelope === true) {
      const hasPersona = merged.persona !== undefined && merged.persona.trim() !== '';
      merged.persona = hasPersona ? `${merged.persona}\n\n${ENVELOPE_SKELETON}` : ENVELOPE_SKELETON;
    }
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
    // 总预算守卫：前/后台在 execute 入口占并发额度（continuable 不占），结算处 release
    // + recordTokens。guardHandle 传入分支用于释放与父 sessionId 记账。
    guardHandle = applyBudgetGate(deps, parent, args, trace);
    // 派发台账静态元数据（双栏 cfg/task 指纹），分支结算处补 child_id+outcome 写盘。
    const base = deps.evoLedger.baseEntry({ parent, args, merged, mode });
    recordEscapeAllow(deps, parent, merged, trace);
    if (args.continuable === true) return await runContinuable(args, merged, meta, parent, exec, deps, trace, effectiveAllow, base);
    if (args.run_in_background === true) return await runBackground(args, merged, meta, request, parent, deps, pruneResultOutput, t0, trace, guardHandle, base);
    return await runForeground(meta, request, parent, deps, pruneResultOutput, t0, trace, guardHandle, base);
  } catch (error) {
    guardHandle.release();
    recordFailure(deps.ledger, parent, trace);
    throw error;
  }
}

export function createDispatchTool({ register, store, getEnabled, getService, logger, subagents, catalog, ledger, guard, evoLedger, getEscapeSet, getEvolutionAdvice }) {
  const deps = { store, getEnabled, getService, logger, subagents, catalog, ledger, guard, evoLedger, getEscapeSet, getEvolutionAdvice };
  const dispatchTool = defineTool({
    name: 'dispatch',
    description: '派发子任务给派生子 Agent，可逐个覆盖其 preset、model、provider、推理档位、persona、工具白名单、token 预算或递归深度。前台等待结果；run_in_background: true 启动后台任务（单轮即弃）；continuable: true 启动持久子 Agent，后续轮次经 send_message 工具延续对话。前瞻：continuable 模式忽略 preset 换用与 reasoningEffort（结果以 ignored 提示）。',
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
  // 共享一致性规则锁：闭合 oneOf 结果 schema 的三个分支必须携带同一套共享
  // 元数据键集。只在 apply 时触发；未来加元数据字段时若漏掉某个分支，在这里
  // throw 一次（而不是让模型侧 schema 静默拒绝某个分支）。
  assertResultSchemaConsistency(dispatchTool.output.schema);
  // 只在启用时注册工具；开关一关立即注销，使工具无需重启就从模型的工具列表消失。
  let disposeTool;
  function syncTool() {
    if (getEnabled() && disposeTool === undefined) {
      disposeTool = register(dispatchTool);
    } else if (!getEnabled() && disposeTool !== undefined) {
      const dispose = disposeTool;
      disposeTool = undefined;
      if (typeof dispose === 'function') dispose();
      // 禁用：级联取消在途派发 + 清空并发/token 记账（重开后记账从零起步）。
      deps.guard.cancelAll();
      deps.guard.reset();
    }
  }
  syncTool();
  return {
    syncTool,
    dispose() {
      if (disposeTool !== undefined) {
        const dispose = disposeTool;
        disposeTool = undefined;
        if (typeof dispose === 'function') dispose();
      }
    }
  };
}
