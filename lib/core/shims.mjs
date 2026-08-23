// lib/core/shims.mjs — facade. The ONLY module that imports the
// @deepseek-ai symbols index.mjs relies on, converging the previously
// top-level-scattered import surface. Two failure classes:
//
//   Guard-type (fail-loud, NO fallback): assertSubagentMaxDepth /
//   resolveChildDepth are STATICALLY imported and re-exported. A rename/removal
//   in the host rc makes this module — and therefore index.mjs — fail at load
//   time with the ESM link error "The requested module ... does not provide an
//   export named '...'". That is exactly the loading-time isolation the spec
//   wants for the delegation-depth safety gates: no weakened reimplementation is
//   ever substituted, so a child can never be dispatched past MAX_DEPTH.
//
//   Function-mapping (fail-soft + warn): foldConsumedWork / finalAssistantOutput
//   / createUserMessage / appendDelegatedPolicyOverrides /
//   captureDelegatedPolicyOverrides / resolveChildAgentOptions / defineTool are
//   loaded with a dynamic top-level-await import wrapped in try/catch. On an
//   import failure (or a renamed/absent named export) the module still loads, a
//   console.warn is emitted (module top level has no ctx, so no logger), and a
//   local functionally-equivalent (or safe-degraded) implementation is used.
//
//   A dynamic import whose package loads but whose named export was renamed or
//   removed resolves the destructure to `undefined` WITHOUT throwing, so loadSoft
//   also verifies the value is a function before accepting it.

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
// Guard-type: static, fail-loud — no fallback. Kept as the only two
// static @deepseek-ai imports; a missing export aborts module load with a clear
// error BEFORE apply can run, which is the isolation this class exists for.
import { assertSubagentMaxDepth, resolveChildDepth } from '@deepseek-ai/dsh-subagent';
import { toStopReason } from './pure.mjs';

// warn: at module top level there is no ctx / logger, so degrade to console.warn.
// The prefix keeps the source recognizable in a shared host log.
function warn(...parts) {
  console.warn('[dsh-subagent-profile]', ...parts);
}

// Load one function-mapping `@deepseek-ai` symbol, returning a local fallback when
// the package or the named export is unavailable. `warnMessage` carries the
// actionable user-facing text. `importer` is an injectable loader (defaults to
// the dynamic `import` — see DYNAMIC_IMPORT) so tests / future loaders can
// override the failure route (e.g. stub it to throw, or return a module object
// missing the symbol). It is exported as a seam for that purpose.
//
// Note: `import` is a keyword and cannot be used as a value reference
// (`importer = import` is a SyntaxError), so the default is a thin wrapper around
// the dynamic import expression.
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

// --- local fallbacks (import-free, duck-typed, functionally equivalent) ----
// Each is the minimal local reimplementation that preserves the observable
// contract of the shipped helper; these are exported via `__fallbacks` so tests
// can exercise the degraded path even though the junction packages resolve
// successfully here.

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

// finalAssistantOutput: identical fold rule — last non-empty assistant/message,
// else accumulated text-delta chunks, else undefined.
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

// createUserMessage: build the user-role message the followup driver needs. The
// shipped helper uses a branded MessageId + deepFreeze; the fallback provides the
// same observable shape (role/content/id/source) with a fresh random id. Note:
// the returned object is MUTABLE (no deepFreeze) — consumers must NOT rely on
// the shipped deepFreeze immutability; treat it as a plain message object.
function createUserMessageFallback(input) {
  return {
    ...input,
    role: 'user',
    id: randomUUID(),
  };
}

// appendDelegatedPolicyOverrides: the delegation policy is authored INTO the
// child's log for reconstruction. This is also the security-relevant
// "approval: never" pin, so it must NOT be a no-op — reproduce the append
// faithfully to keep the child's own log reconstructable and the pin visible.
function appendDelegatedPolicyOverridesFallback(childSession, overrides) {
  const o = overrides || {};
  if (o.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: o.sandboxMode, source: 'delegation' });
  }
  if (o.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: o.approvalPolicy, source: 'delegation' });
  }
}

