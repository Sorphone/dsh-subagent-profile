// test/evolution-assets.test.mjs — 进化资产域（evolution-assets）单测：落盘/索引/
// 五态流转/过期清扫/幂等判据/原子写/fail-soft/路径穿越防护。用临时目录构造
// createEvolutionAssets，不依赖 index.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvolutionAssets } from '../lib/core/evolution-assets.mjs';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-assets-test-'));
  const warnings = [];
  const governance = [];
  const store = createEvolutionAssets({
    dshHome: dir,
    logger: { warn: (message) => warnings.push(String(message)) },
    onGovernanceFailure: () => governance.push(1),
  });
  return { dir, warnings, governance, store, teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

function makeAsset(id, overrides = {}) {
  return {
    v: 1,
    id,
    source: 'evolution',
    provenance: { generatedAt: 1, basis: {} },
    state: 'draft',
    version: 1,
    expiry: null,
    from: { preset: 'standard' },
    to: { preset: 'code', id },
    axis: 'capability',
    direction: 'down',
    baseline_snapshot: { score: 0.3, n: 3 },
    profile_key: 'preset:standard',
    profile_fingerprint: 'fp-1',
    config: { id, preset: 'code' },
    name: '进化草稿-preset:standard',
    description: '建议：降级能力配置',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('add/list/get：资产落盘（文件 + 索引）并可读回', () => {
  const t = makeStore();
  try {
    const added = t.store.add(makeAsset('evo-down-a'));
    assert.equal(added.persisted, true);
    assert.ok(existsSync(join(t.dir, 'subagent-evolution', 'assets', 'evo-down-a.json')));
    assert.ok(existsSync(join(t.dir, 'subagent-evolution', 'assets', 'assets.index.json')));
    const listed = t.store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].state, 'draft');
    assert.equal(t.store.get('evo-down-a').config.preset, 'code');
  } finally { t.teardown(); }
});

test('transition：draft → proposed（观察占位），状态写入文件与索引', () => {
  const t = makeStore();
  try {
    t.store.add(makeAsset('evo-down-b'));
    const result = t.store.transition('evo-down-b', 'proposed', { applied_at: 2 });
    assert.equal(result.persisted, true);
    assert.equal(t.store.get('evo-down-b').state, 'proposed');
    assert.equal(t.store.get('evo-down-b').applied_at, 2);
    const raw = JSON.parse(readFileSync(join(t.dir, 'subagent-evolution', 'assets', 'evo-down-b.json'), 'utf8'));
    assert.equal(raw.state, 'proposed');
    // 重启（新实例）读同一目录：状态保持。
    const fresh = createEvolutionAssets({ dshHome: t.dir, logger: { warn: () => {} } });
    assert.equal(fresh.get('evo-down-b').state, 'proposed');
  } finally { t.teardown(); }
});

test('sweepExpired：expiry 已过的 draft 置 expired；proposed/未过期不动', () => {
  const t = makeStore();
  try {
    const now = Date.now();
    t.store.add(makeAsset('evo-down-c', { expiry: now - 1000 }));
    t.store.add(makeAsset('evo-down-d', { expiry: now + 60000 }));
    t.store.add(makeAsset('evo-down-e'));
    t.store.transition('evo-down-e', 'proposed');
    const swept = t.store.sweepExpired(now);
    assert.equal(swept, 1);
    assert.equal(t.store.get('evo-down-c').state, 'expired');
    assert.equal(t.store.get('evo-down-d').state, 'draft');
    assert.equal(t.store.get('evo-down-e').state, 'proposed');
  } finally { t.teardown(); }
});

test('hasUnresolved/findUnresolved/countBySource：幂等与护栏判据', () => {
  const t = makeStore();
  try {
    t.store.add(makeAsset('evo-down-f'));
    assert.equal(t.store.hasUnresolved('preset:standard'), true);
    assert.equal(t.store.hasUnresolved('preset:code'), false);
    assert.equal(t.store.findUnresolved('preset:standard').length, 1);
    assert.equal(t.store.countBySource('evolution'), 1);
    t.store.transition('evo-down-f', 'expired');
    assert.equal(t.store.hasUnresolved('preset:standard'), false, 'expired 不再算未处置');
  } finally { t.teardown(); }
});

test('id 白名单：非法 id（含路径穿越形态）一律拒绝/读不到', () => {
  const t = makeStore();
  try {
    const bad = t.store.add(makeAsset('../evil'));
    assert.equal(bad.persisted, false);
    assert.equal(t.store.get('../evil'), undefined);
    assert.equal(t.store.get('..%2Fevil'), undefined);
    assert.equal(t.store.transition('../evil', 'proposed').persisted, false);
  } finally { t.teardown(); }
});

test('fail-soft：索引损坏从零、资产文件缺失跳过、写失败告警 + 治理钩子', () => {
  const t = makeStore();
  try {
    const assetsDir = join(t.dir, 'subagent-evolution', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'assets.index.json'), '{broken', 'utf8');
    const fresh = createEvolutionAssets({ dshHome: t.dir, logger: { warn: () => {} }, onGovernanceFailure: () => {} });
    assert.equal(fresh.list().length, 0, '损坏索引从零，不抛');
    assert.equal(fresh.countBySource('evolution'), 0);
    // 索引存在但资产文件缺失 → 列表跳过该条目。
    writeFileSync(join(assetsDir, 'assets.index.json'), JSON.stringify({ v: 1, assets: [{ id: 'ghost', profileKey: 'x', state: 'draft' }] }), 'utf8');
    const ghost = createEvolutionAssets({ dshHome: t.dir, logger: { warn: () => {} }, onGovernanceFailure: () => {} });
    assert.equal(ghost.list().length, 0, '文件缺失的索引条目跳过');
  } finally { t.teardown(); }
});
