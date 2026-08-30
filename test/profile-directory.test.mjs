// test/profile-directory.test.mjs — 单一数据源（Task 37a）+ 埋点补全（37b 快照侧）。
// 验收：同一 store 状态，profileDirectoryRows 与 profileSnapshotOf 同序同 id；section
// 文本从同一 rows 派生；chosenOutsideSnapshot 与 advice_present 埋点正确。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileDirectoryRows } from '../lib/core/profile-directory.mjs';
import { profileSnapshotOf, requestedOf } from '../lib/core/decision-trace.mjs';

function storeWith(profiles) {
  return { profiles: new Map(profiles.map((p) => [p.id, p])) };
}

test('profileDirectoryRows：enabled 过滤 + cheap-first + 字段集（含 model/provider/avgCost/successRate）', () => {
  const store = storeWith([
    { id: 'premium-x', tokenTier: 'premium', enabled: true, model: 'm3' },
    { id: 'off', tokenTier: 'cheap', enabled: false },
    { id: 'researcher', tokenTier: 'cheap', enabled: true, description: '调研', avgCost: 0.0039, successRate: 0.8 },
    { id: 'swap-standard', tokenTier: 'balanced', enabled: true, preset: 'standard', provider: 'p1', model: 'm1' },
  ]);
  const rows = profileDirectoryRows(store);
  assert.deepEqual(rows.map((r) => r.id), ['researcher', 'swap-standard', 'premium-x']);
  assert.equal(rows[0].avgCost, 0.0039);
  assert.equal(rows[0].successRate, 0.8);
  assert.equal(rows[1].preset, 'standard');
  assert.equal(rows[1].provider, 'p1');
  assert.equal(rows[1].model, 'm1');
});

test('profileDirectoryRows 与 profileSnapshotOf 同源同序（id/顺序一致）', () => {
  const store = storeWith([
    { id: 'b', tokenTier: 'balanced', enabled: true, preset: 'standard' },
    { id: 'a', tokenTier: 'cheap', enabled: true, model: 'm1' },
    { id: 'c', tokenTier: 'premium', enabled: false },
  ]);
  const rows = profileDirectoryRows(store);
  const snap = profileSnapshotOf(rows);
  assert.deepEqual(rows.map((r) => r.id), snap.entries.map((e) => e.id));
  assert.deepEqual(snap.entries.map((e) => e.id), ['a', 'b']);
});

test('profileSnapshotOf：chosenId 超出 maxEntries 仍并入并打 chosenOutsideSnapshot', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i, description: 'd' + i }));
  const snap = profileSnapshotOf(rows, { maxEntries: 3, chosenId: 'p6' });
  assert.equal(snap.total, 8);
  assert.equal(snap.truncated, true);
  assert.equal(snap.entries.length, 4);
  assert.equal(snap.entries[3].id, 'p6');
  assert.equal(snap.entries[3].chosenOutsideSnapshot, true);
});

test('requestedOf：advice_present 埋点（true/false）', () => {
  assert.equal(requestedOf({}, { advicePresent: true }).advice_present, true);
  assert.equal(requestedOf({}, {}).advice_present, false);
});
