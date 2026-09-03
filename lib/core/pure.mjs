// lib/core/pure.mjs — 纯函数助手（从 index.mjs 拆出，经后续重构扩展）。
// 无 @deepseek-ai import、无外部依赖：唯一 import 是 node:crypto（dispatchLabel
// 用的 node 内置），@deepseek-ai 符号全部收敛在 lib/core/shims.mjs（唯一入口），
// 本模块可在 bare-CI 测试中无 junction 包安全导入。
// 这里每个函数都是确定性的，无服务/fs 访问。

import { createHash } from 'node:crypto';

// 官方 toStopReason：把一轮结束原因映射到接缝的终态词汇表。
export function toStopReason(reason) {
  switch (reason?.kind) {
    case 'completed': return 'completed';
    case 'max-tokens': return 'max-tokens';
    case 'aborted': return 'aborted';
    case 'blocked': return 'refusal';
    default: return 'error';
  }
}

// 官方 stopReasonError + withPartialText 措辞（dsh-tool-subagent L55-75）。
export function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return;
    case 'aborted': return 'dispatch: subagent run was cancelled';
    case 'error': return 'dispatch: subagent run failed';
    case 'max-tokens': return 'dispatch: subagent run hit its token limit before finishing';
    case 'refusal': return 'dispatch: subagent declined the task';
    default: return `dispatch: subagent run ended abnormally (${String(result.stopReason)})`;
  }
}

