// lib/core/catalog-cache.mjs — 进程级共享 catalog 快照：一次拉取 llm 目录
// （providers + 每 provider 的 models + 每模型 reasoning-effort 等级）、
// system-trust 预设名册与完整工具目录，按 TTL 缓存后同时喂给设置页 /options
// 三路由与 dispatch 的 cost guard。TTL 过期自动重拉；同 key 在途 Promise 去重；
// /options/refresh 手动清缓存兜底。
//
// 依赖边界（无 @deepseek-ai 依赖）：仅 import 纯数据表
// lib/core/catalog.mjs（工具名 → 中文/分类，零依赖）。服务经注入 getter 传入：
//   getLlm          () => ctx.get('llm')           （headless 下可为 undefined）
//   getAgentPresets  () => ctx.get('agentPresets')
//   getTools         () => ctx.tools
// cost guard 校验的是「父 Agent 的 llm 实例」；同一进程内父 ctx 与插件 ctx 读到的
// 是同一个 host llm 服务，故 getSnapshot 接受可选 llm 覆盖（父实例）时仍命中同一条目。
//
// 缓存只提速目录解析，不复检安全门：provider/model/reasoningEffort 的校验逻辑与
// fail-loud 文案留在 lib/core/cost-guard.mjs（逐字不变），此处仅提供目录数据。

import { TOOL_ZH, TOOL_CATEGORY } from './catalog.mjs';

const DEFAULT_TTL_MS = 60000;

// --- 工具分组/中文名的薄覆盖层（schema 声明优先，缺失回退）------------------------
//
// 工具目录里每一条的 group（分类）与 zh（中文名）优先取工具 schema 自带声明字段，
// 其次才回退数据表/前缀/预设名。宿主 tools.schemas() 当前只投影 name/description/
// parameters（无 category/group/zh 字段）；此层在宿主未来为 schema 补上
// 分组/中文声明时自动优先采用，缺失时按既有回退链兜底——不新增任何硬编码条目。

// 读取 schema 声明的分组候选（可接受的字段名集合内部固定，非外部注入）。
function schemaDeclaredGroup(schema) {
  if (schema === null || typeof schema !== 'object') return undefined;
  if (typeof schema.category === 'string' && schema.category.length > 0) return schema.category;
  if (typeof schema.group === 'string' && schema.group.length > 0) return schema.group;
  return undefined;
}

// 读取 schema 声明的中文名候选（宿主有 zh/label 声明时优先）。
function schemaDeclaredZh(schema) {
  if (schema === null || typeof schema !== 'object') return undefined;
  if (typeof schema.zh === 'string' && schema.zh.length > 0) return schema.zh;
  if (typeof schema.label === 'string' && schema.label.length > 0) return schema.label;
  return undefined;
}

// core 层无数据表条目时的缺省分组。
const DEFAULT_CORE_GROUP = '其他';

// 工具的分组解析链：schema 声明 → 数据表（core）/ 前缀（plugin）/ 预设名（custom）。
// `source` 是工具来源（'global' 或 preset id），`layer` 为 layerOf(source)。
export function resolveToolCategory(schema, name, source, layer) {
  const declared = schemaDeclaredGroup(schema);
  if (declared !== undefined) return declared;
  if (layer === 'core') return TOOL_CATEGORY[name] ?? DEFAULT_CORE_GROUP;
  if (layer === 'plugin') return name.includes('_') ? name.split('_')[0] : name;
  return source;
}

// 工具中文名解析链：schema 声明 → 数据表 → 空串（沿用原缺省）。
export function resolveToolZh(schema, name) {
  const declared = schemaDeclaredZh(schema);
  if (declared !== undefined) return declared;
  return TOOL_ZH[name] ?? '';
}

// --- 目录构建（无缓存；行为与 http-routes 原 collector 逐字一致）----------------

