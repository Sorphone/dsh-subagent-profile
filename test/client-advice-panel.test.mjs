// test/client-advice-panel.test.mjs — 建议面板候选分层与候选管理设置机检（0.4.0 候选轮）。
// 覆盖：① 建议一句话「建议：<对象>（降级/升预算） 置信度：<中文>」；② 候选三层
// 结构 + 有效期徽标（⏱ 至 …/⏱ 无期限，渲染条件 expiry）；③ 派发明细折叠行文案
// 「近期派发明细 · N 次」默认收起；④ 安全检查默认收起；⑤ 单选 radio 仅选中、
// 行点击只展开；⑥ 设置对话框（更新模式/有效期档位 + 自定义天数校验）+ 保存动作
// mock 断言；⑦ 卡底部（无方案存为方案 / 有方案灰置调整 + 定位）。纯函数提取执行
// + 源码结构断言（includes，规避正则转义）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
const routesSource = readFileSync(fileURLToPath(new URL('../lib/core/evolution-routes.mjs', import.meta.url)), 'utf8');

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

function functionSource(name) {
  const start = source.indexOf('function ' + name);
  assert.ok(start >= 0, '必须存在函数 ' + name);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('函数括号不平衡：' + name);
}

function constBody(name) {
  const start = source.indexOf('const ' + name + ' = ');
  assert.ok(start >= 0, '必须存在常量 ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('常量括号不平衡：' + name);
}

// 纯函数提取执行（ZH 注入）。
const ZH = new Function('return (' + constBody('ZH') + ')')();
const directionZh = new Function('ZH', 'return (' + functionSource('directionZh') + ')')(ZH);
const adviceSuggestionShort = new Function('ZH', 'directionZh', 'return (' + functionSource('adviceSuggestionShort') + ')')(ZH, directionZh);
const formatMonthDayTime = new Function('return (' + functionSource('formatMonthDayTime') + ')')();
const candidateValidityText = new Function('ZH', 'formatMonthDayTime', 'return (' + functionSource('candidateValidityText') + ')')(ZH, formatMonthDayTime);
const candidateTtlFromForm = new Function('return (' + functionSource('candidateTtlFromForm') + ')')();
const candidateTtlChoiceOf = new Function('return (' + functionSource('candidateTtlChoiceOf') + ')')();
const candidateModeTextOf = new Function('ZH', 'return (' + functionSource('candidateModeTextOf') + ')')(ZH);
const candidateTtlTextOf = new Function('ZH', 'return (' + functionSource('candidateTtlTextOf') + ')')(ZH);

test('摘要行建议短句：对象 + 方向短词（降级/升预算）；无对象描述回退方向词', () => {
  assert.equal(adviceSuggestionShort({ objectText: '模型改用更低档', suggestion: '降' }),
    '建议：模型改用更低档（降级）');
  assert.equal(adviceSuggestionShort({ objectText: '推理强度上调一档', suggestion: '升' }),
    '建议：推理强度上调一档（升预算）');
  assert.equal(adviceSuggestionShort({ objectText: '', suggestion: '降' }),
    '建议降级', '无对象描述回退方向词');
});

test('有效期徽标：null=⏱ 无期限；数字=⏱ 至 MM-DD HH:mm（渲染条件 expiry）', () => {
  assert.equal(candidateValidityText(null), '⏱ 无期限');
  assert.equal(candidateValidityText(undefined), '⏱ 无期限');
  const stamp = new Date(2026, 8, 2, 14, 0).getTime();
  assert.equal(candidateValidityText(stamp), '⏱ 至 ' + formatMonthDayTime(stamp));
  const row = functionBody('buildAdviceCandidateRow');
  assert.ok(row.includes('candidateValidityText(candidate.expiry)'), '徽标按候选 expiry 渲染在行内');
});

test('摘要行结构：对象/无方案 tag/建议短句/置信度/加权成功分/▼，点击展开（默认收起）', () => {
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes('sap-adviceSummary'), '摘要行容器');
  assert.ok(card.includes("'aria-expanded': open"), '摘要行可访问折叠态');
  assert.ok(card.includes('actions.toggleAdviceOpen(a.profileKey)'), '点击摘要行展开/收起');
  assert.ok(card.includes('adviceSummaryObjectText(profile, a.profileKey)'), '对象由方案匹配推导');
  assert.ok(card.includes("profile === null ? el('span', { className: 'sap-adviceNoProfileTag' }, ZH.adviceNoProfileTag) : null"), '无方案 tag 条件渲染');
  assert.ok(source.includes("adviceNoProfileTag: '无方案'"), '无方案 tag 文案');
  assert.ok(card.includes('adviceSuggestionShort(a)'), '建议短句');
  assert.ok(card.includes('ZH.adviceConfidence + confidenceZhOf(a.confidence)'), '置信度中文独立成列');
  assert.ok(card.includes("metric.startsWith('加权成功分 ')"), '摘要行加权成功分');
  assert.ok(card.includes("'▼'"), '摘要行展开箭头');
  assert.ok(card.includes("open !== true ? null : el('div', { className: 'sap-adviceDetail' }"), '展开区默认收起');
  assert.ok(card.includes("' sap-adviceItemOpen'"), '展开态卡片边界标记');
});