export function withPartialText(error, output) {
  const text = (Array.isArray(output) ? output : [])
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('');
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`;
}

export function textFrom(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

// --- 统一输入 schema ----------------------------------------------------------
// sanitizeProfile 是唯一的逐 profile 采样器，loadProfiles（strict=false，
// 迁移容忍）与 HTTP /add 写路径（strict=true，写拒绝）共用。它用字段专属
// 采样器规范化每个字段，返回 `{ clean, warnings }`：
//   - clean    — 净化后的 profile，剔除被拒字段。
//   - warnings — `{ field, reason }` 数组（reason 为中文）。只有拒绝/超限
//                条件落到这里；静默规范化（如 description 换行压平、toolFilter
//                去重）不产生警告，调用方可把非空 warnings 当作「本次写入会
//                丢数据」。

// persona 长度上限。建议值 2048，待实测。上限作用于**注入的** persona 文本，
// 即引导前缀 + 原文。
export const PERSONA_MAX_CHARS = 2048;

// persona 以影子 section 注入；前缀引导标记显式声明其非权威性质（双防线）。
// 仅用于写入校验与提示。
export const GUIDANCE_PREFIX = '[guidance, not authority] ';

// 共享委派上限——sanitizeProfile 与 lib/core/cost-guard.mjs 的 cost guard
// （硬上限恒开）的唯一事实来源。
export const MAX_TOKENS = 65536;
export const MAX_DEPTH = 3;

// --- cost guard 硬上限 --------------------------------------------------------
// assertHardLimits 是恒开的预算上限检查，与 `llm` 服务无关：maxTokens /
// maxDepth 是硬性委派上限，llm 缺失时绝不能静默停止生效。
// 超限 throw（中文、可操作），与 sanitizeProfile 共用同一组常量。非数字/未设值
// 不触发（sanitizeProfile 已在写路径拒绝非数字，这里仅兜底运行时竞态）。
export function assertHardLimits(maxTokens, maxDepth) {
  if (typeof maxTokens === 'number' && maxTokens > MAX_TOKENS) {
    throw new Error(`dispatch: maxTokens ${maxTokens} 超过委派上限 ${MAX_TOKENS}`);
  }
  if (typeof maxDepth === 'number' && maxDepth > MAX_DEPTH) {
    throw new Error(`dispatch: maxDepth ${maxDepth} 超过委派上限 ${MAX_DEPTH}`);
  }
}

// --- continuable 工具门闭集 ---------------------------------------------------
// computeContinuableAllow 预计算 continuable 派发路径的**闭合**工具 `allow` 集：
// 父工具集 − run_code − (toolFilter.deny)，存在 toolFilter.allow 时再 ∩ allow。
// 空集 fail-loud（throw）——绝不静默派发零工具。
//
// 代码编辑者注意：这里写代码注释的「假设 / 失效条件」必须与 dispatch-tool.mjs
// continuable 分支的注释保持一致（要求写入代码注释与 README）。
export function computeContinuableAllow(parentNames, toolFilter = {}) {
  const parent = new Set(parentNames);
  parent.delete('run_code');
  // deny 与 allow 对称守卫：非数组（如恶意/异常输入）按「无 deny」处理，防抛裸
  // TypeError；allow 同理在下方用 Array.isArray 守卫。
  const deny = Array.isArray(toolFilter?.deny) ? toolFilter.deny : [];
  for (const name of deny) parent.delete(name);
  let result = [...parent];
  const allow = toolFilter?.allow;
  if (Array.isArray(allow)) {
    const allowSet = new Set(allow);
    result = result.filter((name) => allowSet.has(name));
  }
  // 空集 fail-loud：派发一个零工具子 Agent 是静默降级，必须拒绝。
  if (result.length === 0) {
    throw new Error('dispatch: continuable 工具集为空，拒绝派发');
  }
  return result;
}

// description/name 采样器：`\n→空格` 压平。这些是显示行（dispatch:profiles
// section 把它们插进单行），换行会破坏该行。压平仅作存储层；引号包裹由显示层
// 负责——显示层在该行给 description 加引号（空时显示 '(无描述)' 不套引号），
// 本纯函数只保证存储值是单行、无换行。
function sanitizeShortText(value) {
  return value.replace(/\r\n|\r|\n/g, ' ');
}

// --- sanitizeProfile 各字段采样器（从 sanitizeProfile 拆出；行为逐字不变，
// 共用 clean/warnings 两个累加对象）--------------------------------------------

// name/description：null / '' 是「清除字段」哨兵（/add merge 层处理），原样透传
// 不告警；其它非字符串（number/object/array）拒绝。
function sanitizeTextField(key, value, clean, warnings) {
  if (value === undefined) return;
  if (value === null || value === '') { clean[key] = value; return; }
  if (typeof value !== 'string') {
    warnings.push({ field: key, reason: `${key} 必须为字符串` });
    return;
  }
  clean[key] = sanitizeShortText(value);
}

// persona：计入引导前缀后的长度上限（strict 决定拒绝写入还是保留原值）。
function sanitizePersonaField(value, clean, warnings, strict) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    warnings.push({ field: 'persona', reason: 'persona 必须为字符串' });
    return;
  }
  const wrappedLength = value.length === 0 ? 0 : GUIDANCE_PREFIX.length + value.length;
  if (wrappedLength > PERSONA_MAX_CHARS) {
    if (strict) {
      warnings.push({
        field: 'persona',
        reason: `persona 超长：计入引导前缀 '${GUIDANCE_PREFIX.trim()}' 后 ${wrappedLength} 字符，超过上限 ${PERSONA_MAX_CHARS}，拒绝写入`,
      });
      return;
    }
    warnings.push({
      field: 'persona',
      reason: `persona 超长：计入引导前缀 '${GUIDANCE_PREFIX.trim()}' 后 ${wrappedLength} 字符，超过上限 ${PERSONA_MAX_CHARS}；保留原值（不截断），建议人工精简`,
    });
    clean.persona = value;
    return;
  }
  clean.persona = value;
}

// maxTokens/maxDepth：有限数字 + 硬上限（MAX_TOKENS/MAX_DEPTH 由调用方注入）。
function sanitizeNumericField(key, value, clean, warnings, max) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push({ field: key, reason: `${key} 必须为有限数字` });
    return;
  }
  if (value > max) {
    warnings.push({ field: key, reason: `${key} ${value} 超过上限 ${max}` });
    return;
  }
  clean[key] = value;
}

// toolFilter：allow/deny 去重、丢弃空字符串；非法子字段按字段粒度移除。未知键
// 忽略；空（或全非法）的 toolFilter 直接不写入 clean（与 /add 写路径镜像）。
function sanitizeToolFilterField(value, clean, warnings) {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push({ field: 'toolFilter', reason: 'toolFilter 必须为对象' });
    return;
  }
  const tf = {};
  for (const op of ['allow', 'deny']) {
    const sub = value[op];
    if (sub === undefined) continue;
    if (!Array.isArray(sub) || !sub.every((s) => typeof s === 'string')) {
      warnings.push({ field: `toolFilter.${op}`, reason: `toolFilter.${op} 必须为字符串数组` });
      continue;
    }
    const deduped = [...new Set(sub.filter((s) => s.length > 0))];
    if (deduped.length > 0) tf[op] = deduped;
  }
  // 未知 toolFilter 键忽略；空（或全非法）toolFilter 直接从 clean 省略
  // （与 /add 写路径一致）。
  if (Object.keys(tf).length > 0) clean.toolFilter = tf;
}

// tokenTier：成本/深度分层（cheap/balanced/premium），供目录排序与结果卡
// 展示分层。合法值透传；非法值剔除 + warn（与 maxTokens 等超限字段同口径——
// 剔除而非回填缺省值）。缺省 'balanced' 在 sanitizeProfile 末尾按「字段未提供」
// 单独回填，非法值不受该回填影响。
const TOKEN_TIERS = new Set(['cheap', 'balanced', 'premium']);
function sanitizeTokenTierField(value, clean, warnings) {
  if (typeof value !== 'string' || !TOKEN_TIERS.has(value)) {
    warnings.push({ field: 'tokenTier', reason: 'tokenTier 必须为 cheap/balanced/premium 之一' });
    return;
  }
  clean.tokenTier = value;
}

// --- 结果回收默认剪枝 ----------------------------------------------------------
// 子结果默认复用宿主 `toolResultPruner.pruneContent` 预剪（纯函数、零 LLM），
// 在 `textFrom` 之前执行，把回灌进父上下文的体积压到阈值内。
//
// 阈值常量：head / tail / minKeep 是**子级**预期裁剪口径（比 agent.cordis.yml
// 现行 compaction-basic 的 4096/1024 更保守）。宿主
// toolResultPruner.pruneContent(blocks) 只接收 blocks，自身读取其配置
// （thresholdChars/headChars/tailChars），因此这三个常量当前**不会**作为实参
// 传给宿主 pruner；它们记录本条目的子级口径，并保留给后续「信封 / 精修
// 剪枝」路径使用。改动前先实测真实分布再校准（当前子输出样本不足，待积累）。
export const PRUNE_HEAD_CHARS = 2048;
export const PRUNE_TAIL_CHARS = 1024;
export const PRUNE_MIN_KEEP = 128;

// 对单个子 Agent 结果的内容块应用宿主剪枝。
//   - `blocks` — result.output 内容块（或 undefined；非数组）。
//   - `pruner` — `toolResultPruner` 服务，或 undefined。
// 返回（可能被剪的）块，或空数组占位。pruner 缺失（无压缩插件的无头部署）
// 或内容非数组时回退为不剪——剪枝是增强，绝非硬依赖。
// 宿主 pruner 在异常内容形状上抛错也回退为完整输出，因为自动剪枝绝不允许
// 吞掉合法的子结果。
export function pruneBlocks(blocks, pruner) {
  if (Array.isArray(blocks) && pruner !== undefined && typeof pruner.pruneContent === 'function') {
    try {
      const pruned = pruner.pruneContent(blocks);
      return pruned ?? blocks;
    } catch {
      return blocks;
    }
  }
  return Array.isArray(blocks) ? blocks : [];
}

// --- 输出回灌信任标注 ----------------------------------------------------------
// trustLabel 给 completed 子结果的回收文本加结构化信任标注前缀，让父上下文
// 不把子 Agent 输出误当高信任指令（正文先见标注、再见子输出）。profile/preset
// 与 buildMeta 同源字段；preset 为 'inherit'（子继承父预设、无换用）或字段缺失
// 时省略该段。前缀只含这两个元数据标识符，绝不携带 prompt/persona 原文。
function trustFields(meta) {
  const m = meta !== null && meta !== undefined && typeof meta === 'object' ? meta : {};
  const fields = [];
  if (typeof m.profile === 'string' && m.profile !== '') fields.push(['profile', m.profile]);
  if (typeof m.preset === 'string' && m.preset !== '' && m.preset !== 'inherit') fields.push(['preset', m.preset]);
  return fields;
}

// 模型可见的标注前缀：进回收 output 文本（render 行首部格式不变，前缀在 output 内部）。
export function trustLabel(meta) {
  const fields = trustFields(meta);
  return fields.length === 0
    ? '[dispatch:trusted-output]'
    : `[dispatch:trusted-output] ${fields.map(([key, value]) => `${key}=${value}`).join(' ')}`;
}

// 审计记录：与 trustLabel 同字段集的 JSON，只进 logger、不进结果字符串，无子输出
// 原文。调用方拼 `[dsh-subagent-profile] trusted-output: ` 前缀后以 info 记录。
export function trustAudit(meta) {
  return JSON.stringify(Object.fromEntries(trustFields(meta)));
}

// --- 派发 label 去敏 ----------------------------------------------------------
// dispatchLabel 生成子会话标题/任务卡 label：只含结构化段（profile/preset/model）
// 加 prompt 的 sha1 前 8 位十六进制哈希，绝不落 prompt 原文前缀。哈希让排障时
// 不同任务可辨识（不同 prompt → 不同哈希），却不泄漏任何前缀内容。profile 缺失
// 时回退 '(inline)'；preset 缺失或为 'inherit'（子继承父预设、无换用）时省略该
// 段；model 缺失时省略该段——与 buildMeta/trustFields 的字段口径一致。
export function dispatchLabel(args, merged) {
  const a = args !== null && typeof args === 'object' ? args : {};
  const m = merged !== null && typeof merged === 'object' ? merged : {};
  const profile = typeof a.profile === 'string' && a.profile !== '' ? a.profile : '(inline)';
  const promptText = String(a.prompt ?? '');
  const hash = createHash('sha1').update(promptText, 'utf8').digest('hex').slice(0, 8);
  const segments = [`dispatch:${profile}`];
  if (typeof m.preset === 'string' && m.preset !== '' && m.preset !== 'inherit') segments.push(m.preset);
  if (typeof m.model === 'string' && m.model !== '') segments.push(m.model);
  segments.push(`#${hash}`);
  return segments.join(' ');
}