// llm 目录：providers + 每 provider models + 每模型 efforts。listProviders 失败
// 记入 providersError（cost guard 据此判「目录为空」）；每 provider 的 listModels
// 失败单独记录——cost guard 需要区分「空目录短路」与「listModels 抛错」的 fail-loud 文案。
async function collectLlmDirectory(llm) {
  const models = [];
  const efforts = Object.create(null);
  const modelsByProvider = Object.create(null);
  if (llm === undefined || typeof llm.listProviders !== 'function') {
    return { providersError: undefined, providers: [], modelsByProvider, models, efforts };
  }
  let providers;
  let providersError;
  try {
    providers = (await llm.listProviders()) ?? [];
  } catch (error) {
    providersError = error instanceof Error ? error : new Error(String(error));
    return { providersError, providers: [], modelsByProvider, models, efforts };
  }
  for (const provider of providers) {
    const providerId = provider && provider.id;
    if (typeof providerId !== 'string') continue;
    let entry;
    try {
      const modelList = await llm.listModels(providerId);
      entry = { ok: true, models: modelList ?? [] };
    } catch (error) {
      entry = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
    modelsByProvider[providerId] = entry;
    if (entry.ok !== true) continue; // 该 provider 目录拉取失败 → 跳过其 UI 目录
    for (const model of entry.models) {
      if (!model || typeof model.id !== 'string') continue;
      models.push({ provider: providerId, providerName: provider.name ?? providerId, id: model.id, name: model.name ?? model.id });
      try {
        const info = await llm.resolveModelInfo(providerId, model.id);
        const effortsList = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : [];
        efforts[model.id] = effortsList.map((effort) => ({
          id: effort.id,
          name: effort.name ?? effort.id,
          ...(effort.description !== undefined ? { description: effort.description } : {})
        }));
      } catch { /* 精确模型查询可能拒绝；跳过其 efforts */ }
    }
  }
  return { providersError: undefined, providers, modelsByProvider, models, efforts };
}

// System-trust 预设名册（agentPresets 可选，fail-soft）。
async function collectSystemPresets(agentPresets) {
  const presets = [];
  if (agentPresets === undefined || typeof agentPresets.list !== 'function') return presets;
  try {
    const list = await agentPresets.list();
    for (const preset of (list ?? [])) {
      if (preset && preset.trust === 'system') {
        presets.push({ id: preset.id, name: preset.name ?? preset.id });
      }
    }
  } catch { /* presets roster unavailable; leave empty */ }
  return presets;
}

// 完整工具目录 = global 层（部署插件）+ 每个 preset 的 standing scope
// （agent.cordis.yml 工具行）。工具按其来源打标：'global' 或 preset id——分组完全
// 动态，源自运行时名册。整体失败 fail-soft（返回空目录 + 告警），不破坏设置页。
async function collectToolsDirectory(getTools, getAgentPresets, logger) {
  try {
    const tools = [];
    const seen = new Set();
    const OFFICIAL_PRESETS = ['standard', 'code', 'minimal', 'cordis'];
    const layerOf = (source) => {
      if (source === 'global') return 'plugin';
      if (OFFICIAL_PRESETS.includes(source)) return 'core';
      return 'custom';
    };
    const groupOf = (schema, name, source) => resolveToolCategory(schema, name, source, layerOf(source));
    const push = (schemas, source) => {
      for (const s of (Array.isArray(schemas) ? schemas : [])) {
        if (!s || typeof s.name !== 'string' || s.name === 'run_code' || seen.has(s.name)) continue;
        seen.add(s.name);
        tools.push({ name: s.name, description: typeof s.description === 'string' ? s.description : '', zh: resolveToolZh(s, s.name), source, layer: layerOf(source), group: groupOf(s, s.name, source) });
      }
    };
    const toolsService = typeof getTools === 'function' ? getTools() : undefined;
    if (toolsService && typeof toolsService.schemas === 'function') {
      push(toolsService.schemas(), 'global');
      const agentPresets = typeof getAgentPresets === 'function' ? getAgentPresets() : undefined;
      if (agentPresets !== undefined && typeof agentPresets.list === 'function' && typeof agentPresets.standingKeyFor === 'function') {
        const presets = await agentPresets.list();
        for (const preset of (presets ?? [])) {
          if (!preset || typeof preset.id !== 'string') continue;
          try {
            push(toolsService.schemas(await agentPresets.standingKeyFor(preset.id)), preset.id);
          } catch { /* 单个 preset 的 standing scope 不可用；跳过 */ }
        }
      }
    }
    return tools;
  } catch (error) {
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn('[dsh-subagent-profile] tools directory failed:', error instanceof Error ? error.message : String(error));
    }
    return [];
  }
}

