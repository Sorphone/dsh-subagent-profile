// test/client-reminder-ui.test.mjs — Task 42（NT1）机检：提醒系统 P0 三要件与载体。
// client.js 为浏览器 bundle（无 DOM 测试基建），本文件以源码结构断言 P0 红角标三要件
// （severity 红 / 常驻至已读 / 带 session 标识）、通知中心与「高价值提醒无 toast」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

function functionBody(name) {
  const start = source.indexOf('function ' + name);
  assert.ok(start >= 0, `必须存在函数 ${name}`);
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

test('Task 42：P0 角标注册到 shell.overlay（root 悬浮层）', () => {
  assert.match(source, /'shell\.overlay'/);
  assert.match(source, /dsh-subagent-profile-reminders/);
});

test('Task 42：P0 角标三要件——severity 红、常驻至已读、带 session 标识', () => {
  const body = functionBody('ReminderOverlayBadge');
  // ① severity 上色（红）：P0 过滤 + 错误色样式类。
  assert.match(body, /severity === 'P0'/, '只渲染 P0');
  assert.match(source, /sap-overlayBadgeBtn\{box-sizing:border-box;border:none;border-radius:14px;background:var\(--dsw-alias-state-error-primary\)/, 'P0 角标必须用错误色 token');
  // ② 常驻至已读：unread>0 恒渲染（条件仅按 p0Unread.length，无自动消失/超时清除）。
  assert.match(body, /p0Unread\.length === 0\) return null/, '未读 P0 归零前恒渲染');
  assert.doesNotMatch(body, /setTimeout\([^)]*setData/, '不得自动消失（无超时清除）');
  // ③ 带 session 标识：会话 id 或「全局」标签。
  assert.match(body, /sessionId/, '角标必须带 session 标识');
  assert.match(body, /ZH\.reminderGlobal/, '全局异常必须标注「全局」');
});

test('Task 42：通知中心（设置页高级区）读同源 /reminders 且全动作回写', () => {
  const body = functionBody('ReminderCenter');
  assert.match(body, /api\('\/reminders'\)/, '通知中心必须读 /reminders（与 [6] 审计同源）');
  assert.match(body, /reminders\/ack/, '标记已读必须回写');
  assert.match(body, /reminders\/action/, '采纳/忽略/拒绝/关闭必须回写');
  const row = functionBody('buildReminderRow');
  for (const action of ['adopt', 'ignore', 'reject', 'dismiss']) {
    assert.match(row, new RegExp("act\\(r\\.id, '" + action + "'\\)"), '动作 ' + action + ' 必须可点击');
  }
});

test('Task 42：高价值提醒无 toast（toast 仅低价值瞬态，本版零实现）', () => {
  // 排除注释行后，代码中不得出现 toast 实现（高价值提醒一律常驻载体）。
  const codeLines = source.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('//'));
  assert.doesNotMatch(codeLines.join('\n'), /toast/i, '代码不得实现 toast（高价值提醒一律常驻）');
});
