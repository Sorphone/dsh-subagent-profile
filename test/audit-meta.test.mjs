// test/audit-meta.test.mjs — 审计分级 + 资产位置纪律。
//   * meta.json round-trip：createEvolutionLedger 的 lostTelemetry/lostGovernance/
//     health 持久化到 <dshHome>/subagent-evolution/ledger.meta.json，新实例同 home
//     加载保持计数与 health。
//   * 两类计数分别：派发台账写失败计 lostTelemetry（health 不降级）；治理写失败
//     （markGovernanceFailure）计 lostGovernance 且 health 置 degraded。
//   * health 恢复：degraded 后一次成功派发写 → 落盘 ok，重启后不再 degraded。
//   * 损坏/形状不符 fail-soft 从零、绝不抛、warn。
//   * 写失败不抛（meta 写失败仅告警）。
//   * settings /options/summary 响应含 audit 字段。
//   * 资产位置：subagent-evolution 以 dshHome 为根，不在 presets/ 源与
//     .agent-presets 目标的 syncBundledPresets 遍历目录清单内（不被同步/裁剪）。
// 隔离 DSH_HOME（makeIsolatedDshHome）避免触碰真实 ~/.dsh。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createEvolutionLedger } from '../lib/core/evolution-ledger.mjs';
import { syncBundledPresets, bundledPresetsRoot } from '../lib/core/presets-sync.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

// 临时 home 目录 + 相关路径；teardown 递归删除。
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-meta-'));
  return {
    dir,
    evolutionDir: join(dir, 'subagent-evolution'),
    metaFile: join(dir, 'subagent-evolution', 'ledger.meta.json'),
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

function readMeta(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// --- 纯工厂层：meta 持久化 / round-trip / 两类计数 / health -------------------

test('meta round-trip：计数与 health 落盘，新实例同 dshHome 加载保持', () => {
  const t = tmpHome();
  try {
    const warn = () => {};
    const a = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn });
    // 派发遥测写失败（台账路径被文件占据）→ lostTelemetry。
    writeFileSync(join(t.dir, 'subagent-evolution'), 'blocker', 'utf8');
    a.record({ child_id: 'c1', mode: 'foreground' });
    assert.equal(a.auditState().lostTelemetry, 1);
    assert.equal(a.auditState().health, 'ok', '遥测丢失不降级 health');
    // 治理失败 → lostGovernance + degraded。meta 落盘仍可用（路径冲突只影响 dispatch）。
    rmSync(join(t.dir, 'subagent-evolution'), { force: true });
    a.markGovernanceFailure();
    const written = readMeta(t.metaFile);
    assert.equal(written.v, 1);
    assert.equal(written.lostTelemetry, 1);
    assert.equal(written.lostGovernance, 1);
    assert.equal(written.health, 'degraded');
    assert.equal(typeof written.last_write_ts, 'number', '落盘带 last_write_ts（§12.4）');
    // 新实例：计数与 health 从文件保持（last_write_ts 旧文件缺失时回退 0）。
    const b = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: () => {} });
    assert.deepEqual(b.auditState(), { lostTelemetry: 1, lostGovernance: 1, health: 'degraded' });
    assert.equal(b.metaHealth(), 'degraded', 'metaHealth 读取持久化 degraded');
    // 旧格式 meta（无 last_write_ts）加载不崩、回退 0。
    writeFileSync(t.metaFile, JSON.stringify({ v: 1, lostTelemetry: 2, lostGovernance: 0, health: 'ok' }), 'utf8');
    const c = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: () => {} });
    assert.equal(c.auditState().lostTelemetry, 2, '旧格式兼容读取');
    c.markGovernanceFailure();
    assert.equal(typeof readMeta(t.metaFile).last_write_ts, 'number', '再次落盘补上 last_write_ts');
  } finally { t.cleanup(); }
});

test('损坏 meta：fail-soft 从零、不 throw、warn', () => {
  const t = tmpHome();
  try {
    mkdirSync(t.evolutionDir, { recursive: true });
    writeFileSync(t.metaFile, '{ not json', 'utf8');
    const warns = [];
    const ledger = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: (m) => warns.push(m) });
    assert.deepEqual(ledger.auditState(), { lostTelemetry: 0, lostGovernance: 0, health: 'ok' });
    assert.equal(ledger.metaHealth(), 'ok');
    assert.ok(warns.length >= 1, '损坏 meta 必须 warn');
  } finally { t.cleanup(); }
});

