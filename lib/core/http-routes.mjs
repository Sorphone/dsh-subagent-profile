// lib/core/http-routes.mjs — Client UI 的设置 HTTP loopback 路由。
// 读路由（list / options 摘要 / 按模型 efforts / tools）+ 写路由
// （set-enabled / add / remove / reset / reset-all / set-profile-enabled）。
// /options 目录（models / presets / tools / efforts）由共享 catalog 缓存
// （lib/core/catalog-cache.mjs）提供，这些路由不再自行遍历 llm 目录。
//
// 注入：所有 apply 闭包 / ctx 依赖都是显式参数——
//   store         profile store（profiles Map / persistProfiles /
//                 persistEnabled / deletedBuiltins），
//   getEnabled    读取 apply 闭包 `enabled` 标志（被 /set-enabled 改写），
//   setEnabled    写它，
//   syncTool      在 /set-enabled 时注销/注册 dispatch 工具，
//   catalog       共享 catalog 缓存（getSnapshot / invalidate），
//   logger        ctx.logger（路由错误告警）。
// 工厂返回 scope.effect 设置函数，调用方保持原有注册形状：
// effect(() => register + disposer)。
//
// 写路由各抽为模块级处理函数（if 链分发保持）；/options 拆三读路由 + 手动刷新，
// 目录数据统一来自 catalog 快照。

import { sanitizeProfile } from './pure.mjs';
import { BUILTIN_SEEDS } from './profiles-store.mjs';
import { detectVersions } from './shims.mjs';
import { readSummaries } from './evolution-summary.mjs';
import { profileStatsFromSummaries } from './profile-directory.mjs';

// 只有 loopback 接口可以驱动设置 HTTP 路由。
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// 写路由 CSRF 传输授权三件套。loopback 只挡「来源不是本机」；这三件挡「浏览器里的
// 跨域表单/脚本冒充本机提交」——schema 校验的是数据形状，管不到谁有权写。
// URL.hostname 对 IPv6 字面量返回带方括号形态（http://[::1]:port → '[::1]'），
// 两种形态都列入，避免 IPv6 loopback 源被误拒。
const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const CSRF_HEADER = 'X-DSH-Plugin';
const CSRF_HEADER_KEY = CSRF_HEADER.toLowerCase();
const CSRF_HEADER_VALUE = 'dsh-subagent-profile';

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

// 写失败契约：写路由返回 HTTP 200 且 `persisted` 恒在场；磁盘写失败时
// persistWarning 说明「已保存但未持久化」（内存态驱动本进程，磁盘未更新）。
// 客户端把它渲染为琥珀色警告。
function persistOk(res, payload, persist) {
  return json(res, 200, {
    ok: true,
    ...payload,
    persisted: persist.persisted,
    ...(persist.persisted ? {} : { persistWarning: '已保存但未持久化' }),
  });
}

function listClean(store, stats) {
  const map = stats instanceof Map ? stats : new Map();
  return [...store.profiles.values()].map((profile) => {
    const clean = {};
    for (const [key, value] of Object.entries(profile)) if (value !== undefined && key !== 'persisted') clean[key] = value;
    // 内部 `persisted` 标志已在上方剥离；对外暴露 UI 面向的 "modified"
    // 信号，供重置面板标注被改过的内置方案。
    if (profile.builtin === true && profile.persisted === true) clean.modified = true;
    // Task 40b：方案卡成本预览数据（有数据才带；N 必显作置信度信号）。
    const stat = map.get(profile.id);
    if (stat !== undefined) {
      if (stat.avgCost !== null && stat.avgCost !== undefined) clean.avgCost = stat.avgCost;
      if (stat.successRate !== null && stat.successRate !== undefined) clean.successRate = stat.successRate;
      if (stat.n !== undefined) clean.n = stat.n;
    }
    return clean;
  });
}

// --- 路由处理函数（从 createHttpRoutes 拆出；if 链分发在内保持）----------------

async function handleList(deps, res) {
  let stats = new Map();
  try {
    // 先刷新（若台账有新增），再读 summaries 为方案卡注入 avgCost/successRate。
    if (typeof deps.refreshAdvice === 'function') deps.refreshAdvice();
    const summaries = typeof deps.summariesFile === 'string' ? readSummaries(deps.summariesFile, deps.logger) : null;
    stats = profileStatsFromSummaries(deps.store, summaries);
  } catch {
    // 统计是增量展示；任何失败都不影响 /list 主响应。
  }
  return json(res, 200, { ok: true, profiles: listClean(deps.store, stats) });
}