test('展开区顺序：理由高亮 → 明细 → 汇总（同左缘）→ 候选标注 → 操作区', () => {
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes('sap-adviceWhyBox'), '理由高亮区');
  assert.ok(card.includes("el('b', null, ZH.adviceReasonPrefix)"), '理由前缀加粗');
  const why = card.indexOf('sap-adviceWhyBox');
  const detail = card.indexOf('buildAdviceDetails');
  const metrics = card.indexOf('sap-adviceMetrics');
  const cand = card.indexOf('buildAdviceCandidates');
  const foot = card.indexOf('buildAdviceFoot');
  assert.ok(why >= 0 && detail >= 0 && metrics >= 0 && cand >= 0 && foot >= 0, '五段必须齐全');
  assert.ok(why < detail && detail < metrics && metrics < cand && cand < foot, '顺序 = 理由→明细→汇总→候选→操作');
  assert.match(source, /\.sap-adviceMetrics\{[^}]*margin:0/, '汇总与明细同左缘（margin-left:0）');
  assert.ok(card.includes("metrics.join(' · ')"), '汇总 = 加权成功分/耗时/输出单行');
});

test('派发明细折叠行：近期派发明细 · N 次（点击展开）文案 + 默认收起', () => {
  assert.ok(source.includes("adviceDetailTogglePrefix: '近期派发明细 · '"));
  assert.ok(source.includes("adviceDetailToggleSuffix: ' 次（点击展开）'"));
  const detail = functionBody('buildAdviceDetails');
  assert.ok(detail.includes('ZH.adviceDetailTogglePrefix + rows.length + ZH.adviceDetailToggleSuffix'), 'N 次来自明细行数');
  assert.ok(detail.includes("'aria-expanded': open"), '折叠态可访问');
  assert.ok(detail.includes("map[profileKey] === true"), '默认收起（detailOpen 未置不展开）');
  assert.ok(detail.includes('adviceDetailColSession'), '主会话列');
  assert.ok(detail.includes('adviceDetailColChild'), '子 Agent 列');
  assert.ok(detail.includes('dispatchOutcomeZh[row.outcome]'), '结果人话映射');
  assert.ok(detail.includes("row.outcome === 'failed' || row.outcome === 'killed'"), '失败/终止红色标出');
  assert.ok(detail.includes('reminderSessionTitle(sessions, row.sessionId)'), '主会话标题按 sessionId 查');
  assert.ok(detail.includes('childIdShortOf(row.childId)'), '子 Agent id 截断');
  assert.ok(detail.includes('formatDurationMs(row.elapsedMs)'), '耗时短时格式');
});