// --- continuable 可见性修复 ----------------------------------------------------
// 共享一致性规则：三个 closed `output.schema.oneOf` 分支
// (background / continuable / foreground) 在新增结果元数据字段时必须携带
// **相同**的共享元数据键集——`ignored`、`reasoningEffort`、
// `profile/preset/provider/model` 必须出现在全部三个分支，使模型侧 schema
// 不会拒绝「忘了」该字段的分支。
//
// 判据：元数据集合 = 每个分支 properties 的键集，**剔除**各分支自有的判别键
// （`kind`/`jobId`/`subagentId`/`output`——background/continuable/foreground 各自
// 的判别字段不同，不纳入一致性比较）。剩下必须是三者的公共元数据集合，三处
// 逐一对齐；任一分支缺漏/多余公共元数据键即 throw（中文、指明一致性规则）。
const RESULT_SCHEMA_DISCRIMINATOR_KEYS = new Set(['kind', 'jobId', 'subagentId', 'output']);

export function assertResultSchemaConsistency(schema) {
  if (!schema || typeof schema !== 'object') {
    throw new Error('dispatch: 结果 schema 必须为对象（R1 closed oneOf）');
  }
  const branches = schema.oneOf;
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error('dispatch: 结果 schema 必须包含非空 oneOf 分支');
  }
  const metaSets = branches.map((branch, index) => {
    if (!branch || typeof branch !== 'object' || branch.properties === null || typeof branch.properties !== 'object') {
      throw new Error(`dispatch: 结果 schema oneOf 分支 ${index + 1} 缺少 properties 对象`);
    }
    return new Set(
      Object.keys(branch.properties).filter((key) => !RESULT_SCHEMA_DISCRIMINATOR_KEYS.has(key))
    );
  });
  const ref = metaSets[0];
  for (let i = 1; i < metaSets.length; i++) {
    const current = metaSets[i];
    const same = current.size === ref.size && [...ref].every((key) => current.has(key));
    if (!same) {
      throw new Error(
        `dispatch: 结果 schema oneOf 分支 ${i + 1} 的元数据字段集与分支 1 不一致（R1：凡向结果 meta 增字段须同步全三分支；期望 ${[...ref].join(', ')}，实际 ${[...current].join(', ')}）`
      );
    }
  }
  return true;
}