// 轻量摘要：enabled + evolutionAdvice + 模型目录（含 provider 信息，客户端据此派生提供方列表）+ 预设名册
// + 审计分级（lostTelemetry/lostGovernance/health，供设置页红字与丢失计数展示）。
async function handleSummary(deps, res) {
  const snapshot = await deps.catalog.getSnapshot();
  return json(res, 200, {
    ok: true,
    enabled: deps.getEnabled(),
    evolutionAdvice: deps.getEvolutionAdvice(),
    models: snapshot.models,
    presets: snapshot.presets,
    audit: deps.getAudit(),
    escapeEnabled: deps.getEscapeEnabled(),
    escapePresets: deps.escape.list(),
  });
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

// 手动刷新：清缓存兜底（TTL 过期前的目录变更经此立即生效）+ 重算 evolution:advice
// 聚合（T1：/options/refresh 此前不触发聚合，summaries.json 永无生成路径）。
async function handleRefresh(deps, res) {
  deps.catalog.invalidate();
  if (typeof deps.refreshAdvice === 'function') deps.refreshAdvice();
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
  const persist = deps.store.persistEnabled(next);
  deps.syncTool();
  return persistOk(res, { enabled: deps.getEnabled() }, persist);
}

// 只读建议注入开关（默认关）：改写 apply 闭包 evolutionAdvice 并持久化到 state.json。
// 不改派发行为（建议只读提示）；写路由 CSRF 三件套自动生效。
async function handleSetEvolutionAdvice(deps, req, res) {
  const body = await readBody(req);
  const next = !!(body && body.advice === true);
  deps.setEvolutionAdvice(next);
  const persist = deps.store.persistEvolutionAdvice(next);
  return persistOk(res, { evolutionAdvice: deps.getEvolutionAdvice() }, persist);
}

// 逃生舱开关（默认关）：改写 apply 闭包 escapeEnabled 并持久化到 state.json。
// 只放行「放行集内且其余三道闸全过」的非 system 预设；非成员即便开关开也恒拒。
async function handleSetEscape(deps, req, res) {
  const body = await readBody(req);
  const next = !!(body && body.enabled === true);
  deps.setEscapeEnabled(next);
  const persist = deps.store.persistEscapeEnabled(next);
  return persistOk(res, { escapeEnabled: deps.getEscapeEnabled() }, persist);
}

// 放行集写路径校验：解析请求体的 preset id（非字符串/缺失归一为空串，由调用方
// 400 拒绝）。纯同步、无副作用。
function escapePresetId(body) {
  const raw = body && typeof body === 'object' && typeof body.preset === 'string' ? body.preset : '';
  return raw.trim();
}

async function handleEscapeAdd(deps, req, res) {
  const body = await readBody(req);
  const preset = escapePresetId(body);
  if (preset === '') return json(res, 400, { ok: false, error: 'subagent-profiles: escape preset 必须为非空字符串' });
  const snapshot = await deps.catalog.getSnapshot();
  if (snapshot.presets.some((p) => p && p.id === preset)) {
    return json(res, 400, { ok: false, error: `subagent-profiles: preset "${preset}" 已是 system-trust，无需加入逃生舱` });
  }
  const persist = deps.escape.add(preset);
  return persistOk(res, { preset, presets: deps.escape.list() }, persist);
}

async function handleEscapeRemove(deps, req, res) {
  const body = await readBody(req);
  const preset = escapePresetId(body);
  if (preset === '') return json(res, 400, { ok: false, error: 'subagent-profiles: escape preset 必须为非空字符串' });
  const persist = deps.escape.remove(preset);
  return persistOk(res, { preset, presets: deps.escape.list() }, persist);
}

async function handleAdd(deps, req, res) {
  const body = await readBody(req);
  const profile = body && typeof body === 'object' ? body : {};
  if (typeof profile.id !== 'string' || profile.id.length === 0) {
    return json(res, 400, { ok: false, error: 'subagent-profiles: profile id 必须为非空字符串' });
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
  // 合并而非替换：从现有 profile（或它被删时的 seed）出发，表单未带的字段
  // （如内置方案的 persona/preset）在编辑或重新添加后仍然保留。
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
    return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" 不存在（可在设置页确认可用的 profile id）` });
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
    return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" 不是内置方案（无可重置项）` });
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
    return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" 不存在（可在设置页确认可用的 profile id）` });
  }
  existing.enabled = body && body.enabled === false ? false : true;
  // 无条件持久化（不只是内置方案）：运行时注册的 profile 的启用/禁用也必须
  // 在重启后保留。
  existing.persisted = true;
  return persistOk(res, { id, enabled: existing.enabled }, deps.store.persistProfiles());
}

// 写路由 CSRF 传输授权：Origin 白名单 + Content-Type + 自定义头三道检查。
// 返回 null 表示放行；否则返回 { reason, origin, contentType }——reason 进 403
// 响应与 warn 日志，origin/contentType 只进日志（二者本就是请求头，非秘密）。
// GET 只读路由不经过此处（只读无状态变更，不设防）。
function csrfViolation(req) {
  const headers = req.headers ?? {};
  const origin = typeof headers.origin === 'string' ? headers.origin : '';
  const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
  // 1. Origin 白名单：带 Origin 时只放行本机源（hostname 宽松判定，端口不限）；
  //    无 Origin 的本地脚本/curl 跳过此道，靠第 3 道自定义头兜底。
  if (origin !== '') {
    let host;
    try { host = new URL(origin).hostname; } catch { host = null; }
    if (host === null || !LOOPBACK_ORIGIN_HOSTS.has(host)) {
      return { reason: `Origin 不在本机白名单（收到：${origin}）`, origin, contentType };
    }
  }
  // 2. 强制 Content-Type: application/json（text/plain、表单编码等一律拒绝）。
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return { reason: `写请求必须带 Content-Type: application/json（收到：${contentType || '缺失'}）`, origin, contentType };
  }
  // 3. 自定义头逼 preflight：跨域表单/脚本无法携带非简单头，缺头即拒。
  if (headers[CSRF_HEADER_KEY] !== CSRF_HEADER_VALUE) {
    return { reason: `写请求必须带 ${CSRF_HEADER}: ${CSRF_HEADER_VALUE} 请求头`, origin, contentType };
  }
  return null;
}