// 构建一份完整快照（无缓存）。`llm` 可选：cost guard 用它传入父 Agent 的 llm 实例。
export async function getCatalogSnapshot({ getLlm, getAgentPresets, getTools, llm, logger }) {
  const effectiveLlm = llm !== undefined ? llm : (typeof getLlm === 'function' ? getLlm() : undefined);
  const agentPresets = typeof getAgentPresets === 'function' ? getAgentPresets() : undefined;
  const dir = await collectLlmDirectory(effectiveLlm);
  const presets = await collectSystemPresets(agentPresets);
  const tools = await collectToolsDirectory(getTools, getAgentPresets, logger);
  return {
    llm: { providersError: dir.providersError, providers: dir.providers, modelsByProvider: dir.modelsByProvider },
    models: dir.models,
    efforts: dir.efforts,
    presets,
    tools,
  };
}

// --- TTL 缓存（按 llm 实例分键；同 key 在途去重；hit/miss 计数走 host logger）----

const NO_LLM = Symbol('catalog-cache:no-llm');

function makeAudit(logger) {
  if (logger !== undefined && typeof logger.info === 'function') {
    return (outcome, hits, misses) => logger.info(`[dsh-subagent-profile] catalog cache ${outcome} (hit=${hits}, miss=${misses})`);
  }
  return () => {};
}

// 命中/未命中判定 + TTL 过期重拉；并发 cache-miss 复用同一条在途 Promise（只拉一次）。
async function resolveSnapshot(state, llm) {
  // 无参时按注入的 getLlm() 取 llm 实例作 key——保证 /options 侧（无参）与
  // cost guard 侧（传父实例）在同一 host llm 实例下命中同一条目。
  const effectiveLlm = llm !== undefined ? llm : (typeof state.getLlm === 'function' ? state.getLlm() : undefined);
  const key = effectiveLlm !== undefined ? effectiveLlm : NO_LLM;
  const at = state.clock();
  const entry = state.entries.get(key);
  if (entry !== undefined) {
    if (entry.snapshot !== undefined && entry.expiresAt > at) {
      state.hits += 1;
      state.audit('hit', state.hits, state.misses);
      return entry.snapshot;
    }
    if (entry.inflight !== undefined) {
      state.hits += 1;
      state.audit('hit', state.hits, state.misses);
      return entry.inflight;
    }
  }
  state.misses += 1;
  state.audit('miss', state.hits, state.misses);
  const inflight = getCatalogSnapshot({
    getLlm: state.getLlm,
    getAgentPresets: state.getAgentPresets,
    getTools: state.getTools,
    llm: effectiveLlm,
    logger: state.logger,
  });
  const fresh = { expiresAt: at + state.ttl, snapshot: undefined, inflight };
  state.entries.set(key, fresh);
  try {
    const snapshot = await inflight;
    fresh.snapshot = snapshot;
    fresh.inflight = undefined;
    // 目录错误态不缓存：providersError 意味着 listProviders 瞬时失败或目录为空，
    // 缓存会让瞬时故障自愈延迟一个 TTL；每次重试既保持安全门保守又恢复更快。
    if (snapshot.llm.providersError !== undefined) {
      state.entries.delete(key);
    }
    return snapshot;
  } catch (error) {
    fresh.inflight = undefined;
    state.entries.delete(key);
    throw error;
  }
}

function invalidateSnapshot(state, llm) {
  if (llm !== undefined) state.entries.delete(llm);
  else state.entries.clear();
}

// 工厂返回 { getSnapshot, invalidate, stats }。getSnapshot(llm?) 接受可选 llm 覆盖；
// 无参时走注入的 getLlm()。stats() 供审计/测试读取 hit/miss 计数。
export function createCatalogCache({ getLlm, getAgentPresets, getTools, logger, ttlMs, now }) {
  const state = {
    getLlm,
    getAgentPresets,
    getTools,
    logger,
    ttl: typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS,
    clock: typeof now === 'function' ? now : () => Date.now(),
    entries: new Map(),
    hits: 0,
    misses: 0,
    audit: makeAudit(logger),
  };
  return {
    getSnapshot: (llm) => resolveSnapshot(state, llm),
    invalidate: (llm) => invalidateSnapshot(state, llm),
    stats: () => ({ hits: state.hits, misses: state.misses }),
  };
}