// profile 上可能存在的完整字段集。任何其它键——包括 __proto__ / constructor /
// prototype（JSON.parse 可以产出为 OWN 属性）——一律丢弃而不复制，赋值永远
// 不会走进对象原型链（原型污染防护）。
const KNOWN_PROFILE_FIELDS = new Set([
  'id', 'name', 'description', 'persona', 'preset', 'provider', 'model',
  'reasoningEffort', 'enabled', 'maxTokens', 'maxDepth', 'toolFilter',
  'tokenTier', 'builtin', 'deleted',
]);

/**
 * 净化一条 profile。`options.strict`：
 *   - strict=false（迁移读取）：超长 persona 保留（不截断）并告警；超限
 *     maxTokens/maxDepth 与非法 toolFilter 子字段丢弃（字段移除）+ 告警。
 *   - strict=true（写路径）：超长 persona 也从 clean 移除并告警，调用方可
 *     用 400 拒绝整次写入。
 * 非拒绝型规范化（description/name 压平、toolFilter 去重）静默进行，绝不告警。
 *
 * 安全：`clean` 是 `Object.create(null)`（无继承的 `__proto__` setter），且只
 * 复制白名单字段，敌意的 `__proto__` / `constructor` / `prototype` 键被忽略而
 * 不会污染结果。
 */
