// test/client-settings-shell.test.mjs — 设置页三卡外层与成本卡口径机检。
// client.js 为浏览器 bundle（无 DOM 测试基建），本文件以源码结构断言（与 chip/提醒
// 机检同一方式），与 node --check 共同构成 client 门禁。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

function functionBody(name) {
  const start = source.indexOf('function ' + name);
  assert.ok(start >= 0, '必须存在函数 ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('函数括号不平衡：' + name);
}

test('设置页三卡：折叠卡带描述与 SVG chevron，静态卡无 chevron', () => {
  const card = functionBody('buildSettingsCard');
  assert.match(card, /sap-cardTitleBox/);
  assert.match(card, /sap-cardDesc/);
  assert.match(card, /sap-cardChevron/);
  assert.match(card, /viewBox: '0 0 16 16'/);
  assert.match(card, /strokeWidth: 1\.5/);
  assert.match(card, /sap-cardStatic/);
  assert.match(source, /\.sap-cardOpen \.sap-cardChevron\{transform:rotate\(180deg\)/);
  const shell = functionBody('buildSectionReturn');
  assert.match(shell, /管理派发可用的方案：启用、编辑、删除，含成本与成功率/);
  assert.match(shell, /跨全部会话的派发成本汇总，按模型与方案拆分/);
  assert.match(shell, /逃生舱、建议注入、通知中心与维护项/);
});

test('全局成本卡：口径纯净 + 空态文案人话', () => {
  const body = functionBody('buildCostObservabilitySection');
  assert.match(body, /估算成本按已记录的派发统计得出——记录较少时数值可能不准，会随使用逐步修正。/);
  assert.match(body, /各会话的成本明细见会话页「派发账本」/);
  assert.doesNotMatch(body, /本会话/);
  assert.doesNotMatch(body, /summaries/);
  assert.doesNotMatch(body, /口径/);
  assert.doesNotMatch(body, /costScopeNote/);
});

test('高级区四子组：安全/建议注入/通知/维护 顺序清晰且不嵌套折叠', () => {
  const body = functionBody('buildAdvancedSection');
  const positions = ['安全', '建议注入', '通知', '维护'].map((word) => body.indexOf("'" + word + "'"));
  assert.ok(positions.every((p) => p >= 0), '四个子组标题必须存在');
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2] && positions[2] < positions[3], '子组顺序必须为 安全→建议注入→通知→维护');
  assert.match(source, /\.sap-subgroup \+ \.sap-subgroup\{border-top:1px solid/);
});

test('提醒条目：UUID 截断前 8 位、标题单行 ellipsis、按钮独立右对齐行', () => {
  assert.match(source, /sessionId\.slice\(0, 8\) \+ '…'/);
  assert.match(source, /\.sap-reminderTitle\{[^}]*text-overflow:ellipsis/);
  assert.match(source, /\.sap-reminderActions\{[^}]*justify-content:flex-end/);
  const row = functionBody('buildReminderRow');
  assert.match(row, /className: 'sap-reminderActions'/);
  assert.match(row, /title: r\.title/);
  assert.match(row, /title: session\.title/);
});
