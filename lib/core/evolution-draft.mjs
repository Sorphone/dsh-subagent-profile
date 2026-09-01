// lib/core/evolution-draft.mjs — 进化建议 → 可应用候选资产的确定性生成器。
// 纯函数 + 数据注入（catalog 快照 / 白名单 / 已占用 id 集），零 LLM、零 fs、零新依赖：
// 同输入恒同输出，可裸 import 单测；只产出候选 config，落盘/审计由装配层负责。
// 推导规则（确定性）：
//   降：同 provider 单价更低且最接近的模型档 → 移除 persona/toolFilter 结构段 →
//       白名单内相邻低档预设；全无候选返回 null（不产空草稿）。
//   升：reasoningEffort 升一级（阶梯 off/low/medium/high/max，与派发档位同源）；
//       maxTokens ×2 封顶硬上限；无具体预算值返回 null。平 → null。
// 隐私：不引入 prompt/persona 原文；config 只含字段与值，basis 只含摘要文本。

import { createHash } from 'node:crypto';
import { MAX_TOKENS, sanitizeProfile } from './pure.mjs';
import { avgCostFor } from './prices.mjs';

// 推理档位阶梯：升档「升一级」的口径与派发工具档位同源；未知档位不升（保守）。
export const EFFORT_LADDER = ['off', 'low', 'medium', 'high', 'max'];

const ID_MAX_LEN = 32;
const ID_RETRY_MAX = 5;
const NAME_MAX_CHARS = 20;

// profileKey 轴段解析（evolution-summary 的 L1 身份键口径）：
// preset:<名> / provider:<名> / model:<名> / persona:1 / toolFilter:1。
function parseProfileKey(profileKey) {
  const parsed = { preset: null, provider: null, model: null, persona: false, toolFilter: false };
  const text = typeof profileKey === 'string' ? profileKey : '';
  for (const part of text.split('|')) {
    if (part.startsWith('preset:')) parsed.preset = part.slice('preset:'.length);
    else if (part.startsWith('provider:')) parsed.provider = part.slice('provider:'.length);
    else if (part.startsWith('model:')) parsed.model = part.slice('model:'.length);
    else if (part === 'persona:1') parsed.persona = true;
    else if (part === 'toolFilter:1') parsed.toolFilter = true;
  }
  return parsed;
}

