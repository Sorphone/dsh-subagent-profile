// test/client-apply-flow.test.mjs — 自进化应用确认流机检：确认弹窗、灰置条件、观察期
// 状态行、撤销建议区（无「忽略」动作）、进化轨迹、生命周期徽标、提醒 mint 调用点、
// 文案卸载、冷启动禁用提示、箭头修正。纯源码结构断言（同 client 机检方式）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
const routesSource = readFileSync(fileURLToPath(new URL('../lib/core/evolution-routes.mjs', import.meta.url)), 'utf8');
const canarySource = readFileSync(fileURLToPath(new URL('../lib/core/evolution-canary.mjs', import.meta.url)), 'utf8');
const indexSource = readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8');

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

// --- 1. 确认弹窗结构 + humanConfirmed 调用点 ----------------------------------------

test('1 确认弹窗：摘要/成本与能力影响/一次确认按钮（无强制勾选）/取消；apply 带 humanConfirmed:true', () => {
  const modal = functionBody('buildApplyModal');
  assert.ok(modal.includes('adviceApplyModalSummary'), '候选摘要小节');
  assert.ok(modal.includes('adviceApplyModalImpact'), '成本与能力影响小节');
  assert.ok(modal.includes('applyImpactTextOf'), '影响行由候选/方案推导');
  assert.ok(modal.includes('adviceApplyDefaultNote'), 'per-call 覆盖说明行');
  assert.ok(modal.includes('adviceApplyObserveNote'), '观察期说明行');
  assert.ok(modal.includes('adviceApplyConfirm'), '主按钮 = 确认调整方案（按钮即确认）');
  assert.ok(modal.includes('actions.applyCandidate'), '确认按钮触发应用动作');
  assert.ok(modal.includes('actions.closeApplyModal'), '取消按钮');
  assert.ok(!modal.includes("type: 'checkbox'"), '无强制勾选（方案 A：弹窗即二次确认层）');
  assert.ok(modal.includes('modal.error !== \'\''), '失败红字回显在弹窗内');
  const actions = functionBody('makeApplyFlowActions');
  assert.ok(actions.includes("api('/evolution/apply', { assetId: modal.candidateId, human_confirmed: true })"), 'apply 调用点带 humanConfirmed:true');
  assert.ok(actions.includes('setSavedNotice(ZH.adviceApplySuccess)'), '成功后提示「已应用，进入观察期」');
  assert.ok(actions.includes('refresh()'), '成功后立即刷新');
});

// --- 2. 灰置条件 --------------------------------------------------------------------

test('2 灰置条件：applyEnabled=false / 未选候选 → disabled；有候选 + enabled → 可点', () => {
  const foot = functionBody('buildAdviceFoot');
  assert.ok(foot.includes("const applyEnabled = status.applyEnabled === true"), '启用条件一：applyEnabled');
  assert.ok(foot.includes('candidateSelectedIdOf(s, a.profileKey, candidates)'), '启用条件二：已选候选');
  assert.ok(foot.includes('const disabled = disabledTitle !== \'\''), 'disabled 由禁用原因推导');
  assert.ok(foot.includes('adviceApplySelectTitle'), '未选候选 → 灰置 + 提示');
  assert.ok(foot.includes('status.reasons.join(\'；\')'), '冷启动 → title = reasons.join（；）');
  assert.ok(foot.includes('adviceApplyObservingTitle'), '观察中 → 暂不支持再次调整');
  assert.ok(foot.includes('actions.openApplyModal(a.profileKey, selectedId)'), '启用时点击打开确认弹窗');
  assert.ok(foot.includes('title: disabledTitle'), '禁用原因进 title');
});

// --- 3. 观察期状态行五分支（数据源 = /evolution/assets） -----------------------------

test('3 观察期状态行：observing/stalled/applied/regress/aborted 五分支（label 后端下发）', () => {
  const line = functionBody('buildAdviceStatusLine');
  assert.ok(line.includes("canary.state === 'pendingApply'"), 'pendingApply 不显示');
  assert.ok(line.includes("canary.state === 'regress'"), 'regress 分支（警示强调）');
  assert.ok(line.includes('sap-adviceStatusLineWarn'), 'regress 警示样式类');
  assert.ok(line.includes("canary.state === 'observing'"), 'observing 分支');
  assert.ok(line.includes('adviceStatusObservingSuffix'), '观察中附「表现下降会提醒你撤销」');
  assert.ok(line.includes('view.canary'), '数据源 = /evolution/assets 派生视图');
  assert.ok(source.includes("api('/evolution/assets')"), '前端新增消费 /evolution/assets');
  assert.ok(routesSource.includes("observing: '观察中'"), '后端 observing label');
  assert.ok(routesSource.includes("stalled: '观察数据不足（未判定），等待更多派发'"), '后端 stalled label');
  assert.ok(routesSource.includes("applied: '观察期结束：表现未下降，已保留'"), '后端 applied label');
  assert.ok(routesSource.includes("regress: '观察期结束：上次的调整表现变差了'"), '后端 regress label（零内部词）');
  assert.ok(routesSource.includes("aborted: '你手动修改了方案，观察已中止（不会再判定）'"), '后端 aborted label');
  assert.ok(routesSource.includes('CANARY_VIEW_LABELS.observing + \'（\' + k + \'/\' + kTotal + \'）\''), 'observing label 带 k/kTotal 进度');
});