test('安全检查默认收起：展开区内部 toggle（全部通过 ✓ ▸），点击才展开四项', () => {
  assert.ok(source.includes("candidateSafetyPrefix: '安全检查：'"));
  assert.ok(source.includes("candidateSafetyPass: '全部通过 ✓'"));
  const row = functionBody('buildAdviceCandidateRow');
  assert.ok(row.includes('candidateSafetyToggle'), '安全检查自带收起 toggle');
  assert.ok(row.includes('safetyOpen === true ? buildDraftPreview(el, preview) : null'), '默认收起不渲染四项');
  assert.ok(row.includes('actions.toggleCandidateSafety(candidate)'), '点击 toggle 展开/收起');
});

test('单选 radio：仅选中（候选第一条默认选中），行点击只展开', () => {
  const select = functionBody('candidateSelectedIdOf');
  assert.ok(select.includes("candidates[0].id"), '默认选中第一条候选');
  assert.ok(select.includes("candidates.some((c) => c && c.id === current)"), '失效选中回退第一条');
  const row = functionBody('buildAdviceCandidateRow');
  assert.ok(row.includes("selected === candidate.id ? ' sap-candidateSelected' : ''"), '仅选中的候选有选中态');
  assert.ok(row.includes('sap-candidateRow'), '整行可点击（只展开）');
});

test('候选三层结构：标题行（方角标签 + N 个 · 单选）→ 说明句 → 候选项列表', () => {
  const block = functionBody('buildAdviceCandidates');
  assert.ok(block.includes("ZH.candidateTitle, el('span', { className: 'sap-candidatesNotApplied' }, ZH.candidateNotApplied)"), '标题行方角标签 + 未应用灰注');
  assert.ok(block.includes("candidates.length + ZH.candidateCountSuffix"), '数量 + 单选');
  assert.ok(block.includes('sap-candidatesDesc'), '说明一句');
  assert.ok(block.includes('candidateIntro'));
  assert.ok(block.includes('buildAdviceCandidateRow'), '候选项列表');
});

test('设置浮层：更新模式/有效期档位/自定义输入，模式说明随模式切换', () => {
  const panel = functionBody('buildCandidateSettingsPanel');
  assert.ok(panel.includes("ZH.candidateModeAuto + '（推荐）'"), '自动换新（推荐）');
  assert.ok(panel.includes('candidateModeManual'), '手动维护选项');
  assert.ok(panel.includes('candidateSettingsModeManualText'), '手动说明随模式切换');
  assert.ok(panel.includes('candidateSettingsModeAutoText'), '自动说明随模式切换');
  assert.ok(panel.includes('candidateTtl24'), '24 小时档');
  assert.ok(panel.includes('candidateTtl72'), '3 天档');
  assert.ok(panel.includes('candidateTtl168'), '7 天档');
  assert.ok(panel.includes('candidateTtl0'), '不自动过期档');
  assert.ok(panel.includes("ttlChoice === 'custom'"), '自定义档显示天数输入');
  assert.ok(panel.includes('candidateSettingsCustomLabel'), '自定义天数（1~365）');
  assert.ok(panel.includes('actions.saveCandidateSettings'), '保存按钮');
  assert.ok(panel.includes('actions.cancelCandidateSettings'), '取消按钮');
  const row = functionBody('buildCandidateSettingsRow');
  assert.ok(row.includes('candidateModeTextOf'), '顶部设置行显示当前模式');
  assert.ok(row.includes('candidateTtlTextOf'), '顶部设置行显示当前有效期');
  assert.ok(row.includes('sap-candidateSettingsEdit'), '修改 ⚙ 入口');
  assert.ok(row.includes('ZH.candidateSettingsEdit'));
});

