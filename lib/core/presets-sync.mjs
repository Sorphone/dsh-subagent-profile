// lib/core/presets-sync.mjs — bundled agent-preset self-install (moved verbatim from
// index.mjs; node builtins only, no @deepseek-ai dependency).
//
// On host startup the plugin syncs the bundled `presets/` tree into the DSH
// agent-presets discovery root (~/.dsh/.agent-presets) so the "orchestrator"
// mode appears in the new-session picker without manual copying — the same
// self-install pattern as the shipped dsh-liangshen bundle. The sync is
// per-directory and hash-gated: a per-target sidecar (.dsh-sync.json) records
// the bundled content hash and the derived-tree snapshot hash, so the next run
// skips an unchanged tree, skips (never overwrites) a user-modified tree, and
// archives the user side to .user-modified-<timestamp>/ before writing upgraded
// bundled content when both sides changed. Target files the bundle no longer
// ships are pruned; directories the plugin does not own are never touched.
// node:fs cpSync is avoided deliberately: on Node 22 for
// Windows, fs.cpSync({ recursive: true }) can crash the process when a source
// path contains non-ASCII (CJK home dir, nodejs/node#54476), so the copy is
// per-entry, preserving source mtimes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Absolute path of the bundled preset tree inside this package. This module
// lives in lib/core/, two levels below the package root, so the URL must climb
// back up two segments to still point at the repo-root `presets/` directory
// (same resolved value as when this function lived in index.mjs at the package
// root; Task 8.6 moved the module from lib/ to lib/core/ and the climb must be
// `../../`, not `../` — preflight's preset-tree reconciliation caught the stale
// one returning lib/presets, which silently disabled the startup self-install).
export function bundledPresetsRoot() {
  return fileURLToPath(new URL('../../presets', import.meta.url));
}

export const MTIME_TOLERANCE_MS = 1000;

// Sync metadata: the sidecar records the last bundled/target content hash, and
// the archive prefix names three-way user-edit backups. Both are plugin-local
// bookkeeping, not preset content — hashTree excludes them and prune keeps them
// (otherwise the sidecar writing itself would make the target hash drift
// self-referentially, and archives would be pruned).
export const SIDECAR_NAME = '.dsh-sync.json';
export const ARCHIVE_PREFIX = '.user-modified-';

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

