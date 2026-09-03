// test/label-preset-sync.test.mjs — label 去敏（dispatchLabel 纯函数 + execute
// 级三分支 label 不含 prompt 原文）+ 预设同步保护（hash 门控 sidecar + 三向双改
// 留档 + prune 保留 sidecar/档案、不碰非插件目录）。
// 覆盖：
//   * dispatchLabel：哈希稳定 / 字段省略（profile→inline、preset inherit 省略、
//     model 缺失省略）/ 不含 prompt 原文。
//   * execute 级：前台 / 后台 / continuable 三处 label 均不含 prompt 原文且等于
//     dispatchLabel 输出。
//   * presets-sync：首轮留档 / user-modified 不覆盖 / 双改留档含用户内容 /
//     幂等 current / sidecar 不被 prune / 非插件目录不碰 / hashTree 排除元数据。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchLabel } from '../lib/core/pure.mjs';
import { syncOnePreset, syncBundledPresets, bundledPresetsRoot, hashTree, pruneExtras, SIDECAR_NAME, ARCHIVE_PREFIX } from '../lib/core/presets-sync.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

function sha1_8(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8);
}

// ---- dispatchLabel 纯函数 ------------------------------------------------------

test('dispatchLabel：结构化段 + prompt sha1 前 8 位（哈希稳定）', () => {
  const args = { prompt: 'hello world', profile: 'researcher' };
  const merged = { preset: 'standard', model: 'm1' };
  const expected = `dispatch:researcher standard m1 #${sha1_8('hello world')}`;
  assert.equal(dispatchLabel(args, merged), expected);
  assert.equal(dispatchLabel(args, merged), expected, '同一输入哈希稳定');
});

test('dispatchLabel：字段省略（profile→inline、preset inherit/缺失省略、model 缺失省略）', () => {
  assert.equal(dispatchLabel({ prompt: 'x' }, {}), `dispatch:(inline) #${sha1_8('x')}`);
  assert.equal(dispatchLabel({ prompt: 'x', profile: 'p' }, { preset: 'inherit' }), `dispatch:p #${sha1_8('x')}`);
  assert.equal(dispatchLabel({ prompt: 'x', profile: 'p' }, { preset: 's' }), `dispatch:p s #${sha1_8('x')}`);
  assert.equal(dispatchLabel({ prompt: 'x', profile: 'p' }, { model: 'm' }), `dispatch:p m #${sha1_8('x')}`);
  assert.equal(dispatchLabel({ prompt: 'x' }, { preset: 's', model: 'm' }), `dispatch:(inline) s m #${sha1_8('x')}`);
});