// --- 4. 撤销建议区（regress 才渲染；无「忽略」动作） ---------------------------------

test('4 撤销建议区：regress 显示建议/恢复为/证据/双按钮 + 确认弹窗；非 regress 不渲染；无忽略动作', () => {
  const box = functionBody('buildRollbackSuggestion');
  assert.ok(box.includes("canary.state !== 'regress'"), '非 regress 不渲染');
  assert.ok(box.includes('adviceRollbackBoxAdvice'), '建议行「建议撤销这次调整」');
  assert.ok(box.includes('adviceRollbackRestorePrefix'), '恢复为行');
  assert.ok(box.includes('rollbackEvidenceTextOf'), '证据对照行（调整前/后表现分）');
  assert.ok(box.includes('adviceRollbackBtn'), '撤销上次调整按钮');
  assert.ok(box.includes('adviceRollbackKeepBtn'), '继续用当前方案按钮');
  assert.ok(box.includes('actions.openRollbackModal(asset.id)'), '撤销按钮打开确认弹窗');
  assert.ok(box.includes('actions.keepAsset(asset.id)'), '继续用按钮触发显式保留');
  assert.ok(box.includes('adviceRollbackKeepDone'), '已选择保留 → 只读「已选择」行');
  assert.ok(!box.includes('ignore'), '无「忽略」动作');
  const modal = functionBody('buildRollbackModal');
  assert.ok(modal.includes('adviceRollbackModalTitle'), '确认弹窗标题「撤销这次调整？」');
  assert.ok(modal.includes('adviceRollbackModalRestore'), '恢复为字段');
  assert.ok(modal.includes('adviceRollbackModalChange'), '会改变字段');
  assert.ok(modal.includes('adviceRollbackModalNote'), '说明（手动修改后无法一键撤销/记入审计）');
  assert.ok(modal.includes('adviceRollbackConfirm'), '确认撤销按钮');
  assert.ok(modal.includes('actions.rollbackAsset'), '确认触发回滚动作');
  assert.ok(!modal.includes('ignore'), '确认弹窗无「忽略」动作');
  const actions = functionBody('makeApplyFlowActions');
  assert.ok(actions.includes("api('/evolution/rollback', { assetId: modal.assetId, human_confirmed: true, action: 'rollback' })"), '回滚调用点 humanConfirmed:true + action=rollback');
  assert.ok(actions.includes("api('/evolution/rollback', { assetId, human_confirmed: true, action: 'keep' })"), '保留调用点 humanConfirmed:true + action=keep');
});

// --- 5. 进化轨迹小节 ----------------------------------------------------------------

test('5 进化轨迹：assets lifecycle 行渲染；缺失/未应用 → 小节隐藏', () => {
  const timeline = functionBody('buildAdviceTimeline');
  assert.ok(timeline.includes('adviceTimelineTitle'), '小节标题「进化轨迹」');
  assert.ok(timeline.includes('view.lifecycle'), '数据源 = assets lifecycle');
  assert.ok(timeline.includes("lifecycle.length === 0"), '生命周期缺失 → 隐藏小节');
  assert.ok(timeline.includes("!lifecycle.some((e) => e.event === 'applied')"), '未应用（无 applied 事件）→ 隐藏小节');
  assert.ok(timeline.includes('timelineEventTextOf'), '事件行渲染');
  assert.ok(timeline.includes('adviceTimelineStepDim'), '未发生步骤灰字');
  assert.ok(timeline.includes('adviceTimelinePending'), '判定/处理未发生 → 待你处理');
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes('buildAdviceTimeline(el, assetView)'), '轨迹小节挂在建议卡展开区');
  assert.ok(routesSource.includes("event: 'generated'"), '后端下发生成事件');
  assert.ok(routesSource.includes("event: 'applied', meta: '人工确认'"), '后端下发应用事件（人工确认）');
  assert.ok(routesSource.includes("event: 'observed'"), '后端下发观察事件（k/kTotal）');
  assert.ok(routesSource.includes("event: 'judged'"), '后端下发判定事件');
  assert.ok(routesSource.includes("event: 'resolved'"), '后端下发处理事件（你选择…）');
  assert.ok(routesSource.includes('return events.slice(-8)'), '轨迹 ≤8 条');
});

// --- 6. 生命周期徽标 ----------------------------------------------------------------

