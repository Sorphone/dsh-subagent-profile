// lib/profiles-store.mjs — profile registry store and enable/disable switch
// (moved verbatim from index.mjs and refactored into a factory; import-free —
// node builtins + lib/pure.mjs only, no @deepseek-ai dependency).
//
// `dshHome()` and `BUILTIN_SEEDS` are module-level exports shared by the
// factory and by index.mjs (the settings HTTP handlers look up seeds). The
// per-apply store is constructed by `createProfileStore({ dshHome, logger })`,
// replacing the apply-closure singleton: every apply() call gets its own
// profiles Map / deletedBuiltins Set / allowFailOpen flag, exactly like the
// original closure state.

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
  { id: 'swap-standard', name: '标准编码', description: '切换到 standard 预设的完整编码工具集。当父会话不是 standard、但子任务需要完整编码能力时用。', preset: 'standard', builtin: true },
  { id: 'researcher', name: '调研检索', description: '关闭深度推理省 token，继承父工具。适合查资料、汇总、背景调研，不适合改代码。', reasoningEffort: 'off', persona: 'You are a research subagent: search, read, and summarize only. Do not modify code or files.', builtin: true }
];

// Build one store instance. `dshHome` is the already-resolved home directory
// string (from the exported dshHome()); `logger` is the apply-time ctx.logger.
// The moved loadProfiles/persistProfiles bodies reference `ctx.logger` verbatim,
// so a minimal `ctx` alias is kept inside the factory.
export function createProfileStore({ dshHome, logger }) {
  const ctx = { logger };

  const profiles = new Map(BUILTIN_SEEDS.map((p) => [p.id, { ...p }]));

  // Builtin ids the user has deleted (soft delete via persisted tombstone). The
  // Map keeps working entries; this Set records tombstones so they survive
  // restarts and a later reset can clear them.
  const deletedBuiltins = new Set();

  function resolveProfile(id) {
    const found = profiles.get(id);
    if (found === undefined) throw new Error(`dispatch: unknown profile "${id}"`);
    if (found.enabled === false) throw new Error(`dispatch: profile "${id}" is disabled`);
    return found;
  }

  // 1b. User profile persistence. The settings service cannot serve this
  // plugin (its write path hard-requires register(ns, schema) + a schemastery
  // schema), so user profiles are persisted to ~/.dsh/subagent-profiles.json
  // through node:fs — a bundle has node globals, unlike the dynamic-plugin
  // sandbox that needed the optional `fs` service. Loaded once at startup; the
  // add/remove HTTP routes rewrite the file. Persistence is an enhancement, not
  // a hard dependency: any failure only warns and the builtin seeds work.
  const profilesFile = join(dshHome, 'subagent-profiles.json');
  // V2 migration switch (SPEC §7.3 / §12.1): whether the cost guard may fail-open
  // when the `llm` service is absent. Defaults to FALSE (fail-loud, SPEC §7.3
  // 评审遗留裁定: 全新部署 fail-loud); only a v1 data file being read sets it to
  // true (v1 迁移 fail-open 兼容). A v2 envelope carries its own stored value.
  // Task 4 (cost-guard narrow) reads this flag.
  let allowFailOpen = false;
  function loadProfiles() {
    if (!existsSync(profilesFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(profilesFile, 'utf8'));
      // Two file shapes (SPEC §12.1): v1 = a bare array; v2 = { version:2,
      // profiles:[...], allowFailOpen:<bool> }.
      let entries;
      let version;
      if (Array.isArray(parsed)) {
        entries = parsed;
        version = 1;
      } else if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.profiles)) {
        entries = parsed.profiles;
        version = parsed.version ?? 2;
        // v2 缺 allowFailOpen 字段时按 fail-open 兼容（显式 false 才关闭）；
        // 全新部署默认已定：fail-loud（初始 allowFailOpen=false，见上方声明），
        // 读入 v2 文件按其存储值读取并保持。
        allowFailOpen = parsed.allowFailOpen !== false;
      } else {
        ctx.logger.warn('[dsh-subagent-profile] persisted profile file has an unrecognized shape; ignoring');
        return;
      }
      // v1 (or an unversioned array): migrate in memory, keep fail-open compat.
      if (version !== 2) {
        allowFailOpen = true;
        ctx.logger.warn('[dsh-subagent-profile] v1 数据：fail-open 兼容模式');
      }
      let loaded = 0;
      let skipped = 0;
      for (const raw of entries) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length === 0) {
          skipped++;
          ctx.logger.warn('[dsh-subagent-profile] skipping malformed profile entry:', raw === null ? String(raw) : typeof raw);
          continue;
        }
        // Per-entry sanitize (strict=false): over-limit fields are dropped
        // (field removed) + warned; an over-length persona is KEPT + warned
        // (never silently truncated). A bad entry is skipped (fail-soft).
        const { clean, warnings } = sanitizeProfile(raw, { strict: false });
        for (const warning of warnings) {
          ctx.logger.warn(`[dsh-subagent-profile] profile "${raw.id}" ${warning.field} 被跳过或提示：${warning.reason}`);
        }
        if (clean.deleted === true) {
          if (clean.builtin === true) {
            profiles.delete(clean.id);
            deletedBuiltins.add(clean.id);
          }
          continue;
        }
        const existing = profiles.get(clean.id);
        if (existing !== undefined && existing.builtin === true) {
          profiles.set(clean.id, { ...clean, builtin: true, persisted: true });
        } else {
          profiles.set(clean.id, { ...clean, persisted: true });
        }
        loaded++;
      }
      // Silent success: report how many persisted profiles came in (skipped
      // when none — a missing/empty file is the normal first boot).
      if (loaded > 0) ctx.logger.info(`[dsh-subagent-profile] loaded ${loaded} persisted profile(s)`);
      if (skipped > 0) ctx.logger.warn(`[dsh-subagent-profile] skipped ${skipped} malformed profile entry(ies)`);
    } catch (error) {
      ctx.logger.warn('[dsh-subagent-profile] persisted profile load failed:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Persist every `persisted: true` profile plus builtin-delete tombstones.
   * Atomic write (SPEC §12.2): write `<profilesFile>.tmp` in the same directory,
   * then `renameSync` over the target (a crash leaves the old file intact, never
   * a truncated one). Fail-visible (D5/B1): a failure does NOT throw and does NOT
   * roll back the in-memory `profiles` Map — it returns `{ persisted: false }` so
   * the caller can signal "已保存但未持久化" while the in-memory state keeps
   * driving this process. Always writes the v2 envelope shape.
   */
  function persistProfiles() {
    const entries = [];
    for (const profile of profiles.values()) {
      if (profile.persisted !== true) continue;
      const clean = {};
      for (const [key, value] of Object.entries(profile)) {
        if (value === undefined || key === 'persisted') continue;
        clean[key] = value;
      }
      entries.push(clean);
    }
    for (const id of deletedBuiltins) {
      entries.push({ id, builtin: true, deleted: true });
    }
    const payload = { version: 2, profiles: entries, allowFailOpen };
    const tmp = `${profilesFile}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, profilesFile);
      return { persisted: true };
    } catch (error) {
      // Best-effort cleanup of the partial tmp file (rename never ran).
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      ctx.logger.warn('[dsh-subagent-profile] persisted profile write failed:', error instanceof Error ? error.message : String(error));
      return { persisted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // The plugin's enable/disable switch. Persisted beside the profile list so a
  // user can turn the dispatch tool off without uninstalling the bundle. Default
  // is enabled; a missing/unreadable file falls back to enabled.
  function stateFile() {
    return join(dshHome, 'subagent-profiles.state.json');
  }
  function loadEnabled() {
    try {
      if (existsSync(stateFile())) {
        const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'));
        return parsed && parsed.enabled !== false;
      }
    } catch {
      // fall through to enabled
    }
    return true;
  }
  function persistEnabled(enabled) {
    try {
      writeFileSync(stateFile(), JSON.stringify({ enabled }, null, 2), 'utf8');
    } catch {
      // best effort — the in-memory state still drives this process
    }
  }

  // getAllowFailOpen: index.mjs's assertCostGuard must read the migration flag
  // (SPEC §7.3) at dispatch time; loadProfiles/persistProfiles own the mutation.
  // stateFile is internal (used by loadEnabled/persistEnabled only) and is not
  // part of the returned surface.
  return {
    profiles,
    deletedBuiltins,
    resolveProfile,
    loadProfiles,
    persistProfiles,
    loadEnabled,
    persistEnabled,
    getAllowFailOpen: () => allowFailOpen,
  };
}
