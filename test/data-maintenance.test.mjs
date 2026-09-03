// test/data-maintenance.test.mjs — 数据维护清理（B8）：一个入口四区。
// ① 候选/建议清理（进化资产域全清 + data-cleared 审计）② 快照清理（data-cleared，
// 快照域集成在 snapshots.test.mjs 覆盖）③ 提醒中心已处理归档（只移出活动列表，
// 存储与 governance-audit 保留 + reminder-archived 审计 + 归档视图分页）④ 重置统计
// （dispatch.jsonl 封存 dispatch-archive-<ts>.jsonl、历史台账归档保留、summaries
// 置空重建 + stats-reset 审计）。隔离 DSH_HOME 真删/真轮转验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEvolutionAssets } from '../lib/core/evolution-assets.mjs';
import { createReminderStore } from '../lib/core/reminder-store.mjs';
import { writeSummaries } from '../lib/core/evolution-summary.mjs';
import { createDataMaintenance } from '../lib/core/data-maintenance.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

function auditLines(iso) {
  const file = join(iso.dir, 'subagent-evolution', 'governance-audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : [];
}

// --- ① 候选清理（进化资产域）---------------------------------------------------------

test('候选清理：进化资产域全清 + data-cleared(target=candidates) 审计', () => {
  const iso = makeIsolatedDshHome();
  try {
    const audits = [];
    const assets = createEvolutionAssets({ dshHome: iso.dir });
    assets.add({ v: 1, id: 'a1', source: 'evolution', state: 'draft', profile_key: 'k1', createdAt: Date.now(), updatedAt: Date.now() });
    assets.add({ v: 1, id: 'a2', source: 'evolution', state: 'proposed', profile_key: 'k2', createdAt: Date.now(), updatedAt: Date.now() });
    assert.equal(assets.list().length, 2);
    const maintenance = createDataMaintenance({
      dispatchFile: join(iso.dir, 'subagent-evolution', 'dispatch.jsonl'),
      summariesFile: join(iso.dir, 'subagent-evolution', 'summaries.json'),
      evolution: { purgeCandidates: () => assets.purgeAll() },
      recordAudit: (e) => audits.push(e),
    });
    const result = maintenance.clean('candidates');
    assert.deepEqual(result, { count: 2 });
    assert.equal(assets.list().length, 0, '资产全清');
    const dir = join(iso.dir, 'subagent-evolution', 'assets');
    const left = existsSync(dir) ? readdirSync(dir).filter((f) => f !== 'assets.index.json') : [];
    assert.deepEqual(left, [], '资产文件物理删除');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].kind, 'data-cleared');
    assert.equal(audits[0].target, 'candidates');
    assert.equal(audits[0].count, 2);
    assert.ok(Number.isFinite(audits[0].ts));
  } finally { iso.restore(); iso.teardown(); }
});

// --- ③ 提醒归档（只归档不物理删除 + 分页）---------------------------------------------

test('提醒归档：已处理移入归档视图（活动列表移除）、存储保留、分页加载、reminder-archived 审计', () => {
  const iso = makeIsolatedDshHome();
  try {
    const audits = [];
    const store = createReminderStore({ dshHome: iso.dir, audit: (e) => audits.push(e) });
    const acted = [];
    for (let i = 0; i < 5; i += 1) {
      const r = store.record({ severity: 'P2', kind: 'x', title: `t${i}`, detail: 'd', sessionId: null });
      store.actOn(r.id, 'dismiss');
      acted.push(r);
    }
    store.record({ severity: 'P1', kind: 'y', title: 'pending', detail: 'd', sessionId: null });
    const maintenance = createDataMaintenance({
      dispatchFile: join(iso.dir, 'subagent-evolution', 'dispatch.jsonl'),
      summariesFile: join(iso.dir, 'subagent-evolution', 'summaries.json'),
      reminderStore: store,
      recordAudit: (e) => audits.push(e),
    });
    const result = maintenance.clean('reminders');
    assert.deepEqual(result, { count: 5 }, '只归档已处理条目');
    assert.equal(store.list().length, 1, '活动列表只留未处理条目');
    const page1 = store.listArchived({ offset: 0, limit: 2 });
    assert.equal(page1.total, 5);
    assert.equal(page1.reminders.length, 2, '分页 limit 生效');
    assert.equal(page1.offset, 0);
    const page2 = store.listArchived({ offset: 2, limit: 2 });
    assert.equal(page2.reminders.length, 2, '分页 offset 生效');
    const page3 = store.listArchived({ offset: 4, limit: 2 });
    assert.equal(page3.reminders.length, 1, '末页不满一页');
    assert.ok(page1.reminders.every((r) => r.archived === true));
    // 存储保留：reminders.json 里归档条目仍在（绝不物理删除）。
    const fileText = readFileSync(join(iso.dir, 'subagent-evolution', 'reminders.json'), 'utf8');
    for (const r of acted) assert.ok(fileText.includes(r.id), '归档条目存储保留');
    const archiveAudit = audits.find((e) => e.kind === 'reminder-archived');
    assert.ok(archiveAudit !== undefined, '归档审计');
    assert.equal(archiveAudit.target, 'reminders');
    assert.equal(archiveAudit.count, 5);
  } finally { iso.restore(); iso.teardown(); }
});

