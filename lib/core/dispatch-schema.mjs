// lib/core/dispatch-schema.mjs — dispatch 工具的 output 结果 schema（closed oneOf），
// 从 dispatch-tool.mjs 拆出的纯数据声明（拆出时同步新增 elapsedMs/stopReason 共享
// 字段）。三个分支（background / continuable / foreground）共享同一套元数据键集
// （判别键 kind/jobId/subagentId/output 除外），由 pure.mjs 的
// assertResultSchemaConsistency 在 apply 时锁定——任一分支漏补共享字段即 throw。
// 纯数据、零依赖。

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
        ignored: { type: 'array', items: { type: 'string' } }
      }
    }
  ]
};
