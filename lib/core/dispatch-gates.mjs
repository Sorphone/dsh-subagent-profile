// lib/core/dispatch-gates.mjs — dispatch 预检段各道闸的应用 + 决策轨迹记录，
// 从 dispatch-tool.mjs 拆出以守文件行门。闸逻辑与 fail-loud 文案逐字不变；
// 这里只「应用闸并就地记录 decisionTrace 的 pass/fail」，不改变任何派发行为。
//
// 依赖边界（无 @deepseek-ai 依赖）：只 import lib/core 纯模块——cost-guard
// （assertCostGuard）、decision-trace（recordGate / hardLimitChecks）、pure
// （MAX_TOKENS / MAX_DEPTH）。

import { assertCostGuard } from './cost-guard.mjs';
import { recordGate, hardLimitChecks } from './decision-trace.mjs';
import { MAX_TOKENS, MAX_DEPTH, computeContinuableAllow } from './pure.mjs';

// Pre-check: explicit concrete preset must be in the runtime-derived whitelist;
// a preset equal to the parent's composed preset is rewritten to 'inherit' (no swap).
// 纯函数化：whitelist / parentComposed 由调用方预检段 resolve 一次后注入（避免重复
// list()），throw 语义与文案逐字不变。
function assertPresetWhitelist(merged, whitelist, parentComposed) {
  if (typeof merged.preset !== 'string' || merged.preset === 'inherit') return;
  if (!whitelist.has(merged.preset)) {
    throw new Error(`dispatch: preset "${merged.preset}" is not in the target-preset whitelist`);
  }
  if (merged.preset === parentComposed) merged.preset = 'inherit';
}

// 白名单闸：预检段只 resolve 一次名单，结果同时喂本闸与 trace。'inherit' 改写
// 也如实记入 resolvedPreset；fail 时先记 fail 闸再 rethrow（文案不变）。
export function applyWhitelistGate(trace, merged, whitelist, parentComposed) {
  const input = { requestedPreset: typeof merged.preset === 'string' ? merged.preset : undefined, systemTrustCandidates: [...whitelist] };
  try {
    assertPresetWhitelist(merged, whitelist, parentComposed);
    recordGate(trace, { name: 'whitelist', input, output: { allowed: true, resolvedPreset: merged.preset ?? 'inherit' }, verdict: 'pass' });
  } catch (error) {
    recordGate(trace, { name: 'whitelist', input, output: { allowed: false, resolvedPreset: input.requestedPreset }, verdict: 'fail', reason: error.message });
    throw error;
  }
}

// 成本闸：硬上限（maxTokens/maxDepth）在调 assertCostGuard 前自行预判（不重复
// throw，真 throw 仍在 assertHardLimits）；llm 能力面各检查项经 assertCostGuard
// 的 onCheck 回调逐项回填。预判读 merged（profile 合并后的实际判定值）而非原始
// args——保证轨迹 check 与真闸判定口径一致（profile 携带超限值时两者必须同 fail）。
// fail 时先记 fail 闸再 rethrow（文案不变）。
export async function applyCostGuardGate(trace, merged, parent, deps) {
  const allowFailOpen = deps.store.getAllowFailOpen();
  const input = { provider: merged.provider, model: merged.model, reasoningEffort: merged.reasoningEffort, maxTokens: merged.maxTokens, maxDepth: merged.maxDepth, allowFailOpen };
  const checks = hardLimitChecks(merged, MAX_TOKENS, MAX_DEPTH);
  try {
    await assertCostGuard(parent, merged, allowFailOpen, deps.logger, deps.catalog, (entry) => checks.push(entry));
    recordGate(trace, { name: 'cost', input, output: { checks }, verdict: 'pass' });
  } catch (error) {
    recordGate(trace, { name: 'cost', input, output: { checks }, verdict: 'fail', reason: error.message });
    throw error;
  }
}

// 禁用门（continuable 专属显式检查）：provider start 的 !enabled 只拦 start、
// 不拦 startContinuable；syncTool 注销工具对 continuable 是间接门，故在此显式
// fail-loud。检查位于全部闸之前——与「禁用时不得静默派生子树」的既有语义一致，
// 且保证交集闸不会在禁用态先于本门抛其它文案。
export function assertContinuableEnabled(deps, args) {
  if (args.continuable === true && !deps.getEnabled()) {
    throw new Error('dispatch: 插件已禁用（设置 → 子 Agent 方案 重新启用）');
  }
}

// 交集闸（三分支统一在 approval 之前记录，闸序一致）：前/后台真交集由宿主在
// 子会话启动时计算（execute 返回之后），记 deferred；continuable 在此预加工
// 闭集 allow（空集 fail-loud），同一结果同时用于轨迹记录与 request 组装。
// 返回 continuable 的 effectiveAllow（非 continuable 返回 undefined）。
export function applyIntersectionGate(trace, mode, intersectionInput, merged, parentToolNames) {
  if (mode !== 'continuable') {
    recordGate(trace, { name: 'intersection', input: intersectionInput, output: { mode: 'deferred' }, verdict: 'pass', reason: '子工具交集由宿主在子会话启动时计算（restrictChildTools），结果体现在结算 stopReason/error' });
    return undefined;
  }
  try {
    const effectiveAllow = computeContinuableAllow(parentToolNames, merged.toolFilter);
    recordGate(trace, { name: 'intersection', input: intersectionInput, output: { effectiveAllowCount: effectiveAllow.length }, verdict: 'pass' });
    return effectiveAllow;
  } catch (error) {
    recordGate(trace, { name: 'intersection', input: intersectionInput, output: {}, verdict: 'fail', reason: error.message });
    throw error;
  }
}

// 读取父工具名（失败软回退为空数组）。真实宿主 ctx.tools.schemas 恒存在；测试
// fake 父 Agent 可能缺 tools，故此处守卫，避免预检段破坏前/后台路径。
export function readParentToolNames(parent) {
  const tools = parent.ctx?.tools;
  if (tools === undefined || typeof tools.schemas !== 'function') return [];
  const schemas = tools.schemas(parent);
  return Array.isArray(schemas) ? schemas.map((schema) => schema.name) : [];
}
