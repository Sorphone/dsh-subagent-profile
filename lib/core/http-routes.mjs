// lib/core/http-routes.mjs — settings HTTP loopback routes for the Client UI,
// moved verbatim from index.mjs's `ctx.inject(['webServer'], (scope) => {...})`
// block. Local lib references only: sanitizeProfile from
// lib/core/pure.mjs, TOOL_ZH/TOOL_CATEGORY from lib/core/catalog.mjs, BUILTIN_SEEDS from
// lib/core/profiles-store.mjs; no @deepseek-ai dependency.
//
// Injection: every apply-closure / ctx dependency is an explicit parameter —
//   store         the profile store (profiles Map / persistProfiles /
//                 persistEnabled / deletedBuiltins),
//   getEnabled    reads the apply-closure `enabled` flag (mutated by
//                 /set-enabled),
//   setEnabled    writes it,
//   syncTool      unregisters/registers the dispatch tool on /set-enabled,
//   getLlm / getAgentPresets / getTools
//                 request-time service getters (ctx.get('llm') etc. are read
//                 per request, never at apply time),
//   logger        ctx.logger (route error / tools-directory warnings).
// The factory returns the scope.effect setup function so the caller keeps the
// exact original registration shape: effect(() => register + disposer).
//
// 8 条路由各抽为模块级处理函数（if 链分发保持）；/options 的目录构建抽
// collectModelDirectory / collectSystemPresets / collectToolsDirectory。
// 行为逐字不变（错误文案/状态码/schema）。

import { sanitizeProfile } from './pure.mjs';
import { TOOL_ZH, TOOL_CATEGORY } from './catalog.mjs';
import { BUILTIN_SEEDS } from './profiles-store.mjs';