export function createHttpRoutes({ webServer, store, getEnabled, setEnabled, syncTool, catalog, ledger, getAudit, getEvolutionAdvice, setEvolutionAdvice, getEscapeEnabled, setEscapeEnabled, escape, refreshAdvice, summariesFile, logger }) {
  const deps = { store, getEnabled, setEnabled, syncTool, catalog, ledger, getAudit, getEvolutionAdvice, setEvolutionAdvice, getEscapeEnabled, setEscapeEnabled, escape, refreshAdvice, summariesFile, logger };
  // 路由分发（if 链保持，判断顺序与 404/500 兜底不变）。
  const handler = async (req, res) => {
    const remote = req.socket?.remoteAddress;
    if (!LOOPBACKS.has(remote)) return json(res, 403, { ok: false, error: '仅限本机访问' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sub = (url.pathname.replace(/^\/subagent-profiles/, '') || '/').replace(/\/+$/, '') || '/';
    try {
      // 写路由统一做 CSRF 传输授权（loopback 之后、路由分发之前）；GET 只读不设防。
      if (req.method === 'POST') {
        const violation = csrfViolation(req);
        if (violation !== null) {
          deps.logger.warn(
            `[dsh-subagent-profile] CSRF 防护拒绝：${violation.reason}` +
            `（origin=${violation.origin || '无'}，contentType=${violation.contentType || '无'}）`
          );
          return json(res, 403, { ok: false, error: `CSRF 防护拒绝：${violation.reason}` });
        }
      }
      if (req.method === 'GET' && (sub === '/' || sub === '/list')) return handleList(deps, res);
      if (req.method === 'GET' && sub === '/options/summary') return handleSummary(deps, res);
      if (req.method === 'GET' && sub === '/options/versions') return handleVersions(res);
      if (req.method === 'GET' && sub === '/options/efforts') return handleEfforts(deps, url, res);
      if (req.method === 'GET' && sub === '/options/tools') return handleTools(deps, res);
      if (req.method === 'GET' && sub === '/ledger/failures') return handleLedgerFailures(deps, url, res);
      if (req.method === 'POST' && sub === '/options/refresh') return handleRefresh(deps, res);
      if (req.method === 'POST' && sub === '/set-enabled') return handleSetEnabled(deps, req, res);
      if (req.method === 'POST' && sub === '/set-evolution-advice') return handleSetEvolutionAdvice(deps, req, res);
      if (req.method === 'POST' && sub === '/set-escape') return handleSetEscape(deps, req, res);
      if (req.method === 'POST' && sub === '/escape-add') return handleEscapeAdd(deps, req, res);
      if (req.method === 'POST' && sub === '/escape-remove') return handleEscapeRemove(deps, req, res);
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
