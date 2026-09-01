// test/client-settings-shell.test.mjs — 设置页六页签外层与 ① ② 零改动迁移机检。
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

test('buildSettingsCard 保留：折叠卡带描述与 SVG chevron，静态卡无 chevron', () => {
  const card = functionBody('buildSettingsCard');
  assert.match(card, /sap-cardTitleBox/);
  assert.match(card, /sap-cardDesc/);
  assert.match(card, /sap-cardChevron/);
  assert.match(card, /viewBox: '0 0 16 16'/);
  assert.match(card, /strokeWidth: 1\.5/);
  assert.match(card, /sap-cardStatic/);
  assert.match(source, /\.sap-cardOpen \.sap-cardChevron\{transform:rotate\(180deg\)/);
});

test('② 成本卡口径纯净 + 空态文案人话（原样迁移前的既有护栏）', () => {
  const body = functionBody('buildCostObservabilitySection');
  assert.match(body, /估算成本按已记录的派发统计得出——记录较少时数值可能不准，会随使用逐步修正。/);
  assert.match(body, /各会话的成本明细见会话页「派发决策台账」/);
  assert.doesNotMatch(body, /本会话/);
  assert.doesNotMatch(body, /summaries/);
  assert.doesNotMatch(body, /口径/);
  assert.doesNotMatch(body, /costScopeNote/);
});

test('五页签（v9）：顺序 = 方案管理/成本与统计/自进化与建议/安全/通知与提醒，默认激活方案管理', () => {
  assert.ok(source.includes("const SETTINGS_TABS = ["), '页签清单常量必须存在');
  const order = ['方案管理', '成本与统计', '自进化与建议', '安全', '通知与提醒'].map((label) => source.indexOf("label: '" + label + "'"));
  assert.ok(order.every((p) => p >= 0), '五个页签标签必须存在');
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], '页签顺序必须为 方案管理→成本与统计→自进化与建议→安全→通知与提醒');
  assert.ok(source.indexOf("label: '维护'") < 0, '维护不再是独立页签');
  const keys = ['profiles', 'cost', 'advice', 'safety', 'reminders'].map((key) => source.indexOf("key: '" + key + "'"));
  assert.ok(keys.every((p) => p >= 0), '五个页签 key 必须存在');
  assert.ok(keys[0] < keys[1] && keys[1] < keys[2] && keys[2] < keys[3] && keys[3] < keys[4], '页签 key 顺序与标签一致');
  const state = functionBody('ProfilesSection');
  assert.match(state, /useState\('profiles'\)/, '默认激活方案管理（第一个页签）');
});

test('页签切换：点击 tab 激活对应区、其余隐藏；内容区全部挂载保状态', () => {
  const bar = functionBody('buildTabBar');
  assert.match(bar, /role: 'tablist'/);
  assert.match(bar, /role: 'tab'/);
  assert.match(bar, /'aria-selected': s\.activeTab === tab\.key/);
  assert.match(bar, /s\.setActiveTab\(tab\.key\)/, '点击 tab 写激活态');
  const zone = functionBody('buildTabZone');
  assert.match(zone, /role: 'tabpanel'/);
  assert.match(zone, /s\.activeTab === key \? ' sap-zoneActive' : ''/, '仅激活区带 sap-zoneActive');
  assert.match(source, /\.sap-zone\{display:none\}/);
  assert.match(source, /\.sap-zoneActive\{display:block\}/);
});

