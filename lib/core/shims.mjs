// lib/core/shims.mjs — facade。唯一 import index.mjs 依赖的 @deepseek-ai
// 符号的模块，收敛此前散落在顶层的 import 面。两类失败：
//
//   守卫型（fail-loud，无回退）：assertSubagentMaxDepth / resolveChildDepth
//   是**静态** import 并再导出。宿主 rc 里改名/移除会让本模块——进而
//   index.mjs——在加载时以 ESM 链接错误失败（"The requested module ... does
//   not provide an export named '...'"）。这正是委派深度安全闸想要的加载时
//   隔离：绝不替换为弱化实现，子 Agent 永远不可能派发超过 MAX_DEPTH。
//
//   函数映射型（fail-soft + warn）：foldConsumedWork / finalAssistantOutput /
//   createUserMessage / appendDelegatedPolicyOverrides /
//   captureDelegatedPolicyOverrides / resolveChildAgentOptions / defineTool
//   用 try/catch 包裹的动态顶层 await import 加载。导入失败（或命名导出被
//   改名/移除）时模块仍能加载，发出 console.warn（模块顶层没有 ctx，没有
//   logger），并使用本地功能等价（或安全降级）实现。
//
//   动态 import 的包能加载但命名导出被改名/移除时，解构结果为 `undefined`
//   且**不抛**，所以 loadSoft 还校验值是函数后才接受。

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
// 守卫型：静态、fail-loud、无回退。只保留这两个静态 @deepseek-ai import；
// 导出缺失会在 apply 能运行之前就以明确错误中止模块加载——这正是本类存在的隔离。
import { assertSubagentMaxDepth, resolveChildDepth } from '@deepseek-ai/dsh-subagent';
import { toStopReason } from './pure.mjs';

// warn：模块顶层没有 ctx / logger，降级用 console.warn。
// 前缀让来源在共享宿主日志中可辨认。
function warn(...parts) {
  console.warn('[dsh-subagent-profile]', ...parts);
}

// 加载一个函数映射型 `@deepseek-ai` 符号，包或命名导出不可用时返回本地回退。
// `warnMessage` 携带可操作的用户面向文案。`importer` 是可注入加载器（缺省为
// 动态 `import`——见 DYNAMIC_IMPORT），测试 / 未来加载器可覆盖失败路径
// （如 stub 成抛错，或返回缺该符号的模块对象）。为此导出为接缝。
//
// 注意：`import` 是关键字，不能作值引用（`importer = import` 是 SyntaxError），
// 故缺省值是动态 import 表达式的薄包装。
const DYNAMIC_IMPORT = (specifier) => import(specifier);
async function loadSoft(pkg, symbol, fallback, warnMessage, importer = DYNAMIC_IMPORT) {
  try {
    const mod = await importer(pkg);
    if (typeof mod?.[symbol] === 'function') return mod[symbol];
    warn(warnMessage);
    return fallback;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`${warnMessage}（导入失败：${detail}）`);
    return fallback;
  }
}

// --- 本地回退（import-free、duck-typed、功能等价）------------------------------
// 每个都是保留官方助手可观察契约的最小本地实现；经 `__fallbacks` 导出，测试在
// junction 包解析成功时也能走降级路径。

// foldConsumedWork: **近似、非等价**——readResult 只读 `.end`（终止 turn/end 事件）来
// 推导 stopReason。shipped fold 是精密的 stepped/claimed 状态机；本降级实现取最后一个
// `turn/end` 事件。在多 turn 或「有 claim 但未 step」的 turn 边缘场景，`.end` 可能异于
// 宿主 shipped fold（后者只在 stepped 或 claimed+accountsForClaim 的 turn 上落 `.end`），
// 因此**勿当作完全等价**。仅因 readResult 只消费 `.end`、且此为减压路径才作此近似；
// `droppedUnrun` 不被 readResult 使用，保守置 false。
function foldConsumedWorkFallback(events) {
  let end;
  for (const event of events) {
    if (event && event.type === 'turn/end') end = event;
  }
  return { ...(end === undefined ? {} : { end }), droppedUnrun: false };
}

// finalAssistantOutput：相同的 fold 规则——最后一个非空 assistant/message，
// 否则累加的 text-delta 分片，再否则 undefined。
function finalAssistantOutputFallback(events) {
  let message;
  const partial = [];
  for (const event of events) {
    if (event && event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (Array.isArray(content) && content.length > 0) message = content;
    } else if (event && event.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
      const text = event.data.chunk.text;
      if (typeof text === 'string' && text.length > 0) partial.push(text);
    }
  }
  if (message !== undefined) return message;
  const text = partial.join('');
  return text.length > 0 ? [{ type: 'text', text }] : undefined;
}

