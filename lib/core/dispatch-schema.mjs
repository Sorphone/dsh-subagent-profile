// lib/core/dispatch-schema.mjs — dispatch 工具的纯数据声明（零依赖）：输入参数
// schema（DISPATCH_PARAMETERS）与 output 结果 schema（DISPATCH_OUTPUT_SCHEMA，
// closed oneOf），均从 dispatch-tool.mjs 拆出以守文件行门。
//
// 三个结果分支（background / continuable / foreground）共享同一套元数据键集
// （判别键 kind/jobId/subagentId/output 除外），由 pure.mjs 的
// assertResultSchemaConsistency 在 apply 时锁定——任一分支漏补共享字段即 throw。
// decisionTrace 是共享键：三分支都必须携带，但只锁「存在性」（深层结构由
// lib/core/decision-trace.mjs 的纯函数与单测保证），它经 output.presentationMeta
// 投影进会话块 meta 供客户端账本展示，不进模型可见面。

// 输入参数 schema（从 dispatch-tool.mjs 逐字移入；defineTool 只读不改）。
export const DISPATCH_PARAMETERS = {
  profile: { type: 'string', description: 'Optional profile id from the profile registry (built-ins: swap-standard, researcher, plus any you define in the settings page); omit to inherit the parent preset and tools as-is.' },
  preset: { type: 'string', description: 'Explicit target preset override; must be a system-trust preset of this runtime.' },
  model: { type: 'string', description: 'Explicit model override for the child.' },
  provider: { type: 'string', description: 'Explicit provider override for the child.' },
  reasoningEffort: { type: 'string', description: 'Explicit reasoning-effort override injected into every child request.' },
  tokenTier: { type: 'string', enum: ['cheap', 'balanced', 'premium'], description: '成本/深度分层（估算口径，非计费）：cheap 省 token、balanced 均衡、premium 高成本。覆盖 profile 的 tokenTier；缺省 balanced。' },
  persona: { type: 'string', description: 'Persona text shadowing the child deployment:persona section.' },
  toolFilter: {
    type: 'object',
    // DSL 对象参数默认拒绝未知键，toolFilter 必须闭合其 schema，
    // 否则 defineTool 在 apply 时 throw、插件加载失败。
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
  // 信封模式 = opt-in（仅「中段即交付物」的任务用）：true 时把信封骨架追加进
  // 子 persona（systemPrompt 影子段，模型可见），子 Agent 按结构化信封汇报；
  // 默认 false 走结果剪枝回收。
  envelope: { type: 'boolean', description: 'true 时子 Agent 按结构化信封汇报（简短结论 + 结构分项 + 关键发现落点），适合中段即交付物的长任务；默认 false 走剪枝回收' },
  prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the child (it does not see this conversation).' }
};

export const DISPATCH_OUTPUT_SCHEMA = {
  // Observability metadata on every result. OneOf covers the
  // background variant (kind/jobId) and the foreground variant (output),
  // both closed and both carrying the effective delegation values.
  // `ignored` must appear in ALL three branches (with the shared `preset`
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
        tokenTier: { type: 'string', enum: ['cheap', 'balanced', 'premium'], description: '成本/深度分层（估算口径，非计费）。' },
        childTotalTokens: { type: 'number', description: '子 Agent 会话 token 估算总量（宿主启发式估算，非计费 usage token）；后台结算经 job 结果携带，dispatch 结果不带。' },
        childUsage: {
          type: 'object',
          additionalProperties: false,
          description: '真实计费 token 五段分解（缓存读/写为可选）；后台结算经 job 结果携带，dispatch 结果不带。',
          properties: {
            inputTokens: { type: 'number' },
            outputTokens: { type: 'number' },
            cacheReadTokens: { type: 'number' },
            cacheWriteTokens: { type: 'number' },
            reasoningTokens: { type: 'number' }
          }
        },
        elapsedMs: { type: 'number', description: '派发耗时（毫秒，execute 入口到结算时刻）；后台结算经 job 结果携带，dispatch 结果不带。' },
        stopReason: { type: 'string', enum: ['completed', 'max-tokens', 'aborted', 'refusal', 'error'], description: '子 Agent 结束原因；后台结算经 job 结果携带，dispatch 结果不带。' },
        ignored: { type: 'array', items: { type: 'string' } },
        decisionTrace: { type: 'object', additionalProperties: true, description: '派发决策轨迹（供客户端账本展示，不进模型可见面）' }
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
        tokenTier: { type: 'string', enum: ['cheap', 'balanced', 'premium'], description: '成本/深度分层（估算口径，非计费）。' },
        childTotalTokens: { type: 'number', description: '子 Agent 会话 token 估算总量（宿主启发式估算，非计费 usage token）；仅前台/后台结算时携带，continuable 实际省略。' },
        childUsage: {
          type: 'object',
          additionalProperties: false,
          description: '真实计费 token 五段分解（缓存读/写为可选）；仅前台/后台 completed 结算时携带，continuable 实际省略。',
          properties: {
            inputTokens: { type: 'number' },
            outputTokens: { type: 'number' },
            cacheReadTokens: { type: 'number' },
            cacheWriteTokens: { type: 'number' },
            reasoningTokens: { type: 'number' }
          }
        },
        elapsedMs: { type: 'number', description: '派发耗时（毫秒，execute 入口到结算时刻）；continuable 不结算，实际省略。' },
        stopReason: { type: 'string', enum: ['completed', 'max-tokens', 'aborted', 'refusal', 'error'], description: '子 Agent 结束原因；continuable 不结算，实际省略。' },
        ignored: { type: 'array', items: { type: 'string' } },
        decisionTrace: { type: 'object', additionalProperties: true, description: '派发决策轨迹（供客户端账本展示，不进模型可见面）' }
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
        tokenTier: { type: 'string', enum: ['cheap', 'balanced', 'premium'], description: '成本/深度分层（估算口径，非计费）。' },
        childTotalTokens: { type: 'number', description: '子 Agent 会话 token 估算总量（宿主启发式估算，非计费 usage token）；仅前台 completed 结算时携带。' },
        childUsage: {
          type: 'object',
          additionalProperties: false,
          description: '真实计费 token 五段分解（缓存读/写为可选）；前台 completed 结算时携带。',
          properties: {
            inputTokens: { type: 'number' },
            outputTokens: { type: 'number' },
            cacheReadTokens: { type: 'number' },
            cacheWriteTokens: { type: 'number' },
            reasoningTokens: { type: 'number' }
          }
        },
        elapsedMs: { type: 'number', description: '派发耗时（毫秒，execute 入口到结算时刻）；前台 completed 结算时携带。' },
        stopReason: { type: 'string', enum: ['completed', 'max-tokens', 'aborted', 'refusal', 'error'], description: '子 Agent 结束原因；前台 completed 结算时携带。' },
        ignored: { type: 'array', items: { type: 'string' } },
        decisionTrace: { type: 'object', additionalProperties: true, description: '派发决策轨迹（供客户端账本展示，不进模型可见面）' }
      }
    }
  ]
};

// 结果 render 行（从 dispatch-tool.mjs 逐字移入以守文件行门）：continuable 丢弃
// preset 换用与 reasoningEffort —— 渲染行把 `ignored` 列表回显出来
// （`reasoningEffort=<值>(ignored)`，再加 ignored 项明细），让模型「看见」被丢弃项；
// background/foreground 无忽略项时该后缀为空。
export const DISPATCH_RENDER = (_args, value) => {
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
