// lib/core/presets-sync.mjs — bundled agent-preset self-install (moved verbatim from
// index.mjs; import-free — node builtins only, no @deepseek-ai dependency).
//
// On host startup the plugin syncs the bundled `presets/` tree into the DSH
// agent-presets discovery root (~/.dsh/.agent-presets) so the "orchestrator"
// mode appears in the new-session picker without manual copying — the same
// self-install pattern as the shipped dsh-liangshen bundle. The sync is
// per-directory and idempotent (byte-identical trees are skipped; target files
// the bundle no longer ships are pruned); directories the plugin does not own
// are never touched. node:fs cpSync is avoided deliberately: on Node 22 for
// Windows, fs.cpSync({ recursive: true }) can crash the process when a source
// path contains non-ASCII (CJK home dir, nodejs/node#54476), so the copy is
// per-entry, preserving source mtimes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute path of the bundled preset tree inside this package. This module
// lives in lib/, one level below the package root, so the URL must climb back
// up one segment to still point at the repo-root `presets/` directory (same
// resolved value as when this function lived in index.mjs at the package root).
export function bundledPresetsRoot() {
  return fileURLToPath(new URL('../presets', import.meta.url));
}

export const MTIME_TOLERANCE_MS = 1000;

export function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

// File identity is bytes; size/mtime are only a fast negative check.
export function sameFile(a, b) {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  if (Math.abs(sa.mtimeMs - sb.mtimeMs) > MTIME_TOLERANCE_MS) return false;
  return readFileSync(a).equals(readFileSync(b));
}

export function copyTreeSync(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry);
    const target = join(targetDir, entry);
    const st = statSync(source);
    if (st.isDirectory()) copyTreeSync(source, target);
    else {
      copyFileSync(source, target);
      utimesSync(target, st.atime, st.mtime);
    }
  }
}

// Remove target files not in `keep`, then only the directories emptied by it.
export function pruneExtras(root, keep) {
  const parents = new Set();
  for (const file of filesUnder(root)) {
    if (!keep.has(relative(root, file))) {
      parents.add(dirname(file));
      rmSync(file, { force: true });
    }
  }
  for (const start of parents) {
    let dir = start;
    while (dir !== undefined && relative(root, dir) !== '') {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
        dir = dirname(dir);
      } else dir = undefined;
    }
  }
}

// Copy `sourceDir` into `targetDir` idempotently; returns 'synced' or 'current'.
export function syncOnePreset(sourceDir, targetDir) {
  const sourceFiles = filesUnder(sourceDir);
  const sourceSet = new Set(sourceFiles.map((f) => relative(sourceDir, f)));
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  if (!existsSync(targetDir)) {
    copyTreeSync(sourceDir, targetDir);
    pruneExtras(targetDir, sourceSet);
    return 'synced';
  }
  let dirty = false;
  for (const file of sourceFiles) {
    const dest = join(targetDir, relative(sourceDir, file));
    if (!existsSync(dest) || !sameFile(file, dest)) { dirty = true; break; }
  }
  if (!dirty) {
    for (const file of filesUnder(targetDir)) {
      if (!sourceSet.has(relative(targetDir, file))) { dirty = true; break; }
    }
  }
  if (!dirty) return 'current';
  pruneExtras(targetDir, sourceSet);
  copyTreeSync(sourceDir, targetDir);
  pruneExtras(targetDir, sourceSet);
  return 'synced';
}

// Sync every preset directory under `presets/` into the target discovery root.
export function syncBundledPresets(targetRoot) {
  const result = { synced: [], current: [], failed: [] };
  const sourceRoot = bundledPresetsRoot();
  mkdirSync(targetRoot, { recursive: true });
  if (existsSync(sourceRoot)) {
    for (const entry of readdirSync(sourceRoot)) {
      const source = join(sourceRoot, entry);
      if (!statSync(source).isDirectory()) continue;
      const id = basename(source);
      try {
        const outcome = syncOnePreset(source, join(targetRoot, id));
        (outcome === 'synced' ? result.synced : result.current).push(id);
      } catch (error) {
        result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return result;
}
