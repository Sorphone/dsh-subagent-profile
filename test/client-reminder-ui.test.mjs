// test/client-reminder-ui.test.mjs — 提醒系统 P0 三要件与载体机检。
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

test('P0 角标注册到 shell.overlay（root 悬浮层）', () => {
  assert.match(source, /'shell\.overlay'/);
  assert.match(source, /dsh-subagent-profile-reminders/);
});

test('P0 角标三要件——severity 红、常驻至已读、带 session 标识', () => {
  const body = functionBody('ReminderOverlayBadge');
  // ① severity 上色（红）：P0 过滤 + 错误色样式类。
  assert.match(body, /severity === 'P0'/, '只渲染 P0');
  assert.match(source, /sap-overlayBadgeBtn\{box-sizing:border-box;border:none;border-radius:14px;background:var\(--dsw-alias-state-error-primary\)/, 'P0 角标必须用错误色 token');
  // ② 常驻至已读：unread>0 恒渲染（条件仅按 p0Unread.length，无自动消失/超时清除）。
  assert.match(body, /p0Unread\.length === 0\) return null/, '未读 P0 归零前恒渲染');
  assert.doesNotMatch(body, /setTimeout\([^)]*setData/, '不得自动消失（无超时清除）');
  // ③ 带 session 标识：会话 id 或「全局」标签。
  assert.match(body, /sessionId/, '角标必须带 session 标识');
  assert.match(body, /reminderSessionText/, '会话标识必须经截断助手渲染');
  assert.match(source, /reminderGlobal: '全局'/, '全局异常必须标注「全局」');
});

test('通知中心（设置页高级区）读同源 /reminders 且全动作回写', () => {
  const body = functionBody('ReminderCenter');
  assert.match(body, /api\('\/reminders'\)/, '通知中心必须读 /reminders（与 [6] 审计同源）');
  assert.match(body, /reminders\/ack/, '标记已读必须回写');
  assert.match(body, /reminders\/action/, '关闭等动作必须回写');
  const row = functionBody('buildReminderRow');
  for (const action of ['ack', 'dismiss']) {
    assert.match(row, new RegExp("act\\(r\\.id, '" + action + "'\\)"), '动作 ' + action + ' 必须可点击');
  }
  assert.doesNotMatch(row, /act\(r\.id, 'adopt'\)/, '通知类条目不再显示采纳按钮');
  assert.doesNotMatch(row, /act\(r\.id, 'ignore'\)/, '通知类条目不再显示忽略按钮');
  assert.doesNotMatch(row, /act\(r\.id, 'reject'\)/, '通知类条目不再显示拒绝按钮');
});

test('高价值提醒无 toast（toast 仅低价值瞬态，本版零实现）', () => {
  // 排除注释行后，代码中不得出现 toast 实现（高价值提醒一律常驻载体）。
  const codeLines = source.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('//'));
  assert.doesNotMatch(codeLines.join('\n'), /toast/i, '代码不得实现 toast（高价值提醒一律常驻）');
});

