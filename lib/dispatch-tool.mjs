// lib/dispatch-tool.mjs — the `dispatch` tool (defineTool schema + execute),
// the R1 result-schema lock, and the syncTool register/unregister logic, moved
// verbatim from index.mjs (Task 7c). Local lib + shims references only; no
// @deepseek-ai dependency (shims is the only entry).
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

import { defineTool } from './shims.mjs';
import { computeContinuableAllow, textFrom, stopReasonError, withPartialText, pruneBlocks, assertResultSchemaConsistency } from './pure.mjs';
import { resolveWhitelist } from './whitelist.mjs';
import { assertCostGuard } from './cost-guard.mjs';
import { settleStart } from './delegation.mjs';

export function createDispatchTool({ register, store, getEnabled, getService, logger, subagents }) {
  const dispatchTool = defineTool({
    name: 'dispatch',
    description: 'Dispatch a subtask to a derived subagent, optionally overriding its preset, model, provider, reasoning effort, persona, tool whitelist, token budget, or recursion depth. Foreground waits for the result; run_in_background: true starts a background job (single turn); continuable: true starts a durable subagent whose conversation stays available for later turns via the send_message tool. 前瞻：continuable 模式忽略 preset 换用与 reasoningEffort（结果以 ignored 提示）。',
    parameters: {
      profile: { type: 'string', description: 'Optional profile id from the profile registry (built-ins: swap-standard, researcher, plus any you define in the settings page); omit to inherit the parent preset and tools as-is.' },
      preset: { type: 'string', description: 'Explicit target preset override; must be a system-trust preset of this runtime.' },
      model: { type: 'string', description: 'Explicit model override for the child.' },
      provider: { type: 'string', description: 'Explicit provider override for the child.' },
      reasoningEffort: { type: 'string', description: 'Explicit reasoning-effort override injected into every child request.' },
      persona: { type: 'string', description: 'Persona text shadowing the child deployment:persona section.' },
      toolFilter: {
        type: 'object',
        // F1: DSL object parameters reject unknown keys by default, so the
        // toolFilter object must close its schema or defineTool throws at
        // apply time and the plugin fails to load.
        additionalProperties: false,
        description: 'Extra tool whitelist intersection for the child (intersected with the parent tool set).',
        properties: {
          allow: { type: 'array', items: { type: 'string' }, description: 'When present, only these tool names are kept.' },
          deny: { type: 'array', items: { type: 'string' }, description: 'These tool names are always removed.' }
        }
      },
      maxTokens: { type: 'number', description: 'Explicit max-tokens budget for the child.' },
      maxDepth: { type: 'number', description: 'Absolute delegation-depth cap for this child.' },
      run_in_background: { type: 'boolean', description: '异步 one-shot：走 jobs.start 包 start()，返回 jobId；仍单轮即弃，非 continuable' },
      continuable: { type: 'boolean', description: 'Start a durable continuable subagent instead of a one-shot: returns a subagentId immediately and keeps the child conversation available for later turns via the send_message tool. Defaults to false.' },
      // §8.2 信封模式 = opt-in（仅「中段即交付物」的任务用）。首切片**仅预留**：
      // 工具 schema 暴露此参数作字段契约，execute 当前不消费它（结构化信封回收
      // 在 V2.0-中期启用）。见 execute 内注释。
      envelope: { type: 'boolean', description: '预留：结构化信封回收（V2.0 中期启用，当前不生效）' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the child (it does not see this conversation).' }
    },
    output: {
      schema: {
        // D: observability metadata on every result. OneOf covers the
        // background variant (kind/jobId) and the foreground variant (output),
        // both closed and both carrying the effective delegation values.
        // R1: `ignored` was added to ALL three branches (with the shared `preset`
        // / `provider` / `model` / `reasoningEffort` / `profile`), keeping the
        // closed oneOf consistent — assertResultSchemaConsistency(dispatchTool
        // .output.schema) in apply() fires if any 分支 忘补该字段.
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
              profile: { type: 'string' },
              preset: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
              ignored: { type: 'array', items: { type: 'string' } }
            }
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'continuable' },
              subagentId: { type: 'string', required: true },
              profile: { type: 'string' },
              preset: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
              ignored: { type: 'array', items: { type: 'string' } }
            }
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              output: { type: 'string', required: true },
              profile: { type: 'string' },
              preset: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
              ignored: { type: 'array', items: { type: 'string' } }
            }
          }
        ]
      },
      render: (_args, value) => {
        // §8.4: continuable 丢弃 preset 换用与 reasoningEffort —— 渲染行把
        // `ignored` 列表回显出来（`reasoningEffort=<值>(ignored)`，再加 ignored 项
        // 明细），让模型「看见」被丢弃项；background/foreground 无忽略项时该后缀为空。
        const ignored = value.ignored !== undefined && value.ignored.length > 0
          ? `(ignored: ${value.ignored.join(', ')})`
          : '';
        const text = value.kind === 'background'
          ? `[dispatch] background job ${value.jobId} · profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}`
          : value.kind === 'continuable'
            ? `[dispatch] started subagent ${value.subagentId} · profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}`
            : `[dispatch] profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}\n\n${value.output}`;
        return [{ type: 'text', text }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('dispatch requires calling agent');
      // Resolve the base profile (side channel), then overlay explicit args.
      const base = args.profile !== undefined ? store.resolveProfile(args.profile) : {};
      const merged = { ...base };
      for (const key of ['preset', 'model', 'provider', 'reasoningEffort', 'persona', 'toolFilter', 'maxTokens', 'maxDepth']) {
        if (args[key] !== undefined) merged[key] = args[key];
      }
      // Pre-check: explicit concrete preset must be in the runtime-derived
      // whitelist (F6); a preset equal to the parent's composed preset is
      // rewritten to 'inherit' (no swap).
      if (typeof merged.preset === 'string' && merged.preset !== 'inherit') {
        const whitelist = new Set(await resolveWhitelist(parent.ctx.get('agentPresets')));
        if (!whitelist.has(merged.preset)) {
          throw new Error(`dispatch: preset "${merged.preset}" is not in the target-preset whitelist`);
        }
        const parentPresets = parent.ctx.get('agentPresets');
        const parentComposed = parentPresets !== undefined ? parentPresets.composedPreset(parent.ctx) : undefined;
        if (merged.preset === parentComposed) merged.preset = 'inherit';
      }
      // F5: cost guard (runtime-derived; hard caps always applied, llm capability
      // gated by allowFailOpen — SPEC §7.3).
      await assertCostGuard(parent, merged, store.getAllowFailOpen(), logger);
      // D: effective delegation values for observability.
      const meta = {
        profile: args.profile ?? '(inline)',
        preset: merged.preset ?? 'inherit',
        provider: merged.provider ?? parent.options.provider ?? '(parent)',
        model: merged.model ?? parent.options.model ?? '(parent)',
        reasoningEffort: merged.reasoningEffort ?? '(default)'
      };
      const request = {
        label: String(args.prompt ?? '').slice(0, 60),
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        signal: exec.signal,
        profile: merged,
        ...(merged.persona !== undefined ? { persona: merged.persona } : {}),
        ...(merged.toolFilter !== undefined ? { toolFilter: merged.toolFilter } : {}),
        ...(merged.maxDepth !== undefined ? { maxDepth: merged.maxDepth } : {})
      };
      // §8.2 结果回收默认剪枝：在 textFrom(result.output) 之前复用宿主
      // toolResultPruner.pruneContent 预剪。`pruneResultOutput` 每次现取
      // ctx.get('toolResultPruner') 以反映服务就绪状态；pruner 缺失时
      // pruneBlocks 回退为不剪（剪枝是增强、非硬依赖）。envelope 参数虽已在
      // 工具 schema 暴露（预留，V2.0-中期启用结构化信封回收），但 execute
      // **不消费**它——本首切片只实现「剪枝默认」，不做信封注入。
      const pruneResultOutput = (blocks) => pruneBlocks(blocks, getService('toolResultPruner'));
      // Decision-level log: resolved effective delegation inputs, after the
      // cost guard and after request assembly, before dispatch.
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
      // Continuable (durable) path — startContinuable publishes a persistent
      // child and returns its durable id; the official send_message tool drives
      // later turns. Treated first so a caller asking for both background and
      // continuable gets the continuable child.
      if (args.continuable === true) {
        // 安全 P0-b（SPEC §7.1 第 2 条）：provider `start` 的 !enabled 检查只拦
        // `start`，不拦 `startContinuable` —— 这里显式补上。当前 syncTool 会在
        // 禁用时注销 dispatch 工具（间接门），此处是防御性兜底：禁用后
        // dispatch(continuable:true) 必须 fail-loud，不得静默派生子树。
        if (!getEnabled()) {
          throw new Error('dispatch: 插件已禁用（设置 → 子 Agent 方案 重新启用）');
        }
        if (args.run_in_background === true) {
          logger.warn('[dsh-subagent-profile] dispatch: both continuable and run_in_background are true; continuable takes precedence');
        }
        // 已知降级：continuable 标准路径不支持 preset swap 和 reasoningEffort（subagent 包的 SubagentStartRequest 无 preset 字段、AgentOptions 无 reasoningEffort 字段）
        if (merged.preset !== undefined && merged.preset !== 'inherit') {
          logger.warn(`[dsh-subagent-profile] continuable mode cannot swap preset; ignoring "${merged.preset}" (child inherits the parent preset)`);
        }
        if (merged.reasoningEffort !== undefined) {
          logger.warn(`[dsh-subagent-profile] continuable mode cannot set reasoningEffort; ignoring "${merged.reasoningEffort}"`);
        }
        // 安全 P0-b（SPEC §7.1 第 1 条）：预加工 toolFilter 为闭集 allow。continuable
        // 走宿主 applyChildComposition→tools.restrict，prepareContinuable 返回 {}，
        // 插件侧无法重算父∩子交集，故在此把 allow 预加工为闭集传到 request。
        //
        // 假设：continuable 继承父预设（preset swap 被忽略，见上方 warn）⇒
        // 子工具集 ≈ 父工具集，故 父集 − run_code − deny 可安全作为 restrict 的
        // allow。失效：任何导致子工具集与父工具集不一致的宿主行为变化（非仅
        // preset swap——例如未来允许 swap preset、组合不同工具集等），父集都可能
        // 含子集上不存在之工具 → tools.restrict 会抛「未知工具」→ 本缓解自动降级
        // 为 fail-loud（保守安全）——此时必须替换为真交集（父∩子）。
        const parentNames = new Set(parent.ctx.tools.schemas(parent).map((schema) => schema.name));
        const effectiveAllow = computeContinuableAllow(parentNames, merged.toolFilter);
        const hasAgentOptions = merged.provider !== undefined || merged.model !== undefined || merged.maxTokens !== undefined;
        const continuableRequest = {
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
        const { childId } = await subagents.startContinuable({
          provider: 'profile',
          label: String(args.prompt ?? '').slice(0, 60),
          request: continuableRequest,
          signal: exec.signal
        });
        // Continuable drops the profile's preset swap and reasoningEffort (the
        // child inherits the parent preset), so the observability meta must
        // report what actually took effect, not the requested-but-ignored values.
        // §8.4 可见性修复：`reasoningEffort` 回显**请求值**（经 meta.reasoningEffort，
        // 即 merged.reasoningEffort ?? '(default)'），`preset:'inherit'` 是真实生效值；
        // `ignored` 明确列出被丢弃项，让模型「看见」被忽略的字段。
        return {
          kind: 'continuable',
          subagentId: childId,
          profile: meta.profile,
          preset: 'inherit',
          provider: meta.provider,
          model: meta.model,
          reasoningEffort: meta.reasoningEffort,
          ignored: ['preset', 'reasoningEffort']
        };
      }
      // A: background one-shot (job) path — jobs.start wraps start() with a
      // native AbortController (a Node global in a bundle; the dynamic-plugin
      // sandbox needed the hand-rolled shim instead); still one turn, not
      // continuable.
      if (args.run_in_background === true) {
        const jobs = getService('jobs');
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
              done: settleStart(subagents.start('profile', { ...request, signal: controller.signal }), controller.signal, meta, pruneResultOutput)
            };
          }
        });
        return { kind: 'background', jobId, ...meta };
      }
      // Foreground: collect, always release the handle (E: dispose even when
      // run.result rejects), then fail loud on a non-completed stop reason.
      const run = await subagents.start('profile', request);
      let result;
      try {
        result = await run.result;
      } finally {
        await run.dispose().catch(() => {});
      }
      // F2: a non-'completed' stop reason is a failure; attach the child's
      // partial output text (withPartialText style).
      const failure = stopReasonError(result);
      if (failure !== undefined) throw new Error(withPartialText(failure, result.output));
      return { output: textFrom(pruneResultOutput(result.output)), ...meta };
    }
  });
  // R1（共享规则）lock: the closed oneOf result schema must carry an identical
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