// Only the loopback interfaces may drive the settings HTTP routes.
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1 << 20) { reject(new Error('请求体过大')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data === '' ? {} : JSON.parse(data)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// Write-failure contract: the write routes return HTTP 200 with
// `persisted` always present; when the disk write failed, persistWarning
// explains "已保存但未持久化" (in-memory state drives this process, the
// disk did not update). The client renders that as the amber warning.
function persistOk(res, payload, persist) {
  return json(res, 200, {
    ok: true,
    ...payload,
    persisted: persist.persisted,
    ...(persist.persisted ? {} : { persistWarning: '已保存但未持久化' }),
  });
}

function listClean(store) {
  return [...store.profiles.values()].map((profile) => {
    const clean = {};
    for (const [key, value] of Object.entries(profile)) if (value !== undefined && key !== 'persisted') clean[key] = value;
    // The internal `persisted` flag is stripped above; expose a UI-facing
    // "modified" signal so the reset panel can label a changed builtin.
    if (profile.builtin === true && profile.persisted === true) clean.modified = true;
    return clean;
  });
}

// --- 路由处理函数（从 createHttpRoutes 拆出；if 链分发在内保持）----------------

async function handleList(deps, res) {
  return json(res, 200, { ok: true, profiles: listClean(deps.store) });
}

// /options 的模型目录 + 每模型 reasoning-effort 等级（llm 可选，失败仅清空）。
async function collectModelDirectory(llm) {
  const models = [];
  const efforts = {};
  const providers = await llm.listProviders();
  for (const provider of (providers ?? [])) {
    const providerId = provider && provider.id;
    if (typeof providerId !== 'string') continue;
    let modelList = [];
    try { modelList = await llm.listModels(providerId); } catch { /* skip this provider's catalog */ }
    for (const model of (modelList ?? [])) {
      if (!model || typeof model.id !== 'string') continue;
      models.push({
        provider: providerId,
        providerName: provider.name ?? providerId,
        id: model.id,
        name: model.name ?? model.id
      });
      try {
        const info = await llm.resolveModelInfo(providerId, model.id);
        const effortsList = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : [];
        efforts[model.id] = effortsList.map((effort) => ({
          id: effort.id,
          name: effort.name ?? effort.id,
          ...(effort.description !== undefined ? { description: effort.description } : {})
        }));
      } catch { /* exact-model lookup may reject; skip its efforts */ }
    }
  }
  return { models, efforts };
}

// System-trust presets（agentPresets 可选，fail-soft）。
async function collectSystemPresets(agentPresets) {
  const presets = [];
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

// Full tool directory = global layer (deployment plugins) + every preset's
// standing scope (the agent.cordis.yml tool rows). Each tool is tagged with
// its source: 'global' or the preset id — the grouping is fully dynamic,
// derived from the runtime's preset roster.
async function collectToolsDirectory(getTools, getAgentPresets) {
  const tools = [];
  const seen = new Set();
  const OFFICIAL_PRESETS = ['standard', 'code', 'minimal', 'cordis'];
  const layerOf = (source) => {
    if (source === 'global') return 'plugin';
    if (OFFICIAL_PRESETS.includes(source)) return 'core';
    return 'custom';
  };
  const groupOf = (name, source) => {
    const layer = layerOf(source);
    if (layer === 'core') return TOOL_CATEGORY[name] ?? '其他';
    if (layer === 'plugin') return name.includes('_') ? name.split('_')[0] : name;
    return source;
  };
  const push = (schemas, source) => {
    for (const s of (Array.isArray(schemas) ? schemas : [])) {
      if (!s || typeof s.name !== 'string' || s.name === 'run_code' || seen.has(s.name)) continue;
      seen.add(s.name);
      tools.push({ name: s.name, description: typeof s.description === 'string' ? s.description : '', zh: TOOL_ZH[s.name] ?? '', source, layer: layerOf(source), group: groupOf(s.name, source) });
    }
  };
  const toolsService = getTools();
  if (toolsService && typeof toolsService.schemas === 'function') {
    push(toolsService.schemas(), 'global');
    const agentPresets = getAgentPresets();
    if (agentPresets !== undefined && typeof agentPresets.list === 'function' && typeof agentPresets.standingKeyFor === 'function') {
      const presets = await agentPresets.list();
      for (const preset of (presets ?? [])) {
        if (!preset || typeof preset.id !== 'string') continue;
        try {
          push(toolsService.schemas(await agentPresets.standingKeyFor(preset.id)), preset.id);
        } catch { /* one preset's standing scope unavailable; skip */ }
      }
    }
  }
  return tools;
}

async function handleOptions(deps, res) {
  const models = [];
  const efforts = {};
  const presets = [];
  // Model directory + per-model reasoning-effort levels. The `llm` service
  // is optional (headless): a failure only empties the lists, never breaks
  // the settings page.
  const llm = deps.getLlm();
  if (llm !== undefined) {
    try {
      const { models: found, efforts: levels } = await collectModelDirectory(llm);
      models.push(...found);
      Object.assign(efforts, levels);
    } catch { /* llm directory unavailable; leave options empty */ }
  }
  // System-trust presets (agentPresets is optional; fail-soft).
  const agentPresets = deps.getAgentPresets();
  if (agentPresets !== undefined) {
    presets.push(...await collectSystemPresets(agentPresets));
  }
  // Full tool directory = global layer + every preset's standing scope.
  let tools = [];
  try {
    tools = await collectToolsDirectory(deps.getTools, deps.getAgentPresets);
  } catch (error) {
    deps.logger.warn('[dsh-subagent-profile] tools directory failed:', error instanceof Error ? error.message : String(error));
  }
  return json(res, 200, { ok: true, enabled: deps.getEnabled(), models, efforts, presets, tools });
}

async function handleSetEnabled(deps, req, res) {
  const body = await readBody(req);
  const next = !!(body && body.enabled === true);
  deps.setEnabled(next);
  deps.store.persistEnabled(next);
  deps.syncTool();
  return json(res, 200, { ok: true, enabled: deps.getEnabled() });
}

async function handleAdd(deps, req, res) {
  const body = await readBody(req);
  const profile = body && typeof body === 'object' ? body : {};
  if (typeof profile.id !== 'string' || profile.id.length === 0) {
    return json(res, 400, { ok: false, error: 'subagent-profiles: profile id must be a non-empty string' });
  }
  // 写路径上限：strict=true —— 超限/非法字段直接 400 拒绝，
  // 与 loadProfiles（strict=false 迁移宽松读取）的行为区分。列被拒字段与中文原因。
  const { clean, warnings } = sanitizeProfile(profile, { strict: true });
  if (warnings.length > 0) {
    const detail = warnings.map((w) => `${w.field}：${w.reason}`).join('；');
    return json(res, 400, { ok: false, error: `写入被拒绝：${detail}` });
  }
  const hadToolFilter = profile.toolFilter !== undefined;
  const existing = deps.store.profiles.get(clean.id);
  const seed = BUILTIN_SEEDS.find((s) => s.id === clean.id);
  const isBuiltin = (existing !== undefined && existing.builtin === true) || seed !== undefined;
  // Merge (not replace): start from the existing profile — or its seed when it
  // was deleted — so fields not present in the form (e.g. a builtin's
  // persona/preset) survive an edit or a re-add.
  const merged = { ...(existing ?? seed ?? {}) };
  merged.id = clean.id;
  for (const key of ['name', 'description', 'preset', 'provider', 'model', 'reasoningEffort', 'persona', 'enabled']) {
    if (clean[key] === undefined) continue;       // 未传：保留 existing 原值
    if (clean[key] === '' || clean[key] === null) { delete merged[key]; continue; }  // 空：清除字段
    merged[key] = clean[key];
  }
  // toolFilter 特殊处理：前端改成多选下拉后总是传数组，空数组 = 清除。请求未传
  // toolFilter 时保留 existing 原值（merge 语义）；传了但被 sanitize 归一为空则清除。
  if (hadToolFilter) {
    const tf = clean.toolFilter;
    if (tf !== undefined && ((Array.isArray(tf.allow) && tf.allow.length > 0) || (Array.isArray(tf.deny) && tf.deny.length > 0))) {
      merged.toolFilter = { ...(Array.isArray(tf.allow) && tf.allow.length > 0 ? { allow: tf.allow } : {}), ...(Array.isArray(tf.deny) && tf.deny.length > 0 ? { deny: tf.deny } : {}) };
    } else {
      delete merged.toolFilter;
    }
  }
  if (merged.enabled !== undefined) merged.enabled = merged.enabled === false ? false : true;
  deps.store.profiles.set(merged.id, { ...merged, ...(isBuiltin ? { builtin: true } : {}), persisted: true });
  deps.store.deletedBuiltins.delete(merged.id);
  return persistOk(res, { id: merged.id }, deps.store.persistProfiles());
}

async function handleRemove(deps, req, res) {
  const body = await readBody(req);
  const id = body && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
  const existing = deps.store.profiles.get(id);
  if (existing === undefined) {
    return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" does not exist` });
  }
  deps.store.profiles.delete(id);
  if (existing.builtin === true) deps.store.deletedBuiltins.add(id);
  return persistOk(res, { id }, deps.store.persistProfiles());
}

async function handleReset(deps, req, res) {
  const body = await readBody(req);
  const id = body && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
  const seed = BUILTIN_SEEDS.find((s) => s.id === id);
  if (seed === undefined) {
    return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" is not a builtin (nothing to reset)` });
  }
  deps.store.profiles.set(id, { ...seed });
  deps.store.deletedBuiltins.delete(id);
  return persistOk(res, { id }, deps.store.persistProfiles());
}

async function handleResetAll(deps, res) {
  for (const seed of BUILTIN_SEEDS) {
    deps.store.profiles.set(seed.id, { ...seed });
    deps.store.deletedBuiltins.delete(seed.id);
  }
  return persistOk(res, { count: BUILTIN_SEEDS.length }, deps.store.persistProfiles());
}

async function handleSetProfileEnabled(deps, req, res) {
  const body = await readBody(req);
  const id = body && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
  const existing = deps.store.profiles.get(id);
  if (existing === undefined) {
    return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" does not exist` });
  }
  existing.enabled = body && body.enabled === false ? false : true;
  // Persist unconditionally (not just for builtins): a runtime-registered
  // profile's enable/disable must also survive a restart.
  existing.persisted = true;
  return persistOk(res, { id, enabled: existing.enabled }, deps.store.persistProfiles());
}

export function createHttpRoutes({ webServer, store, getEnabled, setEnabled, syncTool, getLlm, getAgentPresets, getTools, logger }) {
  const deps = { store, getEnabled, setEnabled, syncTool, getLlm, getAgentPresets, getTools, logger };
  // 路由分发（if 链保持，判断顺序与 404/500 兜底不变）。
  const handler = async (req, res) => {
    const remote = req.socket?.remoteAddress;
    if (!LOOPBACKS.has(remote)) return json(res, 403, { ok: false, error: '仅限本机访问' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sub = (url.pathname.replace(/^\/subagent-profiles/, '') || '/').replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (sub === '/' || sub === '/list')) return handleList(deps, res);
      if (req.method === 'GET' && sub === '/options') return handleOptions(deps, res);
      if (req.method === 'POST' && sub === '/set-enabled') return handleSetEnabled(deps, req, res);
      if (req.method === 'POST' && sub === '/add') return handleAdd(deps, req, res);
      if (req.method === 'POST' && sub === '/remove') return handleRemove(deps, req, res);
      if (req.method === 'POST' && sub === '/reset') return handleReset(deps, req, res);
      if (req.method === 'POST' && sub === '/reset-all') return handleResetAll(deps, res);
      if (req.method === 'POST' && sub === '/set-profile-enabled') return handleSetProfileEnabled(deps, req, res);
      json(res, 404, { ok: false, error: `未知路由 ${sub}` });
    } catch (error) {
      // 通用 500 不回显内部错误信息（防泄漏），详情只进宿主日志。
      deps.logger.error('[dsh-subagent-profile] settings route error:', error instanceof Error ? (error.stack ?? error.message) : String(error));
      json(res, 500, { ok: false, error: '内部错误，详情见宿主日志' });
    }
  };
  return () => {
    const disposeRoutes = webServer.register({ kind: 'prefix', path: '/subagent-profiles', handler });
    return () => disposeRoutes();
  };
}