test('形状不符 meta（缺字段/坏 health）：fail-soft 从零重建', () => {
  const t = tmpHome();
  try {
    mkdirSync(t.evolutionDir, { recursive: true });
    writeFileSync(t.metaFile, JSON.stringify({ v: 1, lostTelemetry: 5 }), 'utf8');
    const ledger = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: () => {} });
    assert.deepEqual(ledger.auditState(), { lostTelemetry: 0, lostGovernance: 0, health: 'ok' }, '缺字段按默认重建');
    writeFileSync(t.metaFile, JSON.stringify({ v: 1, lostTelemetry: 0, lostGovernance: 0, health: 'wacky' }), 'utf8');
    const b = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: () => {} });
    assert.equal(b.metaHealth(), 'ok', '非法 health 按默认恢复 ok');
  } finally { t.cleanup(); }
});

test('health 恢复：degraded 后一次成功派发写 → 落盘 ok，重载不再 degraded', () => {
  const t = tmpHome();
  try {
    const warn = () => {};
    const a = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn });
    writeFileSync(join(t.dir, 'subagent-evolution'), 'blocker', 'utf8');
    a.record({ child_id: 'lost' });
    rmSync(join(t.dir, 'subagent-evolution'), { force: true });
    a.markGovernanceFailure();
    assert.equal(a.metaHealth(), 'degraded');
    // 一次成功派发写 → health 恢复 ok 并落盘。
    a.record({ child_id: 'recovered' });
    assert.equal(a.metaHealth(), 'ok');
    assert.equal(readMeta(t.metaFile).health, 'ok', '恢复 ok 必须持久化');
    const b = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn: () => {} });
    assert.deepEqual(b.auditState(), { lostTelemetry: 1, lostGovernance: 1, health: 'ok' }, '计数保持，health 恢复 ok');
  } finally { t.cleanup(); }
});

test('两类计数分别累加：遥测失败只加 lostTelemetry，治理失败只加 lostGovernance', () => {
  const t = tmpHome();
  try {
    const warn = () => {};
    const a = createEvolutionLedger({ dshHome: t.dir, pluginVersion: '0.3.2', warn });
    writeFileSync(join(t.dir, 'subagent-evolution'), 'blocker', 'utf8');
    a.record({ child_id: 'c1' });
    a.record({ child_id: 'c2' });
    assert.deepEqual(a.auditState(), { lostTelemetry: 2, lostGovernance: 0, health: 'ok' }, '遥测失败只加 lostTelemetry');
    rmSync(join(t.dir, 'subagent-evolution'), { force: true });
    a.markGovernanceFailure();
    a.markGovernanceFailure();
    assert.deepEqual(a.auditState(), { lostTelemetry: 2, lostGovernance: 2, health: 'degraded' }, '治理失败只加 lostGovernance');
  } finally { t.cleanup(); }
});

test('meta 写失败：markGovernanceFailure 不 throw，内存 degraded 保持', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-audit-meta-'));
  // meta 父路径为普通文件 → persistMeta 抛 ENOTDIR，fail-soft 只 warn。
  writeFileSync(join(root, 'subagent-evolution'), 'blocker', 'utf8');
  const warns = [];
  try {
    const ledger = createEvolutionLedger({ dshHome: root, pluginVersion: '0.3.2', warn: (m) => warns.push(m) });
    assert.doesNotThrow(() => ledger.markGovernanceFailure());
    assert.equal(ledger.metaHealth(), 'degraded', '写失败仍保留内存 degraded 标记（不降回 ok）');
    assert.equal(ledger.auditState().lostGovernance, 1);
    assert.ok(warns.length >= 1, 'meta 写失败必须 warn');
  } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// --- 装配层：settings /options/summary 含 audit 字段 ---------------------------

async function setupApp() {
  const { webServer, routes } = makeRouteHarness();
  const { ctx } = createFakeCtx({ services: { webServer } });
  await mod.apply(ctx);
  return { handler: routes[0].handler };
}

test('settings /options/summary 响应含 audit 字段（ok 默认态）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler } = await setupApp();
    const resp = await callRoute(handler, 'GET', '/options/summary');
    assert.equal(resp.code, 200);
    assert.equal(resp.json.ok, true);
    assert.ok(resp.json.audit, 'summary 必须含 audit 字段');
    assert.deepEqual(resp.json.audit, { lostTelemetry: 0, lostGovernance: 0, health: 'ok' });
  } finally { iso.restore(); iso.teardown(); }
});

