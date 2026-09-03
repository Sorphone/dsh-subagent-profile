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
  assert.match(shell, /buildTabZone\(el, s, 'profiles',\r?\n {6}buildSettingsCard\(el, 1/, '① 只挂方案管理主卡（兼容 LF/CRLF 检出）');
  assert.match(shell, /buildTabZone\(el, s, 'cost'/, '② 挂在 cost 页签');
  assert.doesNotMatch(shell, /buildMaintenanceSection/, '① 尾部不再挂维护卡（v16 整卡删除）');
  assert.doesNotMatch(shell, /buildTabZone\(el, s, 'maintenance'/, '维护不是页签');
});

test('③ 自进化与建议（v16）：卡头仅标题+右侧开启建议开关；卡体顶部管理子卡仅两行（无数据维护）', () => {
  const shell = functionBody('buildSectionReturn');
  assert.match(shell, /buildTabZone\(el, s, 'advice', buildAdvicePanel\(el, s, actions, sessions\)\)/, '③ 只挂一张大卡');
  assert.ok(!source.includes('function buildAdviceSection'), '顶部独立开关小卡不存在');
  const panel = functionBody('buildAdvicePanel');
  assert.match(panel, /className: 'sap-card sap-cardStatic'/, '大卡 = sap-card');
  assert.match(panel, /'sap-cardHead/, '卡头存在');
  assert.match(panel, /'sap-cardHead sap-adviceCardHead'/, '卡头重排：列向两行');
  assert.match(panel, /'sap-adviceHeadTitleRow'/, '第一行 = 标题 + 右侧开关');
  assert.match(panel, /ZH\.adviceTitle/, '卡头标题 = 派发优化建议');
  assert.match(panel, /ZH\.adviceEnableLabel/, '右侧「开启建议」开关');
  const titleRow = panel.indexOf("'sap-adviceHeadTitleRow'");
  const descPos = panel.indexOf('ZH.advicePanelDesc');
  assert.ok(titleRow >= 0 && descPos >= 0 && titleRow < descPos, 'desc 小字独占第二行（不挤占标题+开关行）');
  const headStart = panel.indexOf("'sap-cardHead'");
  const bodyStart = panel.indexOf("'sap-cardBody'");
  const head = panel.slice(headStart, bodyStart);
  assert.ok(!head.includes('buildCandidateSettingsRow'), '候选时效行不在卡头（移入子卡）');
  assert.ok(!head.includes('sap-adviceGlobalLine'), '全局行不在卡头（移入子卡）');
  assert.ok(!head.includes('adviceMaintenanceLabel'), '数据维护行不在卡头（整行删除）');
  assert.match(panel, /'sap-adviceManageCard'/, '卡体顶部 = 管理子卡');
  assert.match(panel, /buildCandidateSettingsRow\(el, s, actions\)/, '子卡行① = 候选时效');
  assert.match(panel, /sap-adviceGlobalLine/, '子卡行② = 全局统计');
  assert.match(panel, /buildCandidateSettingsPanel\(el, s, actions\)/, '候选时效浮层随子卡');
  assert.ok(!panel.includes('adviceMaintenanceLabel'), '无数据维护行');
  assert.ok(!source.includes("adviceMaintenanceLabel: '数据维护：'"), '数据维护文案已删除');
  assert.ok(source.includes(".sap-adviceManageCard{background:var(--dsw-alias-bg-layer-2);"), '子卡 = 浅底紧凑（bg-layer-2）');
  assert.match(panel, /buildAdviceCard/, '卡体下方 = 建议列表');
});

test('④ 安全：安全保证 + 逃生舱原样 + 审计健康（只读明细折叠表）', () => {
  const safety = functionBody('buildSafetySection');
  assert.match(safety, /ZH\.advancedSafetyLine/, '安全保证行原样');
  assert.match(safety, /ZH\.safetyCheckNote/, '安全检查说明行');
  assert.match(safety, /buildEscapeSection\(el, s, actions\)/, '逃生舱原样挂入');
  assert.match(safety, /ZH\.auditCardTitle/, '审计健康卡存在');
  assert.match(safety, /buildStatusBar\(el, s\)/, '审计状态红字/丢失计数进④');
  assert.match(safety, /buildSettingsCard\(el, 5, ZH\.safetyCardTitle/, '安全保证卡 = sap-card（buildSettingsCard 同款）');
  assert.match(safety, /buildSettingsCard\(el, 6, ZH\.auditCardTitle/, '审计健康卡 = sap-card（buildSettingsCard 同款）');
  const escapeCard = functionBody('buildEscapeSection');
  assert.match(escapeCard, /className: 'sap-card sap-cardStatic'/, '逃生舱卡 = sap-card');
  const audit = functionBody('buildAuditDetails');
  assert.match(audit, /ZH\.auditDetailToggle/, '查看审计明细折叠入口');
  assert.match(audit, /'▸'/, '审计明细收起态 = ▸（不再字符切换）');
  assert.ok(source.includes('.sap-auditCollapse[aria-expanded="true"] .sap-auditArrow{transform:rotate(90deg)}'), '审计明细展开态旋转 90°');
  assert.match(audit, /ZH\.auditColTime/, '时间列');
  assert.match(audit, /ZH\.auditColEvent/, '事件列');
  assert.match(audit, /ZH\.auditColObject/, '对象列');
  assert.match(audit, /ZH\.auditColResult/, '结果列');
  assert.match(audit, /reminders\.slice\(0, 20\)/, '展示最近 20 条');
  assert.match(audit, /actions\.toggleAuditDetail/, '折叠仅一个交互点');
  assert.ok(audit.indexOf('ZH.auditDetailToggle') < audit.indexOf("'sap-auditArrow'"), '审计明细折叠箭头右置（文字后 ▸）');
  assert.match(audit, /'sap-auditCollapse'/, '明细折叠入口类 = sap-auditCollapse');
  assert.match(audit, /'sap-auditTable'/, '明细表类 = sap-auditTable');
  assert.match(audit, /'sap-auditTime'/, '明细表时间格类 = sap-auditTime');
  assert.match(audit, /'sap-auditEvent'/, '明细表事件格类 = sap-auditEvent');
  assert.match(audit, /'sap-auditObject'/, '明细表对象格类 = sap-auditObject');
  const toggles = audit.match(/onClick/g) || [];
  assert.equal(toggles.length, 1, '只读展示：表格无导出/过滤等第二交互点');
  assert.match(audit, /ZH\.auditDetailScope/, '只读口径说明');
});

test('⑤ 通知与提醒：reminderCenter 挂入 reminders 页签（带只读跳转到建议页签）', () => {
  const shell = functionBody('buildSectionReturn');
  assert.match(shell, /buildTabZone\(el, s, 'reminders', el\(reminderCenter, \{ jumpToAdvice: \(\) => s\.setActiveTab\('advice'\) \}\)\)/, '⑤ 挂 reminderCenter 并注入只读跳转');
});

test('维护卡（v16）：整卡删除——无 buildMaintenanceSection、无挂载、无折叠状态', () => {
  assert.ok(!source.includes('function buildMaintenanceSection'), 'buildMaintenanceSection 已删除');
  const shell = functionBody('buildSectionReturn');
  assert.ok(!shell.includes('buildMaintenanceSection'), 'shell 不再挂载维护卡');
  assert.ok(!shell.includes("'维护'"), '维护卡标题不再出现');
  assert.ok(!source.includes('maintenanceOpen'), '维护折叠状态已删除');
  assert.ok(!source.includes('toggleMaintenance'), '维护折叠动作已删除');
  assert.ok(!source.includes('maintenanceAwesomeLabel'), 'awesome 链接文案已删除（0.5.0 再统一设计归属）');
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

test('卡头 desc 小字（v20）：③④⑤ 各卡 = title + sap-cardDesc（方案管理同款，① ② 不动）', () => {
  assert.ok(source.includes("advicePanelDesc: '根据历史派发数据向父会话附优化提示（例：某方案近期成功率偏低，可考虑换方案）。只提示，不自动改配置'"), '③ 派发优化建议 desc');
  assert.ok(source.includes("safetyCardDesc: '派发与审计的安全保证，明细只读'"), '④ 安全保证 desc');
  assert.ok(source.includes("escapeCardDesc: '放行非官方预设的高风险通道，默认关闭'"), '④ 逃生舱 desc');
  assert.ok(source.includes("auditCardDesc: '治理审计状态与留痕，异常红字提示'"), '④ 审计健康 desc');
  assert.ok(source.includes("reminderCenterDesc: '需要你关注的事件汇总，所有动作均有审计记录；处理过的条目折叠保存'"), '⑤ 提醒中心 desc');
  const panel = functionBody('buildAdvicePanel');
  assert.match(panel, /'sap-cardDesc'/, '③ 卡头补 sap-cardDesc');
  const escapeCard = functionBody('buildEscapeSection');
  assert.match(escapeCard, /'sap-cardDesc'/, '④ 逃生舱卡头补 sap-cardDesc');
  const center = functionBody('buildReminderCenter');
  assert.match(center, /'sap-cardDesc'/, '⑤ 提醒中心卡头补 sap-cardDesc');
  const safety = functionBody('buildSafetySection');
  assert.match(safety, /buildSettingsCard\(el, 5, ZH\.safetyCardTitle, ZH\.safetyCardDesc/, '④ 安全保证 desc 参数');
  assert.match(safety, /buildSettingsCard\(el, 6, ZH\.auditCardTitle, ZH\.auditCardDesc/, '④ 审计健康 desc 参数');
});

test('滚动条优化（v21）：sap-section 撑满宿主宽；tab 行 flex-wrap，无横向滚动结构', () => {
  assert.ok(source.includes(".sap-section{width:100%;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}"), 'sap-section 撑满宿主可用宽');
  assert.ok(!source.includes('max-width:720px'), '设置页不再限制 720px（去右侧大空白）');
  assert.ok(source.includes(".sap-tabs{display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}"), 'tab 行 flex-wrap');
  assert.ok(!/\.sap-tabs\{[^}]*overflow-x/.test(source), 'tab 行无横向滚动');
  assert.ok(source.includes(".sap-adviceDetailTable th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:3px 8px 3px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}"), '明细表头可换行');
  assert.ok(!/\.sap-adviceDetailTable th\{[^}]*white-space:nowrap/.test(source), '明细表头不强制不换行（防窄面板横向溢出）');
});

test('样式统一：无方案标签/候选选中/未读边框/理由高亮/候选标注 全部中性 token，无 brand-primary 于常规状态标签', () => {
  assert.ok(source.includes(".sap-adviceNoProfileTag{font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:3px;padding:0 5px;flex:none}"), '无方案标签 token 快照：label-primary + border-l2 + bg-layer-1');
  assert.ok(!source.includes('.sap-adviceNoProfileTag{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l3)'), '无方案标签旧样式（l3/次级色）已移除');
  assert.ok(source.includes(".sap-candidateSelected{border-color:var(--dsw-alias-label-primary)}"), '候选选中边框 = label-primary');
  assert.ok(source.includes(".sap-candidateSelected .sap-candidateRadio{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary);"), '候选选中 radio = label-primary');
  assert.ok(source.includes(".sap-reminderUnread{border-color:var(--dsw-alias-label-primary)}"), '通知未读边框 = label-primary');
  assert.ok(!source.includes('.sap-adviceWhyBox'), '理由高亮色块已删除（v10 纯文字小节标题）');
  assert.ok(source.includes(".sap-adviceSectionTitle{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-weight:700;"), '小节标题 = 纯文字加粗 label-primary（无左线/无底块）');
  assert.ok(source.includes(".sap-candidatesTitle{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-weight:700;margin:0}"), '候选方案（未应用）小节标题保持中性');
  const adviceCss = source.slice(source.indexOf('.sap-adviceItem{'), source.indexOf('.sap-candidateSettingsRow{'));
  assert.ok(!adviceCss.includes('brand-primary'), '建议/候选常规标签无 brand-primary');
  assert.ok(!adviceCss.includes('state-success'), '建议/候选常规标签无成功绿');
  const reminderCss = source.slice(source.indexOf('.sap-reminderP0{'), source.indexOf('.sap-overlayBadge{'));
  assert.ok(!reminderCss.includes('brand-primary'), '通知常规状态无 brand-primary（未读已改 label-primary）');
  assert.ok(!source.includes('sap-adviceFootPrimary') && !source.includes('sap-adviceFootDisabled'), '自造按钮样式已删除（统一 sap-primaryButton/sap-secondaryButton）');
  assert.ok(!/\.sap-zone\{[^}]*background/.test(source) && !/\.sap-zone\{[^}]*margin/.test(source), '页签容器不新增背景/间隔样式（仅 display 控制）');
});

test('样式统一：⑥ 通知条目 = sap-rowCard/sap-reminder*，已处理折叠 = sap-customized*', () => {
  const center = functionBody('buildReminderCenter');
  assert.match(center, /className: 'sap-card sap-cardStatic'/, '提醒中心根 = sap-card（与方案管理同款卡）');
  assert.match(center, /'sap-cardHead'/, '卡头存在');
  assert.match(center, /'sap-cardTitleBox'/, '卡头标题盒');
  assert.match(center, /'sap-cardTitle'/, '卡头标题');
  assert.match(center, /'sap-cardBody'/, '错误/列表/折叠包进卡体');
  assert.match(center, /'sap-customized/, '已处理折叠区 = sap-customized');
  assert.match(center, /'sap-customizedSummary'/, '折叠头 = sap-customizedSummary');
  assert.match(center, /'sap-customizedBody'/, '折叠体 = sap-customizedBody');
  assert.match(center, /'sap-customized sap-customizedArrowEnd/, '已处理折叠箭头右置修饰类');
  assert.match(center, /'sap-customizedEndArrow'/, '折叠箭头放在文字后（▸）');
  assert.ok(source.includes(".sap-customizedArrowEnd[open] .sap-customizedEndArrow{transform:rotate(90deg)}"), '已处理折叠展开旋转 90°（▸→▾）');
  assert.match(source, /'高级选项', el\('span', \{ className: 'sap-customizedEndArrow' \}, '▸'\)/, '① 高级选项折叠同款尾随 ▸');
  const row = functionBody('buildReminderRow');
  assert.match(row, /'sap-reminderHead'/, '提醒条目 = sap-reminder* 系');
});