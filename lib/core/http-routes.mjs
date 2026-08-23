// lib/core/http-routes.mjs — settings HTTP loopback routes for the Client UI.
// Read routes (list / options summary / per-model efforts / tools) + write
// routes (set-enabled / add / remove / reset / reset-all / set-profile-enabled).
// The /options catalog (models / presets / tools / efforts) is served from the
// shared catalog cache (lib/core/catalog-cache.mjs), so these routes no longer
// walk the llm directory themselves.
//
// Injection: every apply-closure / ctx dependency is an explicit parameter —
//   store         the profile store (profiles Map / persistProfiles /
//                 persistEnabled / deletedBuiltins),
//   getEnabled    reads the apply-closure `enabled` flag (mutated by
//                 /set-enabled),
//   setEnabled    writes it,
//   syncTool      unregisters/registers the dispatch tool on /set-enabled,
//   catalog       the shared catalog cache (getSnapshot / invalidate),
//   logger        ctx.logger (route error warnings).
// The factory returns the scope.effect setup function so the caller keeps the
// exact original registration shape: effect(() => register + disposer).
//
// 写路由各抽为模块级处理函数（if 链分发保持）；/options 拆三读路由 + 手动刷新，
// 目录数据统一来自 catalog 快照。

import { sanitizeProfile } from './pure.mjs';
import { BUILTIN_SEEDS } from './profiles-store.mjs';
import { detectVersions } from './shims.mjs';

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

// 轻量摘要：enabled + 模型目录（含 provider 信息，客户端据此派生提供方列表）+ 预设名册。
async function handleSummary(deps, res) {
  const snapshot = await deps.catalog.getSnapshot();
  return json(res, 200, { ok: true, enabled: deps.getEnabled(), models: snapshot.models, presets: snapshot.presets });
}

// 每模型 reasoning-effort 等级（懒加载；model 命中快照的 efforts 表）。
async function handleEfforts(deps, url, res) {
  const model = url.searchParams.get('model');
  const snapshot = await deps.catalog.getSnapshot();
  const efforts = (typeof model === 'string' && model !== '' && snapshot.efforts[model] !== undefined) ? snapshot.efforts[model] : [];
  return json(res, 200, { ok: true, efforts });
}

// 完整工具目录（面板打开时取）。
async function handleTools(deps, res) {
  const snapshot = await deps.catalog.getSnapshot();
  return json(res, 200, { ok: true, tools: snapshot.tools });
}

// 版本探测：三包 version + 越界/未知的中文 warnings（纯探测，同步）。
function handleVersions(res) {
  const { versions, warnings } = detectVersions();
  return json(res, 200, { ok: true, versions, warnings });
}

// 手动刷新：清缓存兜底（TTL 过期前的目录变更经此立即生效）。
async function handleRefresh(deps, res) {
  deps.catalog.invalidate();
  return json(res, 200, { ok: true, refreshed: true });
}

// 失败台账读取：GET /ledger/failures?session=<id> → { ok:true, failures:[...] }。
// 未知 session 返回空数组；台账是会话级内存结构，进程重启即失。
async function handleLedgerFailures(deps, url, res) {
  const session = url.searchParams.get('session') ?? '';
  return json(res, 200, { ok: true, failures: deps.ledger.get(session) });
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
  // tokenTier 不参与上方通用 merge 循环：sanitizeProfile 对「未提供」恒回填
  // balanced，若进循环会破坏「未传→保留 existing」语义（编辑内置 researcher
  // 时 cheap 会被重置为 balanced）。故单独用 raw-body 守卫：传了才写（strict
  // 模式下非法值已在上面 400 拒绝，clean.tokenTier 必为合法 enum）。
  const hadTokenTier = profile.tokenTier !== undefined;
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
  if (hadTokenTier) merged.tokenTier = clean.tokenTier;
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

export function createHttpRoutes({ webServer, store, getEnabled, setEnabled, syncTool, catalog, ledger, logger }) {
  const deps = { store, getEnabled, setEnabled, syncTool, catalog, ledger, logger };
  // 路由分发（if 链保持，判断顺序与 404/500 兜底不变）。
  const handler = async (req, res) => {
    const remote = req.socket?.remoteAddress;
    if (!LOOPBACKS.has(remote)) return json(res, 403, { ok: false, error: '仅限本机访问' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sub = (url.pathname.replace(/^\/subagent-profiles/, '') || '/').replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (sub === '/' || sub === '/list')) return handleList(deps, res);
      if (req.method === 'GET' && sub === '/options/summary') return handleSummary(deps, res);
      if (req.method === 'GET' && sub === '/options/versions') return handleVersions(res);
      if (req.method === 'GET' && sub === '/options/efforts') return handleEfforts(deps, url, res);
      if (req.method === 'GET' && sub === '/options/tools') return handleTools(deps, res);
      if (req.method === 'GET' && sub === '/ledger/failures') return handleLedgerFailures(deps, url, res);
      if (req.method === 'POST' && sub === '/options/refresh') return handleRefresh(deps, res);
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
