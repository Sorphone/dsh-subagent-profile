// test/client-advice-candidates.test.mjs — 建议面板信息架构机检（候选分层轮）。
// client.js 是浏览器 bundle（window.__ModuleLoader__），无 DOM 测试基建，故本文件以
// 源码结构断言（includes，规避正则转义）+ 纯函数提取执行（含可关闭 toggle 的 mock 断言）。
// 覆盖：① profileKeyZh 文案人话化；② CHECK_ZH 安全检查四项人话映射；③ 建议卡结构
// （标题=建议对象 / 对应关系行 / 指标只渲染一遍 / 建议直接带对象）；④ 候选方案区
// （三层结构 + 单选 + 行点击只展开）；⑤ 候选预览复用 /draft/preview 只读流；
// ⑥ /list 下发候选、派发明细与 tokenTier 口径不变。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
const routesSource = readFileSync(fileURLToPath(new URL('../lib/core/http-routes.mjs', import.meta.url)), 'utf8');

// 切片提取：函数体（第一个 '{' 到配对 '}'，处理字符串/注释外的简单平衡）。
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

// 提取完整函数源码（从 function 声明到配对 }）供 eval 执行。
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

// 提取 const NAME = { ... } 的对象字面量（简单平衡括号）。
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

// 纯函数提取执行（零依赖；ZH 常量单独提取注入）。
const ZH = new Function('return (' + constBody('ZH') + ')')();
const profileKeyZh = new Function('return (' + functionSource('profileKeyZh') + ')')();
const adviceObjectTitleOf = new Function('ZH', 'return (' + functionSource('adviceObjectTitleOf') + ')')(ZH);
const adviceEvidenceOf = new Function('return (' + functionSource('adviceEvidenceOf') + ')')();
const candidateChangesOf = new Function('return (' + functionSource('candidateChangesOf') + ')')();
const CHECK_ZH = new Function('return (' + constBody('CHECK_ZH') + ')')();
const adviceSummaryObjectText = new Function('ZH', 'adviceObjectTitleOf', 'profileKeyZh', 'return (' + functionSource('adviceSummaryObjectText') + ')')(ZH, adviceObjectTitleOf, profileKeyZh);

test('profileKeyZh：单段映射（preset/provider/model/persona/toolFilter/effort）', () => {
  assert.equal(profileKeyZh('preset:standard'), '预设：standard');
  assert.equal(profileKeyZh('provider:p1'), '提供方：p1');
  assert.equal(profileKeyZh('model:deepseek-v4-pro'), '模型：deepseek-v4-pro');
  assert.equal(profileKeyZh('persona:1'), '含自定义人格');
  assert.equal(profileKeyZh('toolFilter:1'), '含工具过滤');
  assert.equal(profileKeyZh('effort:off'), '推理强度：off');
});

test('profileKeyZh：段组合以 · 连接与兜底（inline/空键/未知段）', () => {
  assert.equal(profileKeyZh('preset:standard|persona:1|toolFilter:1'), '预设：standard · 含自定义人格 · 含工具过滤');
  assert.equal(profileKeyZh('(inline)'), '未存方案');
  assert.equal(profileKeyZh('(inline)|effort:off'), '未存方案 · 推理强度：off');
  assert.equal(profileKeyZh(''), '未指定方案特征');
  assert.equal(profileKeyZh('unknown:1'), 'unknown:1', '未知段原样保留');
});

test('CHECK_ZH：安全检查四项人话映射，原词只留 tooltip 供排查', () => {
  assert.deepEqual(CHECK_ZH, {
    sanitize: '配置格式检查',
    id: '方案编号不冲突',
    whitelist: '工具范围安全检查',
    catalog: '模型目录有效',
  });
  const preview = functionBody('buildDraftPreview');
  assert.ok(preview.includes('CHECK_ZH[c.name] || c.name'), '检查项展示必须走 CHECK_ZH，未知项回退原样');
  assert.ok(preview.includes('title: c.name'), '原始检查项名只保留在 tooltip');
});

test('摘要行对象 = 建议对象（已有方案/手动配置+特征），无方案挂 tag', () => {
  assert.equal(adviceObjectTitleOf({ id: 'swap-standard', name: '标准编码' }), '方案：标准编码');
  assert.equal(adviceObjectTitleOf(null), '手动配置的派发');
  assert.equal(adviceSummaryObjectText({ id: 'swap-standard', name: '标准编码' }, 'preset:standard'), '方案：标准编码');
  assert.equal(adviceSummaryObjectText(null, '(inline)|persona:1'), '手动配置的派发（含自定义人格）');
  assert.equal(adviceSummaryObjectText(null, '(inline)'), '手动配置的派发', '无特征时不带空括号');
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes('adviceSummaryObjectText(profile, a.profileKey)'), '摘要行对象必须由建议对象推导');
  assert.ok(card.includes('sap-adviceNoProfileTag'), '无方案 tag 挂摘要行');
  assert.ok(!card.includes('adviceCardTitleOf'), '旧的「建议卡 · 基于最近 N 次派发」标题已移除');
});