export function sanitizeProfile(profile, options = {}) {
  const { strict = false } = options;
  const clean = Object.create(null);
  const warnings = [];
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    return { clean, warnings: [{ field: '(root)', reason: 'profile 不是对象' }] };
  }
  let tokenTierProvided = false;
  for (const [key, value] of Object.entries(profile)) {
    if (!KNOWN_PROFILE_FIELDS.has(key)) {
      warnings.push({ field: key, reason: '未知字段已忽略' });
      continue;
    }
    switch (key) {
      case 'id':
      case 'preset':
      case 'name':
      case 'description':
        // id/preset 与 name/description 同走文本采样：压平换行，阻断经 \n 注入
        // orchestrator-v2 systemPrompt 的提示注入面（H1）。id/preset 此前走 default
        // 分支原样拷贝，可注入换行破坏 dispatch:profiles 行。
        sanitizeTextField(key, value, clean, warnings);
        break;
      case 'persona':
        sanitizePersonaField(value, clean, warnings, strict);
        break;
      case 'maxTokens':
        sanitizeNumericField(key, value, clean, warnings, MAX_TOKENS);
        break;
      case 'maxDepth':
        sanitizeNumericField(key, value, clean, warnings, MAX_DEPTH);
        break;
      case 'toolFilter':
        sanitizeToolFilterField(value, clean, warnings);
        break;
      case 'tokenTier':
        tokenTierProvided = true;
        sanitizeTokenTierField(value, clean, warnings);
        break;
      default:
        clean[key] = value;
        break;
    }
  }
  // tokenTier 缺省 'balanced'：仅当字段未被提供时回填；被提供的非法值已在
  // sanitizeTokenTierField 剔除（clean 保持无该键），不会被此回填覆盖。
  if (!tokenTierProvided) clean.tokenTier = 'balanced';
  return { clean, warnings };
}

// --- tokenTier 目录排序 ---------------------------------------------------------
// tokenTier 排序权重：cheap→balanced→premium。dispatch:profiles 目录行按此
// 升序排列（省 token 方案在前）。缺省/未知 tier 按 balanced 处理，保证旧数据
// 与无 tokenTier 字段的 profile 落到中间档而非报错。
export const TIER_ORDER = { cheap: 0, balanced: 1, premium: 2 };
export function tierSortKey(tokenTier) {
  const order = TIER_ORDER[tokenTier];
  return order === undefined ? TIER_ORDER.balanced : order;
}