test('dispatchLabel：不含 prompt 原文（仅结构化段 + 哈希）', () => {
  const label = dispatchLabel(
    { prompt: 'TOP-SECRET-CREDENTIAL-abc', profile: 'p', preset: 's', model: 'm' },
    { preset: 's', model: 'm' }
  );
  assert.doesNotMatch(label, /TOP-SECRET-CREDENTIAL-abc/);
  assert.match(label, /^dispatch:p s m #[0-9a-f]{8}$/);
});

// ---- execute 级：三分支 label 不含 prompt 原文 -----------------------------------

function dispatchTool(records) {
  const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
  assert.ok(tool, 'apply() 必须注册 dispatch 工具');
  return tool;
}

function makeForegroundParent() {
  return { ctx: { get: () => undefined }, options: {}, session: { header: { id: 'parent-fg' } } };
}

function makeContinuableParent() {
  const llm = {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    resolveCallConfig: async () => ({}),
  };
  return {
    ctx: {
      get: (name) => (name === 'llm' ? llm : undefined),
      tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
    },
    options: {},
    session: { header: { id: 'parent-cont' } },
  };
}

test('execute 前台：子会话 label 不含 prompt 原文（等于 dispatchLabel 输出）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    let capturedLabel;
    const subagentsStart = async (_provider, request) => {
      capturedLabel = request.label;
      return {
        id: 'child-1',
        result: { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
        localAgent: { session: { events: [] } },
        dispose: async () => {},
      };
    };
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    await tool.execute({ prompt: 'SECRET-FG-PROMPT', preset: 'standard' }, { agent: makeForegroundParent(), signal: undefined });
    assert.equal(capturedLabel, dispatchLabel({ prompt: 'SECRET-FG-PROMPT', preset: 'standard' }, { preset: 'standard' }), 'label 即 dispatchLabel 输出');
    assert.doesNotMatch(capturedLabel, /SECRET-FG-PROMPT/, 'label 不含 prompt 原文');
    assert.match(capturedLabel, /^dispatch:\(inline\) standard #[0-9a-f]{8}$/);
  } finally { iso.restore(); iso.teardown(); }
});

test('execute 后台：jobs.start label 不含 prompt 原文', async () => {
  const iso = makeIsolatedDshHome();
  try {
    let capturedLabel;
    const jobs = {
      start: (config) => {
        capturedLabel = config.label;
        return 'job-1';
      },
    };
    const { ctx, records } = createFakeCtx({ services: { jobs } });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    await tool.execute({ prompt: 'SECRET-BG-PROMPT', preset: 'standard', run_in_background: true }, { agent: makeForegroundParent(), signal: undefined });
    assert.equal(capturedLabel, dispatchLabel({ prompt: 'SECRET-BG-PROMPT', preset: 'standard' }, { preset: 'standard' }), 'label 即 dispatchLabel 输出');
    assert.doesNotMatch(capturedLabel, /SECRET-BG-PROMPT/, 'label 不含 prompt 原文');
  } finally { iso.restore(); iso.teardown(); }
});

test('execute continuable：startContinuable label 不含 prompt 原文', async () => {
  const iso = makeIsolatedDshHome();
  try {
    let capturedLabel;
    const startContinuable = async (config) => {
      capturedLabel = config.label;
      return { childId: 'child-1' };
    };
    const { ctx, records } = createFakeCtx({ startContinuable });
    await mod.apply(ctx);
    const tool = dispatchTool(records);
    await tool.execute(
      { prompt: 'SECRET-CONT-PROMPT', continuable: true, preset: 'standard' },
      { agent: makeContinuableParent(), signal: undefined }
    );
    assert.equal(capturedLabel, dispatchLabel({ prompt: 'SECRET-CONT-PROMPT', continuable: true, preset: 'standard' }, { preset: 'standard' }), 'label 即 dispatchLabel 输出');
    assert.doesNotMatch(capturedLabel, /SECRET-CONT-PROMPT/, 'label 不含 prompt 原文');
  } finally { iso.restore(); iso.teardown(); }
});

// ---- presets-sync：hash 门控 + 三向留档 ----------------------------------------

function makeSyncFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-preset-sync-'));
  return {
    root,
    source: join(root, 'source'),
    target: join(root, 'target'),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function writeTree(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

function archiveDirs(target) {
  return readdirSync(target).filter((e) => e.startsWith(ARCHIVE_PREFIX) && statSync(join(target, e)).isDirectory());
}

test('presets-sync：无 sidecar 且目标存在 → 首轮留档 + 同步', () => {
  const f = makeSyncFixture();
  try {
    writeTree(f.source, { 'preset.yml': 'bundled: v1\n' });
    writeTree(f.target, { 'preset.yml': 'bundled: v1 (USER EDITED)\n', 'user-extra.txt': 'user file\n' });
    assert.equal(syncOnePreset(f.source, f.target), 'synced');
    assert.equal(readFileSync(join(f.target, 'preset.yml'), 'utf8'), 'bundled: v1\n', '目标已同步为 bundled 内容');
    assert.equal(existsSync(join(f.target, 'user-extra.txt')), false, '用户多余文件被 prune');
    assert.ok(existsSync(join(f.target, SIDECAR_NAME)), 'sidecar 已写入');
    const archives = archiveDirs(f.target);
    assert.equal(archives.length, 1, '首轮留档生成一个档案目录');
    const archive = join(f.target, archives[0]);
    assert.equal(readFileSync(join(archive, 'preset.yml'), 'utf8'), 'bundled: v1 (USER EDITED)\n', '档案含用户改动内容');
    assert.equal(readFileSync(join(archive, 'user-extra.txt'), 'utf8'), 'user file\n', '档案含用户额外文件');
  } finally { f.cleanup(); }
});

test('presets-sync：bundled 未变 + 目标已改 → user-modified 不覆盖', () => {
  const f = makeSyncFixture();
  try {
    writeTree(f.source, { 'preset.yml': 'bundled: v1\n' });
    assert.equal(syncOnePreset(f.source, f.target), 'synced');
    writeFileSync(join(f.target, 'preset.yml'), 'bundled: v1 (USER EDITED)\n');
    assert.equal(syncOnePreset(f.source, f.target), 'user-modified');
    assert.equal(readFileSync(join(f.target, 'preset.yml'), 'utf8'), 'bundled: v1 (USER EDITED)\n', '用户改动未被覆盖');
  } finally { f.cleanup(); }
});

test('presets-sync：双改（bundled 升级 + 用户改过）→ 留档含用户内容后同步', () => {
  const f = makeSyncFixture();
  try {
    writeTree(f.source, { 'preset.yml': 'bundled: v1\n' });
    assert.equal(syncOnePreset(f.source, f.target), 'synced');
    writeFileSync(join(f.target, 'preset.yml'), 'bundled: v1 (USER EDITED)\n');
    writeTree(f.source, { 'preset.yml': 'bundled: v2\n', 'new-file.yml': 'new\n' });
    assert.equal(syncOnePreset(f.source, f.target), 'synced');
    assert.equal(readFileSync(join(f.target, 'preset.yml'), 'utf8'), 'bundled: v2\n', '目标已升级到新 bundled');
    assert.ok(existsSync(join(f.target, 'new-file.yml')), '新 bundled 文件已写入');
    const archives = archiveDirs(f.target);
    assert.equal(archives.length, 1, '双改留档生成一个档案');
    assert.equal(readFileSync(join(f.target, archives[0], 'preset.yml'), 'utf8'), 'bundled: v1 (USER EDITED)\n', '档案保留用户改动内容');
  } finally { f.cleanup(); }
});

test('presets-sync：幂等 current（无变更连续同步返回 current，sidecar 不被 prune）', () => {
  const f = makeSyncFixture();
  try {
    writeTree(f.source, { 'preset.yml': 'bundled: v1\n' });
    assert.equal(syncOnePreset(f.source, f.target), 'synced');
    assert.equal(syncOnePreset(f.source, f.target), 'current');
    assert.equal(syncOnePreset(f.source, f.target), 'current');
    assert.ok(existsSync(join(f.target, SIDECAR_NAME)), 'sidecar 仍在（未被 prune）');
  } finally { f.cleanup(); }
});

test('presets-sync：pruneExtras 保留 keep 集中的 sidecar', () => {
  const f = makeSyncFixture();
  try {
    writeTree(f.target, { 'preset.yml': 'x\n', [SIDECAR_NAME]: '{"version":1}' });
    pruneExtras(f.target, new Set(['preset.yml', SIDECAR_NAME]));
    assert.ok(existsSync(join(f.target, SIDECAR_NAME)), 'sidecar 被 keep 保留');
    assert.ok(existsSync(join(f.target, 'preset.yml')), 'bundled 文件保留');
  } finally { f.cleanup(); }
});

test('presets-sync：不碰目标目录外的其它目录（非插件目录）', () => {
  const f = makeSyncFixture();
  try {
    writeTree(f.source, { 'preset.yml': 'bundled: v1\n' });
    const sibling = join(f.root, 'other-plugin');
    writeTree(sibling, { 'keep.yml': 'do not touch\n' });
    assert.equal(syncOnePreset(f.source, f.target), 'synced');
    assert.equal(readFileSync(join(sibling, 'keep.yml'), 'utf8'), 'do not touch\n', '兄弟目录内容不变');
  } finally { f.cleanup(); }
});

test('hashTree：sidecar/档案不计入内容哈希（不自指）', () => {
  const f = makeSyncFixture();
  try {
    writeTree(f.source, { 'a.yml': '1\n' });
    const before = hashTree(f.source);
    writeTree(f.target, { 'a.yml': '1\n', [SIDECAR_NAME]: '{"version":1,"bundledHash":"x","targetHash":"y"}' });
    assert.equal(hashTree(f.target), before, 'sidecar 不影响内容哈希');
  } finally { f.cleanup(); }
});

// ---- presets-sync：bundled orchestrator-v2 自装 + 旧 orchestrator 收编归档 ---------

test('presets-sync：空发现根 → 自装 orchestrator-v2（与 bundled 字节一致 + sidecar）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundled-sync-'));
  try {
    const target = join(root, '.agent-presets');
    const result = syncBundledPresets(target);
    assert.ok(result.synced.includes('orchestrator-v2'), '空根自装 orchestrator-v2');
    assert.equal(result.failed.length, 0, '同步无失败');
    const sourceDir = join(bundledPresetsRoot(), 'orchestrator-v2');
    const targetDir = join(target, 'orchestrator-v2');
    assert.equal(hashTree(targetDir), hashTree(sourceDir), '派生树与 bundled 内容哈希一致（hash 校验）');
    assert.ok(existsSync(join(targetDir, SIDECAR_NAME)), 'sidecar 已写入');
    for (const entry of readdirSync(sourceDir)) {
      assert.ok(readFileSync(join(targetDir, entry)).equals(readFileSync(join(sourceDir, entry))), `${entry} 字节一致`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('presets-sync：orchestrator-v2 同内容二次同步 → current 跳过（不重写文件）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundled-sync-'));
  try {
    const target = join(root, '.agent-presets');
    assert.ok(syncBundledPresets(target).synced.includes('orchestrator-v2'));
    const probe = join(target, 'orchestrator-v2', 'preset.yml');
    const mtime = statSync(probe).mtimeMs;
    const second = syncBundledPresets(target);
    assert.ok(second.current.includes('orchestrator-v2'), '同内容 → current（跳过写入）');
    assert.equal(statSync(probe).mtimeMs, mtime, '二次同步不重写文件（mtime 不变）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('presets-sync：用户改过的 orchestrator-v2 → user-modified 跳过（不覆盖）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundled-sync-'));
  try {
    const target = join(root, '.agent-presets');
    assert.ok(syncBundledPresets(target).synced.includes('orchestrator-v2'));
    writeFileSync(join(target, 'orchestrator-v2', 'preset.yml'), 'name: 用户自改\n', 'utf8');
    const second = syncBundledPresets(target);
    assert.ok(second.userModified.includes('orchestrator-v2'), '用户改动 → user-modified 跳过');
    assert.equal(readFileSync(join(target, 'orchestrator-v2', 'preset.yml'), 'utf8'), 'name: 用户自改\n', '用户内容未被覆盖');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('presets-sync：旧 orchestrator 目录在 → 改名归档 orchestrator.removed-<stamp>（幂等、内容保留）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundled-sync-'));
  try {
    const target = join(root, '.agent-presets');
    const legacy = join(target, 'orchestrator');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'preset.yml'), 'name: 编排者模式（旧）\n', 'utf8');
    const first = syncBundledPresets(target);
    assert.ok(first.archived.includes('orchestrator'), '旧目录被改名归档（结果含 archived）');
    assert.ok(!existsSync(legacy), '旧 orchestrator 目录名不再存在');
    const archives = () => readdirSync(target).filter((e) => e.startsWith('orchestrator.removed-'));
    assert.equal(archives().length, 1, '恰好一个 orchestrator.removed-<stamp> 归档');
    assert.equal(readFileSync(join(target, archives()[0], 'preset.yml'), 'utf8'), 'name: 编排者模式（旧）\n', '归档保留用户数据（只改名不删除）');
    // 幂等：再次同步不产生第二个归档；orchestrator-v2 走 current。
    const second = syncBundledPresets(target);
    assert.deepEqual(second.archived, [], '二次同步无归档（幂等）');
    assert.ok(second.current.includes('orchestrator-v2'), 'orchestrator-v2 二次同步 current');
    assert.equal(archives().length, 1, '归档数不变');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
