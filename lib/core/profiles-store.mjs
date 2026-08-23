// lib/core/profiles-store.mjs — profile registry store and enable/disable switch
// (moved verbatim from index.mjs and refactored into a factory; import-free —
// node builtins + lib/core/pure.mjs only, no @deepseek-ai dependency).
//
// `dshHome()` and `BUILTIN_SEEDS` are module-level exports shared by the
// factory and by lib/core/http-routes.mjs (the settings HTTP handlers look up seeds). The
// per-apply store is constructed by `createProfileStore({ dshHome, logger })`,
// replacing the apply-closure singleton: every apply() call gets its own
// profiles Map / deletedBuiltins Set / allowFailOpen flag, exactly like the
// original closure state.
//
// 工厂内嵌的 loadProfiles/persistProfiles/loadEnabled/persistEnabled/
// resolveProfile 按行门抽为模块级函数，per-apply 状态收集进 `state` 对象
// 注入；返回面与拆分前逐字一致。

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizeProfile } from './pure.mjs';

// Resolve the DSH home directory (env override wins, platform fallback) — the
// same policy as the dsh-persona-ref bundle: user profiles persist to
// ~/.dsh/subagent-profiles.json, stable across harness working directories.
export function dshHome() {
  const raw = process.env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim();
    if (trimmed === '~') return homedir();
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2));
    return trimmed;
  }
  return join(homedir(), '.dsh');
}

// 1. Profile registry (per-instance state; a bundle row is process-level, so
//    this Map is the singleton store, exactly like the dynamic plugin's).
//    Builtin seeds carry `builtin: true` so reset/remove can identify them and
//    a modified builtin stays distinguishable from a pure user profile.
//    Descriptions are semantic: one-line positioning + when to use, to help
//    the model choose. reasoningEffort levels verified against the
//    llm-deepseek adapter (off/high/max; see resolveModel gating on
//    connection.defaults.thinking — this deployment leaves thinking unset,
//    so the full set is advertised for deepseek-v4-flash).
export const BUILTIN_SEEDS = [
  { id: 'swap-standard', name: '标准编码', description: '切换到 standard 预设的完整编码工具集。当父会话不是 standard、但子任务需要完整编码能力时用。', preset: 'standard', tokenTier: 'balanced', builtin: true },
  { id: 'researcher', name: '调研检索', description: '关闭深度推理省 token，继承父工具。适合查资料、汇总、背景调研，不适合改代码。', reasoningEffort: 'off', persona: 'You are a research subagent: search, read, and summarize only. Do not modify code or files.', tokenTier: 'cheap', builtin: true }
];

// --- 模块级 store 函数（从工厂拆出；per-apply 状态经 `state` 注入）---------------

function resolveProfile(profiles, id) {
  const found = profiles.get(id);
  if (found === undefined) throw new Error(`dispatch: unknown profile "${id}"`);
  if (found.enabled === false) throw new Error(`dispatch: profile "${id}" is disabled`);
  return found;
}

// Two file shapes: v1 = a bare array; v2 = { version:2,
// profiles:[...], allowFailOpen:<bool> }. Returns { entries, version } or
// { entries: undefined } for an unrecognized shape.
function classifyProfileFile(parsed) {
  if (Array.isArray(parsed)) return { entries: parsed, version: 1 };
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.profiles)) {
    return { entries: parsed.profiles, version: parsed.version ?? 2 };
  }
  return { entries: undefined, version: undefined };
}

// Per-entry sanitize (strict=false): over-limit fields are dropped (field
// removed) + warned; an over-length persona is KEPT + warned (never silently
// truncated). A bad entry is skipped (fail-soft). Returns
// 'loaded' | 'skipped' | 'deleted' so loadProfiles can keep its counters.
function applyProfileEntry(raw, profiles, deletedBuiltins, logger) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length === 0) {
    logger.warn('[dsh-subagent-profile] skipping malformed profile entry:', raw === null ? String(raw) : typeof raw);
    return 'skipped';
  }
  const { clean, warnings } = sanitizeProfile(raw, { strict: false });
  for (const warning of warnings) {
    logger.warn(`[dsh-subagent-profile] profile "${raw.id}" ${warning.field} 被跳过或提示：${warning.reason}`);
  }
  if (clean.deleted === true) {
    if (clean.builtin === true) {
      profiles.delete(clean.id);
      deletedBuiltins.add(clean.id);
    }
    return 'deleted';
  }
  const existing = profiles.get(clean.id);
  if (existing !== undefined && existing.builtin === true) {
    profiles.set(clean.id, { ...clean, builtin: true, persisted: true });
  } else {
    profiles.set(clean.id, { ...clean, persisted: true });
  }
  return 'loaded';
}