test('自定义有效期校验：1~365 整数天 ×24 小时；非法返回 null', () => {
  assert.equal(candidateTtlFromForm({ candidateTtlChoice: 'custom', customDays: '2' }), 48);
  assert.equal(candidateTtlFromForm({ candidateTtlChoice: 'custom', customDays: '365' }), 365 * 24);
  assert.equal(candidateTtlFromForm({ candidateTtlChoice: 'custom', customDays: '0' }), null, '0 天非法');
  assert.equal(candidateTtlFromForm({ candidateTtlChoice: 'custom', customDays: '366' }), null, '超 365 非法');
  assert.equal(candidateTtlFromForm({ candidateTtlChoice: 'custom', customDays: 'abc' }), null, '非数字非法');
  assert.equal(candidateTtlFromForm({ candidateTtlChoice: '24' }), 24, '档位原样');
  assert.equal(candidateTtlFromForm({ candidateTtlChoice: '0' }), 0, '不自动过期');
  assert.equal(candidateTtlChoiceOf(48), 'custom', '非档位值落自定义档');
  assert.equal(candidateTtlChoiceOf(24), '24');
});

test('设置行文案：自动换新/手动维护 + 有效期人话（24 小时/3 天/7 天/不自动过期）', () => {
  assert.equal(candidateModeTextOf('auto'), '自动换新');
  assert.equal(candidateModeTextOf('manual'), '手动维护');
  assert.equal(candidateTtlTextOf(24), '24 小时');
  assert.equal(candidateTtlTextOf(72), '3 天');
  assert.equal(candidateTtlTextOf(168), '7 天');
  assert.equal(candidateTtlTextOf(0), '不自动过期');
  assert.equal(candidateTtlTextOf(48), '48 小时');
});

test('保存候选设置：自定义天换算小时 POST /settings/candidate；非法就地报错不发请求', () => {
  const makeActions = new Function('ZH', 'candidateTtlChoiceOf', 'candidateTtlFromForm', 'return (' + functionSource('makeCandidateSettingsActions') + ')')(ZH, candidateTtlChoiceOf, candidateTtlFromForm);
  const calls = [];
  const state = {
    candidateSettings: { candidateMode: 'auto', candidateTtlH: 48 },
    candidateSettingsOpen: false,
    candidateSettingsForm: { candidateMode: 'auto', candidateTtlChoice: 'custom', customDays: '2', error: '' },
  };
  const s = {
    candidateSettings: state.candidateSettings,
    candidateSettingsOpen: false,
    get candidateSettingsForm() { return state.candidateSettingsForm },
    setCandidateSettingsOpen: (next) => { state.open = next },
    setCandidateSettingsForm: (next) => { state.candidateSettingsForm = typeof next === 'function' ? next(state.candidateSettingsForm) : next },
    setCandidateSettings: (next) => { state.candidateSettings = next },
    setError: () => {},
    setSavedNotice: () => {},
    setPersistWarning: () => {},
  };
  const api = async (route, payload) => {
    calls.push({ route, payload });
    return { ok: true, persisted: true, candidateMode: payload.candidateMode, candidateTtlH: payload.candidateTtlH };
  };
  const actions = makeActions(api, s, () => {}, (data, notice) => { state.notice = notice });
  actions.saveCandidateSettings();
  assert.equal(calls.length, 1, '合法表单发出保存请求');
  assert.equal(calls[0].route, '/settings/candidate');
  assert.deepEqual(calls[0].payload, { candidateMode: 'auto', candidateTtlH: 48 }, '自定义 2 天 → 48 小时');
  // 非法自定义：就地报错，不发请求。
  state.candidateSettingsForm = { candidateMode: 'manual', candidateTtlChoice: 'custom', customDays: '999', error: '' };
  const before = calls.length;
  actions.saveCandidateSettings();
  assert.equal(calls.length, before, '非法天数不发请求');
  assert.equal(state.candidateSettingsForm.error, ZH.candidateSettingsCustomInvalid, '错误文案就地展示');
});

