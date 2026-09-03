// test/client-data-maintenance-ui.test.mjs — 数据维护 UI 机检（B8 + B7 设置页）：
// ① 方案管理尾部挂「数据维护」卡（快照开关 + B7 文案 + 数量/护栏提示 + 单条查看
// persona 折叠 + 维护按钮组四区一行、确认一次、结果 echo）；② 提醒中心归档视图
// 分页加载（/reminders/archived?offset&limit + 加载更早）；③ 孤儿灰置：跳转引用
// 指向已删会话 → 跳转按钮 disabled（sessionExists 探测）。client.js 为浏览器
// bundle，源码结构断言。

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

test('维护卡：四区按钮组（确认一次 + 结果 echo）+ 快照开关 + B7 文案', () => {
  const card = functionBody('buildMaintenanceCard');
  assert.match(card, /\{ zone: 'candidates', label: ZH\.cleanCandidates \}/, '候选清理按钮');
  assert.match(card, /\{ zone: 'snapshots', label: ZH\.cleanSnapshots \}/, '快照清理按钮');
  assert.match(card, /\{ zone: 'reminders', label: ZH\.cleanReminders \}/, '提醒归档按钮');
  assert.match(card, /\{ zone: 'stats', label: ZH\.cleanStats \}/, '重置统计按钮');
  assert.match(card, /key: 'clean-' \+ z\.zone/, '按钮键 = 清理区');
  assert.match(card, /sap-candidateSettingsActions/, '按钮组一行容器（DOM 一行）');
  assert.match(card, /ZH\.maintenanceCardTitle/, '维护卡标题');
  assert.match(card, /onChange: actions\.toggleSnapshots/, '快照开关');
  assert.match(card, /snapshotSwitchDescRows\(el\)/, '快照开关说明三行分层渲染');
  assert.match(card, /ZH\.snapshotCount/, '快照数量展示');
  assert.match(card, /ZH\.snapshotCapHint/, '护栏上限提示');
  assert.match(card, /ZH\.snapshotNone/, '空态文案');
  assert.match(card, /actions\.viewSnapshot\(entry\.id\)/, '单条查看入口');
  assert.match(card, /s\.maintenanceNotice !== ''/, '清理结果 echo 展示');
  const actions = functionBody('attachMaintenanceActions');
  assert.match(actions, /window\.confirm\(ZH\.maintenanceConfirm/, '确认一次');
  assert.match(actions, /api\('\/maintenance\/clean', \{ zone \}\)/, '一个入口四区');
  assert.match(actions, /ZH\.maintenanceDone/, '结果 echo 文案');
  assert.match(actions, /api\('\/snapshot\?id=' \+ encodeURIComponent\(id\)\)/, '单条查看路由');
  assert.match(actions, /api\('\/snapshots\/set-enabled'/, '快照开关路由');
});

test('单条快照只读体：persona 默认折叠（details 折叠 + 字符数），其余字段 JSON 展示', () => {
  const body = functionBody('snapshotViewBody');
  assert.match(body, /key === 'persona'/, 'persona 独立分支');
  assert.match(body, /className: 'sap-customized'/, 'persona 折叠容器（默认收起）');
  assert.match(body, /ZH\.snapshotPersonaFold/, '折叠摘要带字符数');
  assert.match(body, /formatGateValue\(cfg\[key\]\)/, '其余字段等宽 JSON');
});

test('快照开关说明三行分层：首行主说明、后两行小字次要色（sap-descMinor）', () => {
  const rows = functionBody('snapshotSwitchDescRows');
  assert.match(rows, /ZH\.snapshotSwitchDesc\.split\('\\n'\)/, '说明按换行拆三行');
  assert.match(rows, /index === 0 \? 'sap-desc' : 'sap-descMinor'/, '首行主说明、后两行次要色');
  assert.match(source, /sap-descMinor\{color:var\(--dsw-alias-label-tertiary\)/, '次要色样式沿用 dsw-alias 变量');
  assert.match(source, /sap-maintenanceSwitchDesc\{/, '说明容器样式存在');
});

test('提醒归档视图：分页加载（offset/limit + 加载更早 + 打开取首页）', () => {
  const center = functionBody('makeReminderCenter');
  assert.match(center, /api\('\/reminders\/archived\?offset=' \+ offset \+ '&limit=' \+ ARCHIVED_PAGE_SIZE\)/, '归档视图分页路由');
  assert.match(center, /offset === 0 \? rows : \[\.\.\.prev\.list, \.\.\.rows\]/, '首页重置、后续追加');
  assert.match(center, /nextOpen && archived\.list\.length === 0/, '打开时取第一页');
  const section = functionBody('buildArchivedReminderSection');
  assert.match(section, /archived\.offset \+ ARCHIVED_PAGE_SIZE/, '加载更早按 offset 推进');
  assert.match(section, /ZH\.reminderArchivedMore/, '加载更早按钮');
  assert.match(section, /已归档（' \+ archived\.total/, '归档总数展示');
  assert.match(section, /archived\.loading === true/, '加载中禁用按钮');
});

test('孤儿灰置：sessionExists 探测 + 主/子会话跳转按钮 disabled（回溯安全）', () => {
  const probe = functionBody('sessionExists');
  assert.match(probe, /sessions\.binding\(id\) !== undefined/, 'binding 拿不到视为已删');
  const fields = functionBody('buildUnadoptedFields');
  assert.match(fields, /const parentGone = !sessionExists\(sessions, r\.sessionId\)/, '主会话存在性探测');
  assert.match(fields, /const childGone = !sessionExists\(sessions, childId\)/, '子会话存在性探测');
  assert.match(fields, /reminderJumpButton\(el, parentJump, parentGone, openParent\)/, '主会话跳转灰置');
  assert.match(fields, /reminderJumpButton\(el, childJump, childAddress === null \|\| childGone, jumpChild\)/, '子会话跳转灰置');
  const actions = functionBody('buildUnadoptedActions');
  assert.match(actions, /disabled: childAddress === null \|\| childGone === true/, '查看子会话按钮灰置');
});