// createUserMessage：构造 followup 驱动需要的 user 角色消息。官方助手用品牌化
// MessageId + deepFreeze；回退提供相同可观察形状（role/content/id/source）加
// 新鲜随机 id。注意：返回对象是**可变**的（无 deepFreeze）——消费方不得依赖
// 官方 deepFreeze 的不可变性；把它当普通消息对象。
function createUserMessageFallback(input) {
  return {
    ...input,
    role: 'user',
    id: randomUUID(),
  };
}

// appendDelegatedPolicyOverrides：委派策略写进子会话日志供重建。这也是安全
// 相关的「approval: never」钉，绝不能是 no-op——忠实复现追加，保持子会话自身
// 日志可重建、钉可见。
function appendDelegatedPolicyOverridesFallback(childSession, overrides) {
  const o = overrides || {};
  if (o.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: o.sandboxMode, source: 'delegation' });
  }
  if (o.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: o.approvalPolicy, source: 'delegation' });
  }
}

// captureDelegatedPolicyOverrides：父的显式沙箱覆盖（无则 undefined）加父有
// approval 服务时的审批钉 'never'。可选链让 mock 父（测试）正常工作。
function captureDelegatedPolicyOverridesFallback(parent) {
  return {
    sandboxMode: parent.ctx?.get?.('sandboxPolicy')?.overrideOf?.(parent.session),
    approvalPolicy: parent.ctx?.get?.('approval') === undefined ? undefined : 'never',
  };
}

// resolveChildAgentOptions：合并父路由（provider/model/maxTokens，存在才带）
// 与 per-child 覆盖，并盖上子自身的深度。必须保持子配置语义——no-op 会静默
// 破坏委派路由。
function resolveChildAgentOptionsFallback(parent, requested, childDepth) {
  const parentProvider = parent.options?.provider;
  const parentModel = parent.options?.model;
  const parentMaxTokens = parent.options?.maxTokens;
  return {
    ...(parentProvider !== undefined ? { provider: parentProvider } : {}),
    ...(parentModel !== undefined ? { model: parentModel } : {}),
    ...(parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {}),
    ...(requested || {}),
    subagentDepth: childDepth,
  };
}

// defineTool：没有 dsh-tools 就没有 dispatch 工具。在用途点 fail-loud 并给出
// 清晰可操作的文案——模块仍然加载，apply 期间调用它才暴露确切的缺失依赖
// （加载不崩溃，调用点才报错）。
function defineToolFallback() {
  throw new Error('dsh-tools 缺失：dispatch 工具不可用');
}

// --- 接线函数映射型符号（模块顶层 await）---------------------------------------
// 七个加载相互独立，并行（Promise.all）以削减模块加载延迟；每个失败仍降级到
// 本地回退。junction 解析成功时保留真函数，宿主 rc 改名/移除符号时用回退。
const [foldConsumedWork, finalAssistantOutput, createUserMessage, appendDelegatedPolicyOverrides, captureDelegatedPolicyOverrides, resolveChildAgentOptions, defineTool] = await Promise.all([
  loadSoft('@deepseek-ai/dsh-agent', 'foldConsumedWork', foldConsumedWorkFallback, 'dsh-agent 的 foldConsumedWork 不可用，结果裁切使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-subagent', 'finalAssistantOutput', finalAssistantOutputFallback, 'dsh-subagent 的 finalAssistantOutput 不可用，子结果选取使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-llm', 'createUserMessage', createUserMessageFallback, 'dsh-llm 的 createUserMessage 不可用，用户消息构造使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-subagent', 'appendDelegatedPolicyOverrides', appendDelegatedPolicyOverridesFallback, 'dsh-subagent 的 appendDelegatedPolicyOverrides 不可用，委派策略追加使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-subagent', 'captureDelegatedPolicyOverrides', captureDelegatedPolicyOverridesFallback, 'dsh-subagent 的 captureDelegatedPolicyOverrides 不可用，委派策略捕获使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-subagent', 'resolveChildAgentOptions', resolveChildAgentOptionsFallback, 'dsh-subagent 的 resolveChildAgentOptions 不可用，子 Agent 选项解析使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-tools', 'defineTool', defineToolFallback, 'dsh-tools 缺失：dispatch 工具不可用'),
]);

// readResult：官方形状。终止 turn 的原因来自 foldConsumedWork；选取的输出来自
// finalAssistantOutput（最后一个非空 assistant/message，否则拼接的 text-delta
// 分片，再否则 undefined -> []）。
function readResult(child, boundary, cancelled) {
  const own = child.session.events.slice(boundary);
  const end = foldConsumedWork(own).end;
  const recorded = toStopReason(end?.data.reason);
  const stopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded;
  return { output: finalAssistantOutput(own) ?? [], stopReason };
}

