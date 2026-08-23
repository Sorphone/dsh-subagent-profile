// test/catalog-integrity.test.mjs — D1 数据表完整性护栏（Task 8）。
// lib/catalog.mjs 的 TOOL_ZH / TOOL_CATEGORY 是纯键值映射数据表（无控制流），
// 因行门豁免 max-lines-per-function，代价是此处锁死其固定键集：
//   * 固定键集断言（逐键列出）——任何增删改键都必须同步本文件；
//   * 重复键自检——对象字面量重复键会被静默覆盖，此处以「期望键集 ⇔ 实际键集
//     完全相等」兜底（重复键会导致键数不符 → 断言失败）；
//   * 纯键值映射无控制流断言——值全为 string（无函数/对象/引用）。
// 改动 TOOL_ZH/TOOL_CATEGORY 时先跑本测试，键集变更须显式更新下方列表。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_ZH, TOOL_CATEGORY } from '../lib/catalog.mjs';

// TOOL_ZH 固定键集（当前 58 键；计划书 7c 评审「60 键」已过期，实测 58）。
const TOOL_ZH_KEYS = [
  'bash', 'pwsh', 'read', 'write', 'edit', 'grep', 'glob', 'web_search',
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_scroll', 'browser_back', 'browser_forward', 'browser_press',
  'browser_reload', 'browser_wait', 'browser_get_text', 'dispatch', 'subagent',
  'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
  'todo_write', 'create_goal', 'get_goal', 'update_goal', 'workflow', 'ralph',
  'ask_user_question', 'skill', 'describe_image', 'read_image',
  'modlens_read_image', 'ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download',
  'ssh_tunnel', 'ssh_cluster', 'exit_plan_mode', 'incident_resolved',
  'dsh_rollback', 'dsh_snapshot', 'job_list', 'job_output', 'job_kill',
  'str_replace_editor', 'cordis_inspect_list', 'cordis_inspect_query',
  'cordis_inspect_self', 'cordis_define', 'cordis_run', 'cordis_stop',
  'cordis_undefine', 'run_code',
];

// TOOL_CATEGORY 固定键集（当前 32 键）。
const TOOL_CATEGORY_KEYS = [
  'read', 'write', 'edit', 'grep', 'glob', 'str_replace_editor', 'bash',
  'pwsh', 'web_search', 'todo_write', 'create_goal', 'get_goal', 'update_goal',
  'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph', 'ask_user_question', 'skill', 'read_image',
  'describe_image', 'cordis_inspect_list', 'cordis_inspect_query',
  'cordis_inspect_self', 'cordis_define', 'cordis_run', 'cordis_stop',
  'cordis_undefine', 'exit_plan_mode',
];

test('TOOL_ZH: 固定键集逐键一致（增删键须同步本测试）', () => {
  assert.deepEqual(
    [...Object.keys(TOOL_ZH)].sort(),
    [...TOOL_ZH_KEYS].sort(),
    'TOOL_ZH 键集与护栏列表不一致：改动数据表必须显式更新 test/catalog-integrity.test.mjs'
  );
});

test('TOOL_ZH: 键数 = 58（重复键会静默覆盖导致键数不符 → 护栏兜底）', () => {
  assert.equal(Object.keys(TOOL_ZH).length, 58);
});

test('TOOL_CATEGORY: 固定键集逐键一致（增删键须同步本测试）', () => {
  assert.deepEqual(
    [...Object.keys(TOOL_CATEGORY)].sort(),
    [...TOOL_CATEGORY_KEYS].sort(),
    'TOOL_CATEGORY 键集与护栏列表不一致：改动数据表必须显式更新 test/catalog-integrity.test.mjs'
  );
});

test('TOOL_CATEGORY: 键数 = 32（重复键自检）', () => {
  assert.equal(Object.keys(TOOL_CATEGORY).length, 32);
});

test('纯键值映射无控制流：TOOL_ZH / TOOL_CATEGORY 值全为 string', () => {
  for (const [key, value] of Object.entries(TOOL_ZH)) {
    assert.equal(typeof value, 'string', `TOOL_ZH.${key} 必须为字符串（数据表无函数/对象/引用）`);
  }
  for (const [key, value] of Object.entries(TOOL_CATEGORY)) {
    assert.equal(typeof value, 'string', `TOOL_CATEGORY.${key} 必须为字符串（数据表无函数/对象/引用）`);
  }
});