test('未采纳提醒恢复：条目五字段 + 主/子会话跳转 + 按钮三件套', () => {
  const row = functionBody('buildUnadoptedReminderRow');
  assert.match(row, /buildUnadoptedFields/, '未采纳条目必须渲染五字段区');
  assert.match(row, /buildUnadoptedActions/, '未采纳条目必须渲染按钮区');
  const fields = functionBody('buildUnadoptedFields');
  for (const label of ['reminderParentLabel', 'reminderChildLabel', 'reminderTaskLabel', 'reminderResultLabel', 'reminderNoteLabel']) {
    assert.match(fields, new RegExp(label), '五字段之一必须渲染：' + label);
  }
  assert.match(fields, /sessions\.open\(/, '主会话行必须经宿主 sessions 导航 API 跳转');
  assert.match(fields, /openChild\(childAddress\)/, '子会话行必须复用账本 openChild 跳转');
  const actions = functionBody('buildUnadoptedActions');
  for (const item of ['reminderViewChild', "'ack'", "'dismiss'"]) {
    assert.match(actions, new RegExp(item), '按钮三件套必须齐全：' + item);
  }
  assert.match(actions, /jumpChild/, '查看子会话必须跳转子会话');
});

test('未采纳条目按钮收敛：处置仅影响提醒状态，不渲染采纳/忽略/拒绝', () => {
  const actions = functionBody('buildUnadoptedActions');
  assert.match(actions, /act\(r\.id, 'ack'\)/, '标记已读必须保留（未读时显示）');
  assert.match(actions, /act\(r\.id, 'dismiss'\)/, '关闭必须保留');
  assert.doesNotMatch(actions, /act\(r\.id, 'adopt'\)/, '不得渲染采纳按钮');
  assert.doesNotMatch(actions, /act\(r\.id, 'ignore'\)/, '不得渲染忽略按钮');
  assert.doesNotMatch(actions, /act\(r\.id, 'reject'\)/, '不得渲染拒绝按钮');
});

test('v20 微调：候选时效标签加粗值常规；已处理折叠无上边框细线', () => {
  const row = functionBody('buildCandidateSettingsRow');
  assert.match(row, /el\('b', null, ZH\.candidateSettingsRow\)/, '「候选时效：」标签加粗（b 用于标签）');
  assert.match(row, /el\('span', null, candidateModeTextOf/, '模式/有效期值恢复常规字重');
  assert.ok(source.includes(".sap-reminderHandled{border-top:none;padding-top:8px}"), '已处理变体样式 = 无上边框');
  const center = functionBody('buildReminderCenter');
  assert.match(center, /'sap-customized sap-customizedArrowEnd sap-reminderHandled'/, '已处理折叠挂无线上边框变体');
  assert.match(source, /\.sap-customized\{border-top:1px solid var\(--dsw-alias-border-l2\)/, '其余 sap-customized 用途上边框不动');
});

test('提醒中心外层 = sap-card 与方案管理同款（卡头/卡体包绕，条目内部不动）', () => {
  const body = functionBody('buildReminderCenter');
  assert.match(body, /className: 'sap-card sap-cardStatic'/, '外层 = sap-card sap-cardStatic');
  assert.match(body, /'sap-cardHead'/, '卡头存在');
  assert.match(body, /'sap-cardTitleBox'/, '卡头标题盒');
  assert.match(body, /'sap-cardTitle'/, '卡头标题');
  assert.match(body, /ZH\.reminderCenterTitle/, '标题 = 提醒中心');
  assert.match(body, /'sap-cardBody'/, '错误提示/未处理列表/已处理折叠包进卡体');
  assert.doesNotMatch(body, /className: 'sap-rowCard'/, '外层不再用 rowCard');
  assert.match(body, /'sap-customized/, '已处理折叠 details 原样保留');
});

test('提醒分层：默认列表只渲染未终态条目，已终态折叠为「已处理（N）」可展开区', () => {
  const body = functionBody('buildReminderCenter');
  assert.match(body, /typeof r\.action === 'string' && r\.action !== ''/, '终态判据必须按 action 非空识别');
  assert.match(body, /pending\.map\(\(r\) => buildReminderRow/, '默认列表只渲染未终态条目');
  assert.match(body, /handled\.map\(\(r\) => buildReminderRow/, '已处理区展开后仍按现有行渲染');
  assert.match(body, /'details'/, '已处理区必须为原生可展开容器');
  assert.match(body, /'已处理（' \+ handled\.length/, '折叠头必须显示已处理条数');
});

test('提醒分层空态：全空显示空态文案，仅剩已处理时显示折叠区而非空态', () => {
  const body = functionBody('buildReminderCenter');
  assert.match(body, /pendingList === null && handledList === null/, '仅两个列表都为空才进入空态');
  assert.match(body, /ZH\.reminderEmpty/, '空态必须复用 reminderEmpty 文案');
  assert.match(body, /\[pendingList, handledList\]/, '有内容时必须同时渲染默认列表与折叠区');
});

test('P0 提醒行按钮：未读仅标记已读（无关闭），已读后出现关闭', () => {
  const row = functionBody('buildReminderRow');
  assert.match(row, /r\.severity !== 'P0' \|\| r\.unread !== true/, 'P0 关闭按钮必须等已读（unread!==true）后才渲染');
  assert.match(row, /r\.unread === true/, '标记已读仅在未读时渲染（已读后不渲染标记已读）');
  assert.match(row, /reminderDismiss/, '行内保留关闭按钮');
  assert.match(row, /reminderAck/, '行内保留标记已读按钮');
});

test('P1/P2 提醒行按钮：未读两按钮（标记已读/关闭），已读未终态仅关闭', () => {
  const row = functionBody('buildReminderRow');
  // 标记已读按 unread 门控：已读未终态（unread!==true）不渲染标记已读；
  // 关闭按钮条件对 P1/P2 恒真（severity!=='P0' 已满足），任何读态都渲染关闭。
  assert.match(row, /r\.unread === true \? el\('button', \{ className: 'sap-detailToggle'/, '标记已读必须按未读门控');
  assert.match(row, /r\.severity !== 'P0' \|\| r\.unread !== true/, '关闭按钮条件对 P1/P2 恒真');
});

test('已终态行隐藏动作按钮：通知类不渲染按钮区，未采纳类只留只读跳转', () => {
  const row = functionBody('buildReminderRow');
  assert.match(row, /typeof r\.action === 'string' && r\.action !== ''[\s\S]*?\? null/, '终态通知行必须把动作按钮区整体置空');
  assert.match(row, /ZH\.reminderActed/, '终态通知行必须保留已处理灰字标注');
  const actions = functionBody('buildUnadoptedActions');
  assert.match(actions, /const terminated = typeof r\.action === 'string' && r\.action !== ''/, '未采纳动作区必须识别终态');
  assert.match(actions, /terminated \? null : r\.unread === true/, '终态时标记已读按钮必须置空');
  assert.match(actions, /terminated \? null : el\('button', \{ type: 'button', className: 'sap-dangerButton'/, '终态时关闭按钮必须置空');
  assert.match(actions, /ZH\.reminderViewChild/, '查看子会话（只读跳转）在终态行保留');
});

test('已处理条目折叠后仍按现有行渲染并保留已处理灰字标注', () => {
  const row = functionBody('buildReminderRow');
  assert.match(row, /ZH\.reminderActed/, '通知类行必须保留已处理标注');
  const unadopted = functionBody('buildUnadoptedReminderRow');
  assert.match(unadopted, /ZH\.reminderActed/, '未采纳行必须保留已处理标注');
});

test('未采纳提醒标题退化：sessions 查不到时用 id 前 8 位 + …，悬停全文', () => {
  const titleFn = functionBody('reminderSessionTitle');
  assert.match(titleFn, /getSnapshot\(\)\.byId/, '标题必须经宿主 sessions 列表快照查询');
  assert.match(titleFn, /return ''/, '查不到必须返回空串');
  const jump = functionBody('reminderJumpText');
  assert.match(jump, /slice\(0, 8\) \+ '…'/, 'id 必须截断为前 8 位 + …');
  assert.match(jump, /title/, '完整 id 必须保留在 title 属性悬停全文');
});