// 身份摘要：只保留小写字母/数字/连字符，供候选 id 使用（sanitize 友好）。
function lowerHyphen(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

// 候选 id 基名：evo-<方向>-<身份摘要>，总长 ≤32。摘要在长键时截断。
function baseDraftId(direction, profileKey) {
  const slug = lowerHyphen(profileKey).slice(0, 24) || 'inline';
  return `evo-${direction}-${slug}`.slice(0, ID_MAX_LEN);
}

// id 冲突重试：与已占用 id（profiles + 资产）冲突时追加 -2、-3……（≤5 次），
// 仍冲突返回 null（装配层放弃生成，不产出会撞名的候选）。
export function nextDraftId(direction, profileKey, taken) {
  const ids = taken instanceof Set ? taken : new Set(Array.isArray(taken) ? taken : []);
  const base = baseDraftId(direction, profileKey);
  if (!ids.has(base)) return base;
  for (let i = 2; i <= ID_RETRY_MAX + 1; i += 1) {
    const candidate = `${base}-${i}`.slice(0, ID_MAX_LEN);
    if (!ids.has(candidate)) return candidate;
  }
  return null;
}

// 同 provider 单价更低且最接近的模型档。当前模型无单价或同 provider 无更低档时
// 返回 null（调用方跳过该步，走更保守的降档策略）。
function modelDowngrade(modelName, providerName, models) {
  if (typeof modelName !== 'string' || modelName === '') return null;
  const currentCost = avgCostFor(modelName);
  if (currentCost === undefined) return null;
  const list = Array.isArray(models) ? models : [];
  let provider = providerName;
  if (provider === null || provider === '') {
    const current = list.find((m) => m && m.id === modelName);
    provider = current !== undefined && typeof current.provider === 'string' ? current.provider : null;
  }
  if (provider === null) return null;
  const candidates = list
    .filter((m) => m && typeof m.id === 'string' && m.id !== modelName && m.provider === provider)
    .map((m) => ({ id: m.id, provider: m.provider, cost: avgCostFor(m.id) }))
    .filter((m) => m.cost !== undefined && m.cost < currentCost)
    .sort((a, b) => b.cost - a.cost);
  const pick = candidates[0];
  return pick === undefined ? null : { provider: pick.provider, model: pick.id };
}

// 同 L1 身份键下的预算轴当前值（从 L2 键反查）：maxTokens 取组内最大值，
// reasoningEffort 取组内阶梯最高档。
function higherEffort(a, b) {
  const ia = a === null ? -1 : EFFORT_LADDER.indexOf(a);
  const ib = b === null ? -1 : EFFORT_LADDER.indexOf(b);
  return ib > ia ? b : a;
}

function budgetFromL2(profileKey, l2) {
  const source = l2 !== null && typeof l2 === 'object' ? l2 : {};
  let maxTokens = null;
  let effort = null;
  for (const [axisKey] of Object.entries(source)) {
    if (typeof axisKey !== 'string') continue;
    const tokensPrefix = `${profileKey}:maxTokens:`;
    if (axisKey.startsWith(tokensPrefix)) {
      const value = Number(axisKey.slice(tokensPrefix.length));
      if (Number.isFinite(value) && value > 0) maxTokens = maxTokens === null ? value : Math.max(maxTokens, value);
      continue;
    }
    const effortPrefix = `${profileKey}:reasoningEffort:`;
    if (axisKey.startsWith(effortPrefix)) effort = higherEffort(effort, axisKey.slice(effortPrefix.length));
  }
  return { maxTokens, reasoningEffort: effort };
}

// 变更前配置（审计 from 口径）：能力轴取值来自身份键，预算轴取值反查 L2。
export function sourceConfigFromKey(profileKey, l2) {
  const parsed = parseProfileKey(profileKey);
  const budget = budgetFromL2(profileKey, l2);
  const config = {};
  if (parsed.preset !== null) config.preset = parsed.preset;
  if (parsed.provider !== null) config.provider = parsed.provider;
  if (parsed.model !== null) config.model = parsed.model;
  if (parsed.persona) config.persona_present = true;
  if (parsed.toolFilter) config.toolFilter_present = true;
  if (budget.reasoningEffort !== null) config.reasoningEffort = budget.reasoningEffort;
  if (budget.maxTokens !== null) config.maxTokens = budget.maxTokens;
  return config;
}

// 降档候选（能力轴只降）：按「模型降档 → 结构移除 → 预设降档」优先级取第一个
// 可行动作；全无候选返回 null。
function downCandidate(parsed, models, whitelist, presets) {
  if (parsed.model !== null) {
    const downgraded = modelDowngrade(parsed.model, parsed.provider, models);
    if (downgraded !== null) {
      const config = { provider: downgraded.provider, model: downgraded.model };
      if (parsed.preset !== null) config.preset = parsed.preset;
      return config;
    }
  }
  // 结构降档：移除 persona/toolFilter（比降模型保守），保留键内其余能力字段。
  if (parsed.persona || parsed.toolFilter) {
    const config = {};
    if (parsed.preset !== null) config.preset = parsed.preset;
    if (parsed.provider !== null) config.provider = parsed.provider;
    if (parsed.model !== null) config.model = parsed.model;
    return config;
  }
  // 预设降档：名册内当前预设的相邻低档，且必须在白名单内；不叠加逃生舱放行集。
  if (parsed.preset !== null) {
    const roster = Array.isArray(presets) ? presets : [];
    const index = roster.findIndex((p) => p && p.id === parsed.preset);
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = roster[i];
      if (candidate === null || candidate === undefined || typeof candidate.id !== 'string' || candidate.id === '') continue;
      const allowed = whitelist instanceof Set ? whitelist.has(candidate.id) : Array.isArray(whitelist) && whitelist.includes(candidate.id);
      if (allowed) return { preset: candidate.id };
    }
  }
  return null;
}