// Content hash of the preset tree: each file's path relative to `root` plus its
// bytes, fed into sha1. Sync metadata (the sidecar and any `.user-modified-*`
// archive) is excluded — it is plugin bookkeeping, not preset content, and
// including it would make the derived-tree hash drift the moment the sidecar is
// rewritten (self-referential) or an archive is created.
export function hashTree(root) {
  const hash = createHash('sha1');
  for (const file of filesUnder(root).sort()) {
    const rel = relative(root, file);
    if (isSyncMetadata(rel)) continue;
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// True when a path relative to a preset root is sync metadata (the sidecar file,
// or anything under a `.user-modified-*` archive directory).
export function isSyncMetadata(rel) {
  const head = rel.split(sep)[0];
  return head === SIDECAR_NAME || head.startsWith(ARCHIVE_PREFIX);
}

export function sidecarPath(targetDir) {
  return join(targetDir, SIDECAR_NAME);
}

// Read the sidecar; absent or malformed (wrong version / missing hash fields /
// unparsable) is treated as absent so the next sync takes the conservative
// first-run path rather than trusting broken bookkeeping.
function readSidecar(targetDir) {
  const path = sidecarPath(targetDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && parsed.version === 1 && typeof parsed.bundledHash === 'string' && typeof parsed.targetHash === 'string') {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeSidecar(targetDir, bundledHash, targetHash) {
  writeFileSync(sidecarPath(targetDir), `${JSON.stringify({ version: 1, bundledHash, targetHash }, null, 2)}\n`);
}

// Copy one filesystem entry (file or directory) preserving per-entry semantics
// and source mtimes — same shape as copyTreeSync's own file branch.
function copyEntry(source, dest) {
  const st = statSync(source);
  if (st.isDirectory()) copyTreeSync(source, dest);
  else {
    copyFileSync(source, dest);
    utimesSync(dest, st.atime, st.mtime);
  }
}

// Archive the current (user-facing) preset tree to
// <targetDir>/.user-modified-<timestamp>/ before overwriting it. The sidecar and
// any prior archives are excluded so archives never nest. Returns false when the
// write fails — the caller must then skip the sync and leave user edits intact
// (fail-safe: a failed backup must never be a license to destroy user content).
function archiveUserTree(targetDir) {
  const archiveDir = join(targetDir, `${ARCHIVE_PREFIX}${Date.now()}`);
  // Snapshot the entries to archive BEFORE creating archiveDir: the archive
  // lives under targetDir, so reading the directory again after mkdirSync would
  // include the archive itself and recurse into it forever.
  const entries = [];
  for (const entry of readdirSync(targetDir)) {
    if (entry === SIDECAR_NAME || entry.startsWith(ARCHIVE_PREFIX)) continue;
    entries.push(entry);
  }
  try {
    mkdirSync(archiveDir, { recursive: true });
    for (const entry of entries) {
      copyEntry(join(targetDir, entry), join(archiveDir, entry));
    }
    return true;
  } catch {
    try { rmSync(archiveDir, { recursive: true, force: true }); } catch { /* best effort */ }
    return false;
  }
}

// The keep set for pruneExtras: everything the post-sync tree must retain —
// bundled files, the sidecar, and every file under an existing `.user-modified-*`
// archive. Without the archive entries in keep, pruneExtras would delete the
// archive the moment it syncs, silently discarding the user edits it was meant
// to preserve.
function computeKeep(sourceDir, targetDir) {
  const keep = new Set(filesUnder(sourceDir).map((f) => relative(sourceDir, f)));
  keep.add(SIDECAR_NAME);
  if (existsSync(targetDir)) {
    for (const entry of readdirSync(targetDir)) {
      if (!entry.startsWith(ARCHIVE_PREFIX)) continue;
      const dir = join(targetDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of filesUnder(dir)) keep.add(relative(targetDir, f));
    }
  }
  return keep;
}

// Sync one preset directory. Returns 'synced' (wrote or upgraded), 'current'
// (unchanged), or 'user-modified' (skipped because the target drifted from the
// last-synced snapshot — never overwrite user edits). Decision table:
//   - target absent                     → copy + write sidecar       → 'synced'
//   - no sidecar, target present        → one-time archive + sync    → 'synced'
//   - bundled unchanged, target same    → 'current'
//   - bundled unchanged, target drifted → 'user-modified' (skip)
//   - bundled changed                   → archive if drifted, then sync → 'synced'
export function syncOnePreset(sourceDir, targetDir) {
  const bundledHash = hashTree(sourceDir);
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    // M8：target 意外是文件（同名冲突）时先改名备份再清，避免直接 rmSync 丢失用户内容。
    try { renameSync(targetDir, `${targetDir}.removed-${Date.now()}`); } catch { rmSync(targetDir, { recursive: true, force: true }); }
  }
  if (!existsSync(targetDir)) {
    copyTreeSync(sourceDir, targetDir);
    writeSidecar(targetDir, bundledHash, hashTree(targetDir));
    return 'synced';
  }
  const sidecar = readSidecar(targetDir);
  // No sidecar + existing target = pre-gate state: we cannot tell whether the
  // user edited it, so treat it as possibly edited and archive once before the
  // first gated sync (one-time migration).
  if (sidecar === undefined) {
    if (!archiveUserTree(targetDir)) return 'user-modified';
    copyTreeSync(sourceDir, targetDir);
    pruneExtras(targetDir, computeKeep(sourceDir, targetDir));
    writeSidecar(targetDir, bundledHash, hashTree(targetDir));
    return 'synced';
  }
  const currentTargetHash = hashTree(targetDir);
  if (sidecar.bundledHash === bundledHash) {
    return sidecar.targetHash === currentTargetHash ? 'current' : 'user-modified';
  }
  // Bundled upgraded. If the user also edited the target (target snapshot
  // drifted), archive their tree first so their edits are not silently lost.
  if (sidecar.targetHash !== currentTargetHash) {
    if (!archiveUserTree(targetDir)) return 'user-modified';
  }
  copyTreeSync(sourceDir, targetDir);
  pruneExtras(targetDir, computeKeep(sourceDir, targetDir));
  writeSidecar(targetDir, bundledHash, hashTree(targetDir));
  return 'synced';
}

// Sync every preset directory under `presets/` into the target discovery root.
export function syncBundledPresets(targetRoot) {
  const result = { synced: [], current: [], userModified: [], failed: [] };
  const sourceRoot = bundledPresetsRoot();
  mkdirSync(targetRoot, { recursive: true });
  if (existsSync(sourceRoot)) {
    for (const entry of readdirSync(sourceRoot)) {
      const source = join(sourceRoot, entry);
      if (!statSync(source).isDirectory()) continue;
      const id = basename(source);
      try {
        const outcome = syncOnePreset(source, join(targetRoot, id));
        if (outcome === 'synced') result.synced.push(id);
        else if (outcome === 'current') result.current.push(id);
        else result.userModified.push(id);
      } catch (error) {
        result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return result;
}