test('重新生成候选与保存为方案：分别走 /evolution/regenerate 与 /advice/save-profile', () => {
  const makeActions = new Function('ZH', 'candidateTtlChoiceOf', 'candidateTtlFromForm', 'return (' + functionSource('makeCandidateSettingsActions') + ')')(ZH, candidateTtlChoiceOf, candidateTtlFromForm);
  const calls = [];
  const state = { form: { candidateMode: 'auto', candidateTtlChoice: '24', customDays: '', error: '' } };
  const s = {
    candidateSettings: { candidateMode: 'auto', candidateTtlH: 24 },
    candidateSettingsOpen: false,
    candidateSettingsForm: state.form,
    setCandidateSettingsOpen: () => {},
    setCandidateSettingsForm: () => {},
    setCandidateSettings: () => {},
    setError: () => {},
    setSavedNotice: () => {},
    setPersistWarning: () => {},
  };
  const api = async (route, payload) => {
    calls.push({ route, payload });
    return { ok: true, persisted: true, id: 'advice-preset-standard' };
  };
  const actions = makeActions(api, s, () => {}, () => {});
  actions.regenerateCandidates('preset:standard')();
  assert.deepEqual(calls[calls.length - 1], { route: '/evolution/regenerate', payload: { profileKey: 'preset:standard' } });
  actions.saveAdviceProfile('preset:standard')();
  assert.deepEqual(calls[calls.length - 1], { route: '/advice/save-profile', payload: { profileKey: 'preset:standard' } });
});

test('卡底部：无对应方案 [保存为方案]；有对应方案灰置[按建议调整方案] + 定位到方案管理', () => {
  assert.ok(source.includes("adviceSaveProfile: '保存为方案'"));
  assert.ok(source.includes("adviceApplyDisabled: '按建议调整方案'"));
  assert.ok(source.includes("adviceRowLocate: '定位到方案管理'"));
  const foot = functionBody('buildAdviceFoot');
  assert.ok(foot.includes('adviceFootPrimary'), '保存为方案主按钮');
  assert.ok(foot.includes('actions.saveAdviceProfile(a.profileKey)'), '保存走来源配置');
  assert.ok(foot.includes('adviceFootDisabled'), '灰置按建议调整方案');
  assert.ok(foot.includes('disabled: true'), '调整按钮不可点');
  assert.ok(foot.includes("title: ZH.candidateNotApplicable"), '灰置提示应用功能后续开放');
  assert.ok(foot.includes('actions.locateProfile(profile.id)'), '定位到方案管理可用');
  assert.ok(foot.includes('adviceFootNoteSave'), '无方案卡备注说明存的是当前配置');
  assert.ok(source.includes("adviceFootNoteSave: '仅保存预设、模型与提供方；自定义人格与工具过滤无法还原（隐私保护不落盘），如需完整配置请手动编辑方案。'"), '按钮副注注明只存可还原配置');
  assert.ok(foot.includes('adviceFootNoteMatchedPrefix'), '有方案卡备注带方案名');
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes('buildAdviceFoot'), '每张建议卡都带底部操作区');
  assert.ok(!card.includes('存为草稿'), '不做存为草稿方案');
});

test('保存为方案路由：description 注明配置快照仅预设/模型/提供方（人格与工具过滤不落盘）', () => {
  assert.ok(routesSource.includes("description: '来自建议面板的配置快照（仅预设/模型/提供方；人格与工具过滤不落盘，按隐私设计）。便于复用与对比。'"), '路由 description 按隐私设计诚实化');
  assert.ok(!routesSource.includes('由建议面板保存的当前派发配置'), '旧 description 文案已替换');
});

test('生成信息行：生成于 MM-DD、基于当时数据（N=…、加权 …）+ 应用提示', () => {
  const line = functionBody('candidateGeneratedLine');
  assert.ok(line.includes("ZH.candidateGeneratedPrefix + formatMonthDayTime(basis.generatedAt)"), '生成时间');
  assert.ok(line.includes('basis.n'), '样本数');
  assert.ok(line.includes('basis.score'), '加权成功分');
  assert.ok(source.includes("candidateNotApplicable: '应用功能在后续版本开放（届时会先经你确认）'"), '应用提示收进展开区尾部');
});
