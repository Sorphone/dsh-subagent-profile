// test/catalog-fallback.test.mjs — 工具分组/中文名的薄覆盖层（schema 声明优先、缺失
// 回退）护栏：
//   * schema 自带 category/group/zh 声明字段时，groupOf/zh 优先取 schema 声明值
//     （而非硬编码数据表）——验收 ①；
//   * schema 缺失时按回退链：核心层覆盖表 → 插件层前缀提取 / 自定义层预设名，
//     zh 回退 TOOL_ZH → 空串——验收 ②；
//   * catalog.mjs 数据表键集零新增（与 catalog-integrity 同口径的键数断言）——红线。
// 直接测 catalog-cache.mjs 导出的纯函数 resolveToolCategory / resolveToolZh，并经
// getCatalogSnapshot 走完整 push 路径验证快照 tools 条的 group/zh。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolCategory, resolveToolZh, getCatalogSnapshot } from '../lib/core/catalog-cache.mjs';
import { TOOL_ZH, TOOL_CATEGORY } from '../lib/core/catalog.mjs';

// ---------- resolveToolCategory：schema 声明优先 ----------

test('resolveToolCategory: schema.category 声明优先于数据表', () => {
  const schema = { name: 'read', category: '文件操作' };
  assert.equal(resolveToolCategory(schema, 'read', 'standard', 'core'), '文件操作');
});

test('resolveToolCategory: schema.category 缺失时用 schema.group', () => {
  const schema = { name: 'bash', group: 'shell' };
  assert.equal(resolveToolCategory(schema, 'bash', 'global', 'plugin'), 'shell');
});

test('resolveToolCategory: schema 声明优先于插件前缀提取', () => {
  const schema = { name: 'ssh_exec', category: '远程' };
  assert.equal(resolveToolCategory(schema, 'ssh_exec', 'global', 'plugin'), '远程');
});

// ---------- resolveToolCategory：缺失回退链 ----------

test('resolveToolCategory: core 层覆盖表命中 → 返回数据表值', () => {
  assert.equal(resolveToolCategory(undefined, 'read', 'standard', 'core'), TOOL_CATEGORY.read);
});

test('resolveToolCategory: core 层覆盖表未命中 → 缺省「其他」', () => {
  assert.equal(resolveToolCategory(undefined, 'not_in_table', 'standard', 'core'), '其他');
});

test('resolveToolCategory: plugin 层 → 前缀提取 / 无下划线用原名', () => {
  assert.equal(resolveToolCategory(undefined, 'ssh_exec', 'global', 'plugin'), 'ssh');
  assert.equal(resolveToolCategory(undefined, 'plain', 'global', 'plugin'), 'plain');
});

test('resolveToolCategory: custom 层 → 预设名（source）', () => {
  assert.equal(resolveToolCategory(undefined, 'any_tool', 'my-preset', 'custom'), 'my-preset');
});

// ---------- resolveToolZh：schema 声明优先 + 回退 ----------

test('resolveToolZh: schema.zh 声明优先于数据表', () => {
  const schema = { name: 'read', zh: '读取（schema 声明）' };
  assert.equal(resolveToolZh(schema, 'read'), '读取（schema 声明）');
});

test('resolveToolZh: schema.label 作 zh 候选', () => {
  const schema = { name: 'read', label: '读取标签' };
  assert.equal(resolveToolZh(schema, 'read'), '读取标签');
});

test('resolveToolZh: 无声明 → 回退 TOOL_ZH，未收录 → 空串', () => {
  assert.equal(resolveToolZh(undefined, 'read'), TOOL_ZH.read);
  assert.equal(resolveToolZh(undefined, 'not_in_table'), '');
});

// ---------- getCatalogSnapshot：完整 push 路径（skip run_code / 去重） ----------

test('getCatalogSnapshot: schema 带 category/zh 声明 → 快照 tools 条采用 schema 值', async () => {
  const toolsService = {
    schemas: (scope) => {
      // global 层带声明；standard 预设层无声明，验证回退；my-custom 预设层独立命名。
      if (scope === undefined) {
        return [{ name: 'server_probe', description: 'x', category: 'server' }, { name: 'web_search', description: 'y', zh: '联网搜索' }];
      }
      if (scope === 'key:standard') return [{ name: 'read', description: 'z' }];
      return [{ name: 'custom_tool', description: 'w' }];
    },
  };
  const agentPresets = {
    list: async () => [{ id: 'standard' }, { id: 'my-custom' }],
    standingKeyFor: async (id) => `key:${id}`,
  };
  const snapshot = await getCatalogSnapshot({
    getLlm: () => undefined,
    getAgentPresets: () => agentPresets,
    getTools: () => toolsService,
  });
  const byName = Object.fromEntries(snapshot.tools.map((t) => [t.name, t]));
  // global（plugin 层）schema.category 优先。
  assert.equal(byName.server_probe.group, 'server', 'schema.category 优先于 plugin 前缀');
  assert.equal(byName.server_probe.source, 'global');
  assert.equal(byName.server_probe.layer, 'plugin');
  // global schema.zh 优先。
  assert.equal(byName.web_search.zh, '联网搜索', 'schema.zh 优先于 TOOL_ZH');
  assert.equal(byName.web_search.group, 'web', '未声明 category 的 plugin 工具回退前缀提取');
  // standard（core 层）无声明 → 回退 TOOL_CATEGORY / TOOL_ZH。
  assert.equal(byName.read.layer, 'core');
  assert.equal(byName.read.group, TOOL_CATEGORY.read, 'core 层无声明回退覆盖表');
  assert.equal(byName.read.zh, TOOL_ZH.read);
  // custom 预设无声明 → 分组回退预设名。
  assert.equal(byName.custom_tool.layer, 'custom');
  assert.equal(byName.custom_tool.group, 'my-custom', 'custom 层无声明回退预设名');
});

test('getCatalogSnapshot: run_code 永远排除，schemas 为空时不产生 tools 条', async () => {
  const toolsService = { schemas: () => [{ name: 'run_code' }] };
  const snapshot = await getCatalogSnapshot({
    getLlm: () => undefined,
    getAgentPresets: () => undefined,
    getTools: () => toolsService,
  });
  assert.deepEqual(snapshot.tools, [], 'run_code 不入工具目录');
});

// ---------- 键集零新增（与 catalog-integrity 同口径） ----------

test('薄覆盖层不新增数据表条目：TOOL_ZH=58 / TOOL_CATEGORY=32', () => {
  assert.equal(Object.keys(TOOL_ZH).length, 58);
  assert.equal(Object.keys(TOOL_CATEGORY).length, 32);
});