test('装配治理写失败：/add 持久化失败 → audit degraded + P0 提醒 mint（lostGovernance 计两次审计写失败）', async () => {
  // DSH_HOME 指向 blocker 文件下，subagent-profiles.json 写失败 → persistProfiles false。
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-audit-meta-'));
  const blockerFile = join(tmpRoot, 'blocker');
  writeFileSync(blockerFile, 'x', 'utf8');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(blockerFile, 'dsh');
  try {
    const { handler } = await setupApp();
    const add = await callRoute(handler, 'POST', '/add', { id: 'x', name: 'n' });
    assert.equal(add.json.persisted, false, 'profiles 写失败上报 persisted:false');
    const summary = await callRoute(handler, 'GET', '/options/summary');
    assert.equal(summary.json.audit.health, 'degraded', '治理写失败 health 置 degraded');
    // 提醒系统接线后：profile 持久化失败（+1）+ 降级提醒的审计写失败（+1，degraded 下
    // 审计通道同样不可写）→ 两次独立审计丢失，不再恒等于 1。
    assert.equal(summary.json.audit.lostGovernance, 2);
    assert.equal(summary.json.audit.lostTelemetry, 0);
    // 降级 P0 提醒经内存 store 可见（/reminders 与 [6] 审计同源）。
    const reminders = await callRoute(handler, 'GET', '/reminders');
    assert.ok(reminders.json.reminders.some((r) => r.severity === 'P0' && r.kind === 'audit-degraded' && r.unread === true), 'degraded 必须 mint P0 未读提醒');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --- 资产位置纪律：subagent-evolution 不在 preset 同步/裁剪路径内 --------------

test('资产位置：evolution 资产以 dshHome 为根，不在 .agent-presets 之下', () => {
  // 路径派生纪律断言：evolution 资产根 = dshHome/subagent-evolution，与 preset
  // 同步目标（dshHome/.agent-presets）是同根兄弟目录而非其子目录。用 path.sep 做
  // 真实子目录前缀判定（startsWith 的裸字符串拼接会漏检跨目录边界）。
  const home = mkdtempSync(join(tmpdir(), 'dsh-audit-meta-'));
  try {
    const evoDir = join(home, 'subagent-evolution');
    const presetsRoot = join(home, '.agent-presets');
    assert.ok(!evoDir.startsWith(`${presetsRoot}${sep}`), 'evolution 资产不得位于 .agent-presets 下');
    assert.ok(evoDir.startsWith(home), 'evolution 资产以 dshHome 为根');
    assert.ok(join(home, 'subagent-evolution', 'ledger.meta.json').startsWith(home), 'meta 与台账同根于 dshHome');
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } }
});

test('preset 树：bundled 含 orchestrator-v2 五文件、旧 orchestrator 目录已删除', () => {
  // V2 收编：presets/orchestrator-v2/ 五文件齐全；presets/orchestrator/ 已 git rm
  // （bundled 源清单里不得再出现旧名）。
  const srcEntries = readdirSync(bundledPresetsRoot());
  assert.ok(!srcEntries.includes('orchestrator'), '旧 bundled orchestrator 目录已删除（V2 取代）');
  assert.ok(srcEntries.includes('orchestrator-v2'), 'bundled orchestrator-v2 目录存在');
  const v2Entries = readdirSync(join(bundledPresetsRoot(), 'orchestrator-v2')).sort();
  assert.deepEqual(
    v2Entries,
    ['NOTICE', 'agent.cordis.yml', 'custom-bash.mjs', 'preset.yml', 'tool-bootstrap.mjs'].sort(),
    'orchestrator-v2 五文件齐全'
  );
});

test('资产位置：syncBundledPresets 源/目标目录清单不含 subagent-evolution', () => {
  // 源侧：打包的 presets/ 根目录条目里不得出现 subagent-evolution。
  const srcEntries = readdirSync(bundledPresetsRoot());
  assert.ok(!srcEntries.includes('subagent-evolution'), 'presets/ 源清单不得含 subagent-evolution');
  // 目标侧：syncBundledPresets 返回的同步/保留清单只含 presets/ 下目录 id，
  // 不得含 subagent-evolution（evolution 资产不被同步、不被裁剪）。
  const target = mkdtempSync(join(tmpdir(), 'dsh-audit-target-'));
  try {
    const result = syncBundledPresets(target);
    // 非空断言：presets/ 现含 orchestrator-v2——若未来 bundled 树清空，下面的排除
    // 断言会静默空转，故先锁定本次同步确有产物。
    assert.ok(result.synced.includes('orchestrator-v2'), '同步产物非空（orchestrator-v2 存在）');
    const listed = [...result.synced, ...result.current, ...result.userModified, ...result.failed.map((f) => f.id)];
    assert.ok(!listed.includes('subagent-evolution'), '同步的 preset 清单不得含 subagent-evolution');
    const targetEntries = readdirSync(target);
    assert.ok(!targetEntries.includes('subagent-evolution'), '.agent-presets 目标下不得出现 subagent-evolution');
    assert.ok(existsSync(target), '目标同步产物存在');
  } finally { try { rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ } }
});