test('① 方案管理 ② 成本与统计：原样迁移零改动（只换容器，含重置按钮在①）', () => {
  const shell = functionBody('buildSectionReturn');
  assert.match(shell, /管理派发可用的方案：启用、编辑、删除，含成本与成功率/, '① 说明段原样');
  assert.match(shell, /跨全部会话的派发成本汇总，按模型与方案拆分/, '② 说明段原样');
  assert.match(shell, /buildCostObservabilitySection\(el, s, actions\)/, '② 全局成本卡原样调用');
  assert.match(shell, /ZH\.profilesIntro/, '① 说明段原样');
  assert.ok(source.includes('内置方案可编辑、可删除、可在此重置回默认'), 'v9 文案：可在此重置回默认');
  assert.ok(!source.includes('「高级」区'), '不再引用已删除的高级区');
  assert.match(shell, /buildDraftRows\(el, s, actions\)/, '① draft 区原样');
  assert.match(shell, /'\+ 新增 profile'/, '① 新增按钮原样');
  assert.match(shell, /actions\.resetAll/, '① 重置所有内置方案原样');
  const resetPos = shell.indexOf('ZH.resetAllBuiltins');
  const costPos = shell.indexOf('buildCostObservabilitySection');
  assert.ok(resetPos >= 0 && costPos >= 0 && resetPos < costPos, '重置按钮在方案管理（成本卡之前）');
  assert.match(shell, /buildTabZone\(el, s, 'profiles', \[/, '① 挂在 profiles 页签');
  assert.match(shell, /buildTabZone\(el, s, 'cost'/, '② 挂在 cost 页签');
  assert.match(shell, /buildSettingsCard\(el, 4, '维护'/, '维护折叠卡在①尾部');
  assert.match(shell, /buildMaintenanceSection\(el, s\)/, '维护卡内容 = 版本/兼容性');
  assert.doesNotMatch(shell, /buildTabZone\(el, s, 'maintenance'/, '维护不再是独立页签');
});

test('③ 自进化与建议：buildAdviceSection + buildAdvicePanel 挂入 advice 页签', () => {
  const shell = functionBody('buildSectionReturn');
  assert.match(shell, /buildTabZone\(el, s, 'advice', \[/);
  assert.match(shell, /buildAdviceSection\(el, s, actions\)/);
  assert.match(shell, /buildAdvicePanel\(el, s, actions, sessions\)/);
});

test('④ 安全：安全保证 + 逃生舱原样 + 审计健康（只读明细折叠表）', () => {
  const safety = functionBody('buildSafetySection');
  assert.match(safety, /ZH\.advancedSafetyLine/, '安全保证行原样');
  assert.match(safety, /ZH\.safetyCheckNote/, '安全检查说明行');
  assert.match(safety, /buildEscapeSection\(el, s, actions\)/, '逃生舱原样挂入');
  assert.match(safety, /ZH\.auditCardTitle/, '审计健康卡存在');
  assert.match(safety, /buildStatusBar\(el, s\)/, '审计状态红字/丢失计数进④');
  const audit = functionBody('buildAuditDetails');
  assert.match(audit, /ZH\.auditDetailToggle/, '查看审计明细折叠入口');
  assert.match(audit, /'▾'|'▸'/, '▸/▼ 折叠箭头');
  assert.match(audit, /ZH\.auditColTime/, '时间列');
  assert.match(audit, /ZH\.auditColEvent/, '事件列');
  assert.match(audit, /ZH\.auditColObject/, '对象列');
  assert.match(audit, /ZH\.auditColResult/, '结果列');
  assert.match(audit, /reminders\.slice\(0, 20\)/, '展示最近 20 条');
  assert.match(audit, /actions\.toggleAuditDetail/, '折叠仅一个交互点');
  const toggles = audit.match(/onClick/g) || [];
  assert.equal(toggles.length, 1, '只读展示：表格无导出/过滤等第二交互点');
  assert.match(audit, /ZH\.auditDetailScope/, '只读口径说明');
});

test('⑤ 通知与提醒：reminderCenter 原样挂入 reminders 页签', () => {
  const shell = functionBody('buildSectionReturn');
  assert.match(shell, /buildTabZone\(el, s, 'reminders', reminderCenter\)/, '⑤ 原样挂 reminderCenter');
});

test('维护卡（①方案管理尾部折叠卡）：版本/兼容性原样 + 清理占位灰置 + 不放重置按钮', () => {
  const maint = functionBody('buildMaintenanceSection');
  assert.match(maint, /'当前版本 v' \+ s\.pluginVersion \+ ' · 未发现兼容性问题'/, '版本/兼容性原样');
  assert.match(maint, /s\.versionWarnings/, '版本告警原样');
  assert.match(maint, /ZH\.maintenanceCleanup/, '清理候选与建议数据占位');
  assert.match(maint, /disabled: true/, '清理按钮灰置（0.5.0 起开放）');
  assert.ok(source.includes("maintenanceCleanupNote: '清空候选/建议（审计保留）· 0.5.0 起开放'"), '清理占位说明');
  assert.doesNotMatch(maint, /ZH\.resetAllBuiltins/, '维护卡不放重置按钮');
  const shell = functionBody('buildSectionReturn');
  assert.match(shell, /s\.maintenanceOpen === true, actions\.toggleMaintenance/, '维护卡折叠开合');
  const state = functionBody('ProfilesSection');
  assert.match(state, /useState\(false\)/, '维护卡默认折叠');
});

test('buildAdvancedSection 删除：定义与调用均不再存在', () => {
  assert.ok(!source.includes('function buildAdvancedSection'), '定义已删除');
  assert.ok(!source.includes('function buildAdvancedSubgroup'), '子组 helper 已删除');
  assert.ok(!source.includes('buildAdvancedSection('), '调用点已删除');
  assert.ok(!source.includes('sap-subgroup'), '子组样式已删除');
  assert.ok(!source.includes("'高级'"), '高级卡标题已删除');
});

test('审计健康卡与③ 顶部候选管理设置行文案零内部词（安全检查/白名单/成本/工具面/审批不豁免）', () => {
  assert.match(source, /派发前安全检查：白名单 \/ 成本 \/ 工具面 \/ 审批不豁免/, '安全检查说明人话');
  assert.ok(!source.includes('system-trust'), '不可出现内部词');
});