// 升档候选（预算轴）：reasoningEffort 升一级优先；无档可升时 maxTokens ×2
// （封顶硬上限）；两者都无变化返回 null。
function budgetUpgrade(fromConfig) {
  if (typeof fromConfig.reasoningEffort === 'string' && fromConfig.reasoningEffort !== '') {
    const index = EFFORT_LADDER.indexOf(fromConfig.reasoningEffort);
    if (index >= 0 && index < EFFORT_LADDER.length - 1) {
      return { reasoningEffort: EFFORT_LADDER[index + 1] };
    }
  }
  if (typeof fromConfig.maxTokens === 'number' && fromConfig.maxTokens > 0) {
    const capped = Math.min(fromConfig.maxTokens * 2, MAX_TOKENS);
    if (capped > fromConfig.maxTokens) return { maxTokens: capped };
  }
  return null;
}

// 候选经 sanitizeProfile（strict）校验；有警告即返回 null（生成器输入受控，
// 此分支只防御未来 schema 变更）。
function validDraftOrNull(config, name, description) {
  const { clean, warnings } = sanitizeProfile({ ...config, name, description }, { strict: true });
  if (warnings.length > 0) return null;
  return clean;
}

// 组装一条候选：{ config, name, description, basis } 或 null。
// config 含 id（必填非空）+ 能力/预算字段；name/description 供 UI 展示；
// basis 供「为什么生成」展示（只含摘要，无原文）。
export function buildEvolutionDraft({ advice, l1Entry, l2, snapshot, whitelist, takenIds, now = Date.now() } = {}) {
  const a = advice !== null && typeof advice === 'object' ? advice : {};
  const key = typeof a.profileKey === 'string' ? a.profileKey : '';
  const suggestion = a.suggestion;
  if (suggestion !== '降' && suggestion !== '升') return null;
  const entry = l1Entry !== null && typeof l1Entry === 'object' ? l1Entry : {};
  const snap = snapshot !== null && typeof snapshot === 'object' ? snapshot : {};
  const from = sourceConfigFromKey(key, l2);
  const config = suggestion === '降'
    ? downCandidate(parseProfileKey(key), snap.models, whitelist, snap.presets)
    : budgetUpgrade(from);
  if (config === null) return null;
  const direction = suggestion === '降' ? 'down' : 'up';
  const id = nextDraftId(direction, key, takenIds);
  if (id === null) return null;
  const name = `进化草稿-${key.length > NAME_MAX_CHARS ? key.slice(0, NAME_MAX_CHARS) + '…' : key}`;
  const directionText = suggestion === '降' ? '降级能力配置' : '上调预算';
  const description = `${a.performanceText ?? ''}；建议：${directionText}`;
  const clean = validDraftOrNull({ ...config, id }, name, description);
  if (clean === null) return null;
  const configClean = { ...clean };
  delete configClean.name;
  delete configClean.description;
  return {
    config: configClean,
    name,
    description,
    basis: {
      profileKey: key,
      suggestion,
      confidence: a.confidence ?? entry.confidence?.level ?? '',
      score: entry.score?.weighted_success ?? 0,
      n: entry.confidence?.n ?? 0,
      performanceText: a.performanceText ?? '',
      generatedAt: now,
    },
  };
}

// 对象键排序归一（供指纹输入稳定化）。
function canonicalEntry(entry) {
  if (entry === null || typeof entry !== 'object') return entry;
  const out = {};
  for (const key of Object.keys(entry).sort()) out[key] = entry[key];
  return out;
}

// 候选携带的「生成时刻 profile 指纹」：身份键 + 变更前配置 + 匹配该身份键的
// 注册表方案（排序归一后哈希）。人工编辑方案或聚合数据变化都会使指纹失配，
// 装配层据此拒绝应用（不静默应用过期候选）。
export function profileFingerprint({ profileKey, from, registryEntries = [] } = {}) {
  const entries = Array.isArray(registryEntries) ? registryEntries : [];
  const sorted = entries
    .map(canonicalEntry)
    .sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
  const payload = JSON.stringify({ profileKey, from: canonicalEntry(from), registry: sorted });
  return createHash('sha1').update(payload, 'utf8').digest('hex');
}