test('对应方案：有方案进底部备注（名称 + id），无方案摘要行带「无方案」tag', () => {
  const foot = functionBody('buildAdviceFoot');
  assert.ok(foot.includes('adviceFootNoteMatchedPrefix'), '有方案备注前缀');
  assert.ok(foot.includes('(profile.name || profile.id)'), '有方案备注带名称');
  assert.ok(foot.includes("'（' + profile.id + '）'"), '有方案备注带 id');
  assert.ok(source.includes("adviceNoProfileTag: '无方案'"), '无方案 tag 文案');
});

test('指标只渲染一遍：单行「加权成功分 · 平均耗时 · 平均输出」，不再重复计数行', () => {
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes('adviceMetricsOf(a.performanceText)'));
  assert.ok(card.includes("metrics.join(' · ')"));
  const uses = card.split('a.performanceText').length - 1;
  assert.equal(uses, 1, '表现文本只进指标换算一次');
  assert.ok(!card.includes('evidence.counts'), '计数不再单独成行（进派发明细表）');
  assert.deepEqual(
    adviceEvidenceOf('过去 3 次：完成 1、失败 0、终止 2，加权成功分 0.033，平均耗时 50ms，平均输出 27 字符'),
    { counts: '完成 1、失败 0、终止 2', metrics: ['加权成功分 0.033', '平均耗时 50ms', '平均输出 27 字符'] }
  );
});

test('摘要行建议短句与展开区理由：对象描述/方向短词/理由高亮', () => {
  assert.ok(source.includes("adviceSuggestionPrefix: '建议：'"));
  assert.ok(source.includes("adviceReasonPrefix: '理由：'"));
  assert.ok(source.includes("adviceDirShortDown: '降级'"));
  assert.ok(source.includes("adviceDirShortUp: '升预算'"));
  assert.ok(source.includes("confidenceZh: { low: '低', medium: '中等', high: '高' }"));
  const card = functionBody('buildAdviceCard');
  assert.ok(card.includes('adviceSuggestionShort(a)'), '建议短句统一走纯函数');
  assert.ok(card.includes('sap-adviceWhyBox'), '理由高亮区渲染 reasonText');
  assert.ok(card.includes('ZH.adviceReasonPrefix'), '理由前缀');
  const suggestion = functionBody('adviceSuggestionShort');
  assert.ok(suggestion.includes('objectText'), '建议必须带对象描述');
  assert.ok(suggestion.includes('adviceDirShortDown'));
  assert.ok(suggestion.includes('directionZh(a.suggestion)'), '无对象描述时回退旧格式（信息不删）');
});

test('候选方案区：三层结构（标题行/说明句/候选项行）+ 手动维护才给重新生成', () => {
  const block = functionBody('buildAdviceCandidates');
  assert.ok(block.includes('sap-candidatesTitle'), '标题行方角标签');
  assert.ok(block.includes('candidateNotApplied'), '未应用灰注');
  assert.ok(block.includes('candidates.length + ZH.candidateCountSuffix'), '数量 + 单选');
  assert.ok(block.includes('candidateIntro'), '一句说明');
  assert.ok(block.includes("candidateMode === 'manual'"), '重新生成候选只在手动维护出现');
  assert.ok(block.includes('actions.regenerateCandidates'));
  assert.ok(source.includes("candidateRegenerate: '重新生成候选'"));
});

test('候选行：radio 仅选中、行点击只展开；有效期徽标在行右侧', () => {
  const row = functionBody('buildAdviceCandidateRow');
  assert.ok(row.includes("role: 'radio'"), '单选 radio');
  assert.ok(row.includes('actions.selectCandidate(a.profileKey, candidate.id)'), 'radio 点击只选中');
  assert.ok(row.includes('stopPropagation'), 'radio 点击不冒泡成行展开');
  assert.ok(row.includes('actions.toggleCandidateOpen(candidate)'), '行点击只展开');
  assert.ok(row.includes('candidateValidityText(candidate.expiry)'), '有效期徽标按候选行渲染');
  assert.ok(row.includes('sap-candidateValidity'));
  assert.ok(row.includes("'候选 ' + (index + 1) + ' · ' + candidate.name"), '候选编号与名字');
  assert.ok(row.includes('buildDraftPreview'), '安全检查仍在候选展开区内');
  assert.ok(row.includes('candidateSafetyPending'), '安全检查未返回时给核对中占位');
  assert.ok(row.includes('candidateSafetyToggle'), '安全检查默认收起（toggle 展开四项）');
});