// --- 版本探测（纯探测）--------------------------------------------------------
// 读取 @deepseek-ai 三包（subagent/agent/llm）的 package.json version，与
// peerDependencies 范围（>=PEER_MIN <PEER_MAX）比对后产出中文 warnings。纯探测：
// 只读 manifest、不 import 新符号、不触发副作用；每包独立 try/catch，失败记
// 'unknown'。headless / 宿主裁剪部署下任一包都可能缺失，此时 warnings 非空，
// 设置页据此在顶部渲染 amber 提示条（不阻断派发）。
const requirePkg = createRequire(import.meta.url);
const PEER_MIN = '0.1.0-rc.6';
const PEER_MAX = '0.2.0';
const PROBED_PACKAGES = ['dsh-subagent', 'dsh-agent', 'dsh-llm'];

// 读单包 version（每包独立 try/catch，失败记 'unknown'）。用 createRequire 直接
// require 包的 package.json（返回解析后的对象），免去 fs 读取与 JSON.parse。
function readPackageVersion(pkg) {
  try {
    const manifest = requirePkg(`@deepseek-ai/${pkg}/package.json`);
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// 极简 semver 比较：major.minor.patch + 可选 `-预发布` 段（覆盖 peerDependencies
// 范围判断所需）。预发布 < 正式版；预发布段逐段比较，纯数字段按数值、否则按字典序
// （`0.1.0-rc.10` > `0.1.0-rc.6`）。
function compareSemver(a, b) {
  const [aCore, aPre = ''] = a.split('-');
  const [bCore, bPre = ''] = b.split('-');
  const aNums = aCore.split('.').map((n) => Number(n));
  const bNums = bCore.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const x = aNums[i] ?? 0;
    const y = bNums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (aPre === bPre) return 0;
  if (aPre === '') return 1;   // 正式版 > 预发布
  if (bPre === '') return -1;
  const aParts = aPre.split('.');
  const bParts = bPre.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const x = aParts[i];
    const y = bParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;   // 数字标识 < 非数字标识（semver 约定）
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// 版本是否落在 peerDependencies 范围（>=PEER_MIN 且 <PEER_MAX）。
function inPeerRange(version) {
  return compareSemver(version, PEER_MIN) >= 0 && compareSemver(version, PEER_MAX) < 0;
}

// detectVersions(reader?) — 纯探测三包版本并产出 { versions, warnings }。
// `reader` 可选注入（默认 readPackageVersion），供测试模拟「包缺失 / 版本越界」
// 而无需删除 node_modules（与 loadSoft 的 importer 注入同一思路）。
export function detectVersions(reader = readPackageVersion) {
  const versions = {};
  for (const pkg of PROBED_PACKAGES) versions[pkg] = reader(pkg);
  const warnings = [];
  for (const pkg of PROBED_PACKAGES) {
    const version = versions[pkg];
    if (version === 'unknown') {
      warnings.push(`未检测到 @deepseek-ai/${pkg} 版本（包缺失或被宿主裁剪）——请确认其已按 peerDependencies 范围安装`);
    } else if (!inPeerRange(version)) {
      warnings.push(`@deepseek-ai/${pkg} 版本 ${version} 超出 peerDependencies 范围（>=${PEER_MIN} <${PEER_MAX}），派发行为可能与预期不符`);
    }
  }
  return { versions, warnings };
}

// 仅供测试访问本地降级实现（包导入在这里可解析，真函数胜出；`__fallbacks`
// 让测试无需删 node_modules 即可走 fail-soft 路径）。
export const __fallbacks = {
  foldConsumedWork: foldConsumedWorkFallback,
  finalAssistantOutput: finalAssistantOutputFallback,
  createUserMessage: createUserMessageFallback,
  appendDelegatedPolicyOverrides: appendDelegatedPolicyOverridesFallback,
  captureDelegatedPolicyOverrides: captureDelegatedPolicyOverridesFallback,
  resolveChildAgentOptions: resolveChildAgentOptionsFallback,
  defineTool: defineToolFallback,
};

export {
  assertSubagentMaxDepth,
  resolveChildDepth,
  // ---- 测试接缝 / 可注入加载器（见 loadSoft 文档）----
  loadSoft,
  foldConsumedWork,
  finalAssistantOutput,
  createUserMessage,
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  resolveChildAgentOptions,
  defineTool,
  readResult,
  // ---- 版本探测接缝（见 detectVersions 文档）----
  readPackageVersion,
};
