// lib/core/drafts-store.mjs — auto-profile S1 draft 容器（Task 43）。
// 与生产注册表 subagent-profiles.json 隔离：draft 只写 subagent-evolution/drafts.json，
// 未经人确认并过闸不得进入 profiles Map。原子写（tmp+rename），损坏 fail-soft 从空。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function loadDrafts(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.drafts)) {
      return parsed.drafts.filter((d) => d !== null && typeof d === 'object' && typeof d.id === 'string');
    }
  } catch { /* fail-soft 从空 */ }
  return [];
}

function createDraftsStore({ dshHome, onGovernanceFailure = () => {} } = {}) {
  const dir = join(dshHome, 'subagent-evolution');
  const file = join(dir, 'drafts.json');
  const drafts = loadDrafts(file);
  const persist = () => {
    const tmp = file + '.tmp';
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify({ v: 1, drafts }, null, 2), 'utf8');
      renameSync(tmp, file);
      return { persisted: true };
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      onGovernanceFailure();
      return { persisted: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    list: () => drafts.map((d) => ({ ...d })),
    get: (id) => { const d = drafts.find((x) => x.id === id); return d === undefined ? undefined : { ...d }; },
    add: (draft) => { drafts.push(draft); return persist(); },
    remove: (id) => { const i = drafts.findIndex((x) => x.id === id); if (i < 0) return { persisted: true, removed: false }; drafts.splice(i, 1); return { ...persist(), removed: true }; },
    clear: () => { drafts.length = 0; },
  };
}

export { createDraftsStore };