// 1b. User profile persistence. The settings service cannot serve this
// plugin (its write path hard-requires register(ns, schema) + a schemastery
// schema), so user profiles are persisted to ~/.dsh/subagent-profiles.json
// through node:fs — a bundle has node globals, unlike the dynamic-plugin
// sandbox that needed the optional `fs` service. Loaded once at startup; the
// add/remove HTTP routes rewrite the file. Persistence is an enhancement, not
// a hard dependency: any failure only warns and the builtin seeds work.
function loadProfiles(state, logger) {
  if (!existsSync(state.profilesFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(state.profilesFile, 'utf8'));
    const { entries, version } = classifyProfileFile(parsed);
    if (entries === undefined) {
      logger.warn('[dsh-subagent-profile] persisted profile file has an unrecognized shape; ignoring');
      return;
    }
    if (version !== 2) {
      // v1 (or an unversioned array): migrate in memory, keep fail-open compat.
      state.allowFailOpen = true;
      logger.warn('[dsh-subagent-profile] v1 数据：fail-open 兼容模式');
    } else {
      // v2 缺 allowFailOpen 字段时按 fail-open 兼容（显式 false 才关闭）；
      // 全新部署默认已定：fail-loud（初始 allowFailOpen=false）。
      state.allowFailOpen = parsed.allowFailOpen !== false;
    }
    let loaded = 0;
    let skipped = 0;
    for (const raw of entries) {
      const status = applyProfileEntry(raw, state.profiles, state.deletedBuiltins, logger);
      if (status === 'loaded') loaded++;
      else if (status === 'skipped') skipped++;
    }
    // Silent success: report how many persisted profiles came in (skipped
    // when none — a missing/empty file is the normal first boot).
    if (loaded > 0) logger.info(`[dsh-subagent-profile] loaded ${loaded} persisted profile(s)`);
    if (skipped > 0) logger.warn(`[dsh-subagent-profile] skipped ${skipped} malformed profile entry(ies)`);
  } catch (error) {
    logger.warn('[dsh-subagent-profile] persisted profile load failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Persist every `persisted: true` profile plus builtin-delete tombstones.
 * Atomic write: write `<profilesFile>.tmp` in the same directory,
 * then `renameSync` over the target (a crash leaves the old file intact, never
 * a truncated one). Fail-visible: a failure does NOT throw and does NOT
 * roll back the in-memory `profiles` Map — it returns `{ persisted: false }` so
 * the caller can signal "已保存但未持久化" while the in-memory state keeps
 * driving this process. Always writes the v2 envelope shape.
 */
function persistProfiles(state, logger) {
  const entries = [];
  for (const profile of state.profiles.values()) {
    if (profile.persisted !== true) continue;
    const clean = {};
    for (const [key, value] of Object.entries(profile)) {
      if (value === undefined || key === 'persisted') continue;
      clean[key] = value;
    }
    entries.push(clean);
  }
  for (const id of state.deletedBuiltins) {
    entries.push({ id, builtin: true, deleted: true });
  }
  const payload = { version: 2, profiles: entries, allowFailOpen: state.allowFailOpen };
  const tmp = `${state.profilesFile}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, state.profilesFile);
    return { persisted: true };
  } catch (error) {
    // Best-effort cleanup of the partial tmp file (rename never ran).
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    logger.warn('[dsh-subagent-profile] persisted profile write failed:', error instanceof Error ? error.message : String(error));
    return { persisted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// The plugin's enable/disable switch. Persisted beside the profile list so a
// user can turn the dispatch tool off without uninstalling the bundle. Default
// is enabled; a missing/unreadable file falls back to enabled.
function loadEnabled(state) {
  try {
    if (existsSync(state.stateFile)) {
      const parsed = JSON.parse(readFileSync(state.stateFile, 'utf8'));
      return parsed && parsed.enabled !== false;
    }
  } catch {
    // fall through to enabled
  }
  return true;
}

function persistEnabled(state, enabled) {
  try {
    writeFileSync(state.stateFile, JSON.stringify({ enabled }, null, 2), 'utf8');
  } catch {
    // best effort — the in-memory state still drives this process
  }
}

// Build one store instance. `dshHome` is the already-resolved home directory
// string (from the exported dshHome()); `logger` is the apply-time ctx.logger.
// Per-apply state (profiles / deletedBuiltins / paths / allowFailOpen) collects
// into `state` for the moved module-level functions. The returned surface is
// identical to the pre-split factory.
export function createProfileStore({ dshHome, logger }) {
  const profiles = new Map(BUILTIN_SEEDS.map((p) => [p.id, { ...p }]));
  const deletedBuiltins = new Set();
  const state = {
    profiles,
    deletedBuiltins,
    profilesFile: join(dshHome, 'subagent-profiles.json'),
    stateFile: join(dshHome, 'subagent-profiles.state.json'),
    allowFailOpen: false,
  };
  return {
    profiles,
    deletedBuiltins,
    resolveProfile: (id) => resolveProfile(profiles, id),
    loadProfiles: () => loadProfiles(state, logger),
    persistProfiles: () => persistProfiles(state, logger),
    loadEnabled: () => loadEnabled(state),
    persistEnabled: (enabled) => persistEnabled(state, enabled),
    // getAllowFailOpen: the cost guard must read the migration flag at dispatch
    // time; loadProfiles/persistProfiles own the mutation.
    getAllowFailOpen: () => state.allowFailOpen,
  };
}