test('candidateChangesOf：改动项人话（去掉结构 / 换成新值）', () => {
  assert.deepEqual(candidateChangesOf('preset:standard|persona:1|toolFilter:1', { preset: 'standard' }),
    ['去掉自定义人格', '去掉工具过滤']);
  assert.deepEqual(candidateChangesOf('preset:code|model:deepseek-pro', { preset: 'code', model: 'deepseek-flash' }),
    ['模型 → deepseek-flash']);
  assert.deepEqual(candidateChangesOf('preset:standard', { preset: 'code' }), ['预设 → code']);
  assert.deepEqual(candidateChangesOf('effort:low', { reasoningEffort: 'medium' }), ['推理强度 → medium']);
  assert.deepEqual(candidateChangesOf('effort:off', { maxTokens: 2000 }), ['token 上限 → 2000']);
  assert.deepEqual(candidateChangesOf('preset:standard|persona:1', { preset: 'standard', persona_present: true }), []);
});

test('候选 toggle 可关闭：展开拉取安全检查、收起不重复拉取（mock 断言）', async () => {
  const makeCandidateActions = new Function('return (' + functionSource('makeCandidateActions') + ')')();
  const calls = [];
  let open = {};
  let safety = {};
  let selected = {};
  const s = {
    setError: () => {},
    draftPreviews: {},
    setDraftPreviews: (next) => { s.draftPreviews = next },
    get candidateOpen() { return open },
    setCandidateOpen: (next) => { open = next },
    get candidateSafetyOpen() { return safety },
    setCandidateSafetyOpen: (next) => { safety = next },
    get candidateSelected() { return selected },
    setCandidateSelected: (next) => { selected = next },
    get detailOpen() { return {} },
    setDetailOpen: () => {},
  };
  const api = async (route) => {
    calls.push(route);
    return { ok: true, checks: [{ name: 'sanitize', verdict: 'pass' }] };
  };
  const actions = makeCandidateActions(api, s);
  const candidate = { id: 'evo-down-x', config: {}, name: '', description: '' };
  actions.toggleCandidateOpen(candidate)();
  assert.equal(open['evo-down-x'], true, '行点击 → 展开');
  assert.deepEqual(calls, ['/draft/preview'], '展开时复用只读安全检查预览流');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(s.draftPreviews['evo-down-x'].ok, true, '安全检查结果写入预览态');
  actions.selectCandidate('preset:standard', 'evo-down-x')();
  assert.equal(selected['preset:standard'], 'evo-down-x', 'radio 点击只写选中态');
  assert.equal(open['evo-down-x'], true, '选中不影响展开态');
  actions.toggleCandidateSafety(candidate)();
  assert.equal(safety['evo-down-x'], true, '安全检查默认收起，可展开');
  actions.toggleCandidateOpen(candidate)();
  assert.equal(open['evo-down-x'], false, '再点一次 → 收起（可关闭）');
  assert.deepEqual(calls, ['/draft/preview'], '收起不重复拉取');
  assert.equal(s.draftPreviews['evo-down-x'].ok, true, '收起保留已拉取的安全检查结果');
});

test('候选预览复用 /draft/preview 只读流，不带 apply 写回入口', () => {
  const act = functionBody('makeCandidateActions');
  assert.ok(act.includes('/draft/preview'));
  assert.ok(!act.includes('/evolution/apply'));
});

test('/list 复用现有通道下发候选与派发明细（不新增路由）', () => {
  assert.ok(routesSource.includes('evolutionCandidates'));
  assert.ok(routesSource.includes('Array.isArray(result.candidates)'));
  assert.ok(routesSource.includes('adviceDetails'));
});

test('tokenTier 估算口径：结果卡 chip 与表单说明，无裸「档位」字符串残留', () => {
  assert.ok(source.includes("chipTier: '档位（估算口径）'"));
  assert.ok(source.includes("ledgerByTier: '按档位（估算口径）'"));
  assert.ok(source.includes("tokenTier: '档位（估算口径）'"));
  assert.ok(source.includes("modelEfforts: '模型支持的推理强度'"));
  assert.ok(source.includes("tierFormHint: '档位仅影响估算与方案排序，不改变派发模型；显式选择模型才决定实际模型'"));
  const card = functionBody('buildAddCard');
  assert.ok(card.includes('buildTierField'));
  assert.equal(source.includes("'档位'"), false, '不得再出现裸「档位」字符串');
  assert.equal(source.includes("'按档位'"), false, '不得再出现裸「按档位」字符串');
  assert.equal(source.includes("'模型支持档位'"), false, '不得再出现裸「模型支持档位」字符串');
});