// --- ④ 重置统计（台账轮转封存 + summaries 置空重建）-----------------------------------

test('重置统计：dispatch.jsonl 封存为 dispatch-archive-<ts>.jsonl（历史保留）、活动台账空、summaries 置空 + stats-reset 审计', () => {
  const iso = makeIsolatedDshHome();
  try {
    const dir = join(iso.dir, 'subagent-evolution');
    const dispatchFile = join(dir, 'dispatch.jsonl');
    const summariesFile = join(dir, 'summaries.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(dispatchFile, '{"line":1}\n{"line":2}\n', 'utf8');
    writeSummaries(summariesFile, { l1: { k1: { n: 9 } }, l2: {} });
    const audits = [];
    const maintenance = createDataMaintenance({ dispatchFile, summariesFile, recordAudit: (e) => audits.push(e), logger: { warn: () => {} } });
    const result = maintenance.clean('stats');
    assert.equal(result.count, 2, '封存行数');
    assert.ok(typeof result.archivedFile === 'string' && result.archivedFile.startsWith('dispatch-archive-'), '归档文件名');
    assert.equal(readFileSync(dispatchFile, 'utf8'), '', '活动台账从空重建');
    const archived = readFileSync(join(dir, result.archivedFile), 'utf8');
    assert.equal(archived, '{"line":1}\n{"line":2}\n', '历史台账归档保留（决策留痕不删）');
    const summaries = JSON.parse(readFileSync(summariesFile, 'utf8'));
    assert.deepEqual(summaries.l1, {}, '统计从零开始（l1 置空重建）');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].kind, 'stats-reset');
    assert.equal(audits[0].target, 'stats');
    assert.equal(audits[0].count, 2);
    assert.equal(audits[0].archivedFile, result.archivedFile);
    // 重复重置：空台账封存跳过、归档名不与轮转封存件模式冲突。
    const again = maintenance.clean('stats');
    assert.equal(again.count, 0);
    assert.equal(again.archivedFile, null, '无内容不封存');
  } finally { iso.restore(); iso.teardown(); }
});

// --- 路由层：一个入口四区 + 提醒归档视图分页 --------------------------------------------

test('路由：/maintenance/clean 四区（candidates/snapshots/reminders/stats）+ /reminders/archived 分页 + 非法 zone 400', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeRouteHarness();
    const { ctx } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const handler = routes[0].handler;
    for (const zone of ['candidates', 'snapshots', 'reminders', 'stats']) {
      const resp = await callRoute(handler, 'POST', '/maintenance/clean', { zone });
      assert.equal(resp.code, 200, `zone ${zone} 必须 200`);
      assert.equal(resp.json.ok, true);
      assert.equal(resp.json.zone, zone);
      assert.ok(Number.isFinite(resp.json.count));
    }
    const bad = await callRoute(handler, 'POST', '/maintenance/clean', { zone: 'bogus' });
    assert.equal(bad.code, 400, '非法 zone 400');
    const empty = await callRoute(handler, 'POST', '/maintenance/clean', {});
    assert.equal(empty.code, 400, '缺 zone 400');
    const archived = await callRoute(handler, 'GET', '/reminders/archived?offset=0&limit=10');
    assert.equal(archived.code, 200);
    assert.equal(archived.json.ok, true);
    assert.ok(Array.isArray(archived.json.reminders));
    assert.equal(archived.json.total, 0);
    assert.equal(archived.json.limit, 10, '分页参数透传');
    // 四个清理 audit kind 全部落治理审计。
    const audits = auditLines(iso);
    const kinds = audits.map((a) => a.kind);
    assert.ok(kinds.includes('data-cleared'), '候选/快照清理审计');
    assert.ok(kinds.includes('reminder-archived'), '提醒归档审计');
    assert.ok(kinds.includes('stats-reset'), '统计重置审计');
    const cleared = audits.filter((a) => a.kind === 'data-cleared');
    assert.deepEqual(cleared.map((a) => a.target).sort(), ['candidates', 'snapshots'], 'data-cleared 覆盖候选与快照两区');
    const reset = audits.find((a) => a.kind === 'stats-reset');
    assert.ok(Number.isFinite(reset.ts), '审计带 ts');
  } finally { iso.restore(); iso.teardown(); }
});