test('6 生命周期徽标：候选行按 assets stateLabel 渲染；无状态不渲染', () => {
  const row = functionBody('buildAdviceCandidateRow');
  assert.ok(row.includes('candidateAssetByIdOf(s, candidate.id)'), '徽标数据源 = assets（按候选 id 匹配）');
  assert.ok(row.includes("typeof asset.stateLabel === 'string' && asset.stateLabel !== ''"), '仅当状态有意义才渲染');
  assert.ok(row.includes('sap-candidateState'), '徽标样式类');
  assert.ok(routesSource.includes("if (asset.state === 'draft') return '草稿'"), '后端草稿徽标');
  assert.ok(routesSource.includes("if (asset.state === 'expired') return '已过期'"), '后端已过期徽标');
  assert.ok(routesSource.includes("if (asset.state === 'rolled_back') return '已撤销'"), '后端已撤销徽标');
  assert.ok(routesSource.includes("return canary !== null && canary.kept_at !== undefined ? '已保留' : '已应用'"), '后端已应用/已保留徽标');
  assert.ok(routesSource.includes("canary.verdict === 'regress' ? '待撤销' : '观察中'"), '后端待撤销/观察中徽标');
});

// --- 7. 提醒 mint 调用点（回滚建议生成 → 提醒一次；只读跳转无采纳/忽略） -------------

test('7 提醒：mintRollbackReminder 调用点 + 提醒中心只读跳转（无采纳/忽略）', () => {
  assert.ok(indexSource.includes("kind: 'suggestion-rollback'"), '提醒 kind = suggestion-rollback');
  assert.ok(indexSource.includes("title: '自进化撤销建议：'"), '提醒标题人话化');
  assert.ok(indexSource.includes('mintReminder(getReminderStore()'), '经 mintReminder 写入提醒中心');
  assert.ok(canarySource.includes('deps.mintRollbackReminder?.(asset)'), '金丝雀判定调用 mint 钩子');
  assert.ok(canarySource.includes("rollback_reminder_sent: canary.rollback_reminder_sent === true || decision.verdict === 'regress'"), '只提醒一次的落账标记');
  const row = functionBody('buildRollbackReminderRow');
  assert.ok(row.includes('adviceReminderView'), '「查看建议」只读跳转按钮');
  assert.ok(row.includes('jumpToAdvice'), '跳转到建议页签');
  assert.ok(!row.includes("act(r.id, 'adopt')"), '无采纳按钮');
  assert.ok(!row.includes("act(r.id, 'ignore')"), '无忽略按钮');
  assert.ok(!row.includes("act(r.id, 'reject')"), '无拒绝按钮');
});

test('7b 提醒中心组件直传（防元素二次包裹崩溃：设置页空白回归）', () => {
  const maker = functionBody('makeProfilesSection')
  assert.ok(maker.includes('ReminderCenter, sessionsSnapshot'), '以组件引用传入 buildSectionReturn')
  assert.ok(!maker.includes('el(ReminderCenter)'), '不预创建元素（防止 createElement 包裹已创建元素）')
  const shell = functionBody('buildSectionReturn')
  assert.ok(shell.includes('el(reminderCenter, { jumpToAdvice'), '组件经 createElement 注入 jumpToAdvice 属性')
});

// --- 8. 文案卸载 --------------------------------------------------------------------

test('8 文案卸载：grep 无「仅参考/不会自动应用」残留（用户可见面）', () => {
  assert.ok(!source.includes('仅参考'), '无「仅参考」残留');
  assert.ok(!source.includes('不会自动应用'), '无「不会自动应用」残留');
  assert.ok(source.includes("candidateCountNote: ' · 应用前需你确认'"), '数量行新文案');
  assert.ok(source.includes("candidateIntro: '系统基于近期表现生成的改进方案；应用前需要你确认，并进入观察期。'"), '说明句新文案');
});

// --- 9. 冷启动禁用提示（title 含 reason；无弹窗） ------------------------------------

test('9 冷启动：applyEnabled=false → 按钮 title 含 reason；无弹窗', () => {
  const foot = functionBody('buildAdviceFoot');
  assert.ok(foot.includes("if (!applyEnabled) disabledTitle = Array.isArray(status.reasons) && status.reasons.length > 0 ? status.reasons.join('；') : ZH.candidateNotApplicable"), 'title = reasons.join（；）');
  assert.ok(foot.includes("if (!applyEnabled && !observing) notes.push(disabledTitle)"), '卡脚一行灰字');
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes("applyModal.open === true && applyModal.profileKey === a.profileKey"), '弹窗只在点击确认按钮后打开（冷启动无弹窗）');
});

// --- 10. 箭头修正与既有样式快照 -----------------------------------------------------

test('10 审计明细箭头 ▾→▸；摘要行/候选行既有 ▸ 箭头快照不变', () => {
  assert.ok(source.includes("ledgerEvidenceToggle: '查看完整因果链 ▸'"), '审计明细箭头已改 ▸');
  assert.ok(!source.includes('查看完整因果链 ▾'), '▾ 无残留');
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes("el('span', { className: 'sap-adviceSummaryArrow' }, '▸')"), '建议摘要行 ▸ 不变');
  const row = functionBody('buildAdviceCandidateRow');
  assert.ok(row.includes("el('span', { className: 'sap-candidateArrow' }, '▸')"), '候选行 ▸ 不变');
});