// captureDelegatedPolicyOverrides: the parent's explicit sandbox override (or
// undefined when none) plus the approval pin 'never' when the parent has an
// approval service. Optional chaining keeps a mock parent (tests) working.
function captureDelegatedPolicyOverridesFallback(parent) {
  return {
    sandboxMode: parent.ctx?.get?.('sandboxPolicy')?.overrideOf?.(parent.session),
    approvalPolicy: parent.ctx?.get?.('approval') === undefined ? undefined : 'never',
  };
}

// resolveChildAgentOptions: merge the parent's route (provider/model/maxTokens,
// present-only) with the per-child overrides and stamp the child's own depth.
// This must preserve the child-config semantics — a no-op here would silently
// break delegation routing.
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

// defineTool: the dispatch tool cannot exist without dsh-tools. Fail-loud at the
// point of use with a clear, actionable message — the module still LOADS, and
// calling this during apply surfaces the exact missing-dependency story instead
// of a cryptic module-not-found at import time（加载不崩溃，调用点才报错）。
function defineToolFallback() {
  throw new Error('dsh-tools 缺失：dispatch 工具不可用');
}

// --- wire the function-mapping symbols (module top-level await) --------------
// The seven loads are independent, so they run in parallel (Promise.all) to cut
// module-load latency; each still degrades to its local fallback on failure. We
// keep the real functions when the junction resolves, and the fallbacks when a
// host rc renamed/removed a symbol.
const [foldConsumedWork, finalAssistantOutput, createUserMessage, appendDelegatedPolicyOverrides, captureDelegatedPolicyOverrides, resolveChildAgentOptions, defineTool] = await Promise.all([
  loadSoft('@deepseek-ai/dsh-agent', 'foldConsumedWork', foldConsumedWorkFallback, 'dsh-agent 的 foldConsumedWork 不可用，结果裁切使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-subagent', 'finalAssistantOutput', finalAssistantOutputFallback, 'dsh-subagent 的 finalAssistantOutput 不可用，子结果选取使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-llm', 'createUserMessage', createUserMessageFallback, 'dsh-llm 的 createUserMessage 不可用，用户消息构造使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-subagent', 'appendDelegatedPolicyOverrides', appendDelegatedPolicyOverridesFallback, 'dsh-subagent 的 appendDelegatedPolicyOverrides 不可用，委派策略追加使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-subagent', 'captureDelegatedPolicyOverrides', captureDelegatedPolicyOverridesFallback, 'dsh-subagent 的 captureDelegatedPolicyOverrides 不可用，委派策略捕获使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-subagent', 'resolveChildAgentOptions', resolveChildAgentOptionsFallback, 'dsh-subagent 的 resolveChildAgentOptions 不可用，子 Agent 选项解析使用本地降级实现'),
  loadSoft('@deepseek-ai/dsh-tools', 'defineTool', defineToolFallback, 'dsh-tools 缺失：dispatch 工具不可用'),
]);

// readResult: shipped shape. The terminal turn reason comes from foldConsumedWork;
// the selected output comes from finalAssistantOutput (last non-empty assistant
// message, else joined text-delta chunks, else undefined -> []).
function readResult(child, boundary, cancelled) {
  const own = child.session.events.slice(boundary);
  const end = foldConsumedWork(own).end;
  const recorded = toStopReason(end?.data.reason);
  const stopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded;
  return { output: finalAssistantOutput(own) ?? [], stopReason };
}

// --- version detection (pure probe) ------------------------------------------
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

// Test-only access to the local degraded implementations (package imports
// resolve here, so the real functions win; __fallbacks lets a test exercise the
// fail-soft path without deleting node_modules).
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
  // ---- test seam / injectable loader (see loadSoft doc) ----
  loadSoft,
  foldConsumedWork,
  finalAssistantOutput,
  createUserMessage,
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  resolveChildAgentOptions,
  defineTool,
  readResult,
  // ---- version probe seam (see detectVersions doc) ----
  readPackageVersion,
};
