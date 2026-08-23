// test/degradation.test.mjs — 降级透明化：版本探测（detectVersions）与
// /options/versions 路由。detectVersions 的版本读取可经注入 reader mock
// （默认 readPackageVersion），故此处不删 node_modules 即可覆盖：
//   * 版本越界（低于下限 / 达到上限）→ warnings 非空；
//   * 探测失败（reader 返回 unknown / 真实包缺失）→ versions 记 unknown；
//   * 范围内版本 → warnings 空；
//   * 真实 junction 环境三包均解析出非 unknown 版本（createRequire 实测）。
// /options/versions 路由经 apply() 的 capture webServer 拿 handler 驱动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectVersions, readPackageVersion } from '../lib/core/shims.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

const PROBED = ['dsh-subagent', 'dsh-agent', 'dsh-llm'];

// --- detectVersions mock 分支 -------------------------------------------------

test('detectVersions: 版本低于 peer 下限（0.1.0-rc.5）→ warnings 非空', () => {
  const { versions, warnings } = detectVersions(() => '0.1.0-rc.5');
  for (const pkg of PROBED) assert.equal(versions[pkg], '0.1.0-rc.5');
  assert.ok(warnings.length > 0, '越界必须产出 warnings');
  assert.match(warnings[0], /超出 peerDependencies 范围/);
});

test('detectVersions: 版本达到上限（0.2.0，开区间不包含）→ warnings 非空', () => {
  const { warnings } = detectVersions(() => '0.2.0');
  assert.ok(warnings.length > 0);
  assert.match(warnings[0], /超出 peerDependencies 范围/);
});

test('detectVersions: 范围内版本（0.1.0-rc.8）→ warnings 空', () => {
  const { warnings } = detectVersions(() => '0.1.0-rc.8');
  assert.deepEqual(warnings, []);
});

test('detectVersions: 探测失败（reader 返回 unknown）→ versions 全 unknown + warnings 非空', () => {
  const { versions, warnings } = detectVersions(() => 'unknown');
  assert.deepEqual(versions, { 'dsh-subagent': 'unknown', 'dsh-agent': 'unknown', 'dsh-llm': 'unknown' });
  assert.ok(warnings.length > 0);
  assert.match(warnings[0], /未检测到/);
});

test('readPackageVersion: 不存在的包 → unknown（真实 try/catch 失败路径）', () => {
  assert.equal(readPackageVersion('no-such-package'), 'unknown');
});

test('detectVersions: 真实 junction 环境三包均解析出非 unknown 版本', () => {
  const { versions } = detectVersions();
  for (const pkg of PROBED) {
    assert.notEqual(versions[pkg], 'unknown', `@deepseek-ai/${pkg} 应在 junction 环境解析出真实版本`);
  }
});

// --- /options/versions 路由结构 ----------------------------------------------
// 路由 harness 共享自 test/harness/routes.mjs（persist / degradation 共用）。

test('/options/versions 路由：返回 {ok, versions, warnings} 结构', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeRouteHarness();
    const { ctx } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const handler = routes[0].handler;
    const resp = await callRoute(handler, 'GET', '/options/versions');
    assert.equal(resp.code, 200);
    assert.equal(resp.json.ok, true);
    assert.equal(typeof resp.json.versions, 'object');
    for (const pkg of PROBED) {
      assert.equal(typeof resp.json.versions[pkg], 'string', `${pkg} version 必须为字符串`);
    }
    assert.ok(Array.isArray(resp.json.warnings), 'warnings 必须为数组');
  } finally { iso.restore(); iso.teardown(); }
});

test('护栏：探测边界行为与 package.json peerDependencies 双源一致', async () => {
  // 防「放宽 peerDependencies 而漏改探测常量」导致误报 amber 告警：不直接
  // import 私有常量，用边界行为对齐——声明 >=0.1.0-rc.6 <0.2.0 时，探测必须
  // 对 rc.6（下界）无警告、对 0.2.0（上界）有警告。
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const peers = pkg.peerDependencies ?? {};
  for (const name of PROBED) {
    const declared = peers[`@deepseek-ai/${name}`];
    assert.ok(typeof declared === 'string', `package.json 必须声明 @deepseek-ai/${name} peer 范围`);
    assert.match(declared, /0\.1\.0-rc\.6/);
    assert.match(declared, /<0\.2\.0/);
  }
  assert.deepEqual(detectVersions(() => '0.1.0-rc.6').warnings, [], '下界含：rc.6 不得告警');
  assert.ok(detectVersions(() => '0.2.0').warnings.length > 0, '上界开：0.2.0 必须告警');
});
