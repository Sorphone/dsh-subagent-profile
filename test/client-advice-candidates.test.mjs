// test/client-advice-candidates.test.mjs — 候选可见性与 profileKey 文案人话化机检
// （0.4.0 发版前补丁）：client.js 是浏览器 bundle（window.__ModuleLoader__），无 DOM
// 测试基建，故本文件以源码结构断言 + profileKeyZh 纯函数提取执行（全段组合）。
// 覆盖：① 建议行标题人话化；② 候选方案区（徽标/预览/不可应用提示/无候选不占位）；
// ③ 建议行去向文案与置信度中文映射；④ tokenTier 估算口径文案。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
const routesSource = readFileSync(fileURLToPath(new URL('../lib/core/http-routes.mjs', import.meta.url)), 'utf8');

// 切片提取：函数体（第一个 '{' 到配对 '}'，处理字符串/注释外的简单平衡）。
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

// 提取完整函数源码（从 function 声明到配对 }）供 eval 执行。
function functionSource(name) {
  const start = source.indexOf('function ' + name);
  assert.ok(start >= 0, `必须存在函数 ${name}`);
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

// profileKeyZh 是零依赖纯函数：提取后直接执行全分支断言。
const profileKeyZh = new Function('return (' + functionSource('profileKeyZh') + ')')();

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

test('建议行标题走 profileKeyZh，可见面不再直出原始 profileKey 串', () => {
  const panel = functionBody('buildAdvicePanel');
  assert.match(panel, /className: 'sap-rowName'[^)]*profileKeyZh/);
  assert.doesNotMatch(panel, /className: 'sap-rowName'[^)]*String\(a\.profileKey\)/);
});

test('建议行去向文案：匹配显示方案名 + 定位；未匹配显示说明性文案', () => {
  const panel = functionBody('buildAdvicePanel');
  assert.match(panel, /adviceRowMatch/);
  assert.match(panel, /adviceRowNoMatch/);
  assert.match(source, /adviceRowNoMatch: '未匹配到方案（手动配置的派发）'/);
  assert.match(source, /confidenceZh: \{ low: '低', medium: '中等', high: '高' \}/);
  assert.match(panel, /confidenceZhOf\(a\.confidence\)/);
});

test('建议行下挂候选方案区：徽标 + 预览 + 不可应用提示，无候选不占位', () => {
  const panel = functionBody('buildAdvicePanel');
  assert.match(panel, /buildAdviceCandidate/);
  assert.match(panel, /candidate !== undefined \? buildAdviceCandidate/);
  const cand = functionBody('buildAdviceCandidate');
  for (const key of ['candidateBadge', 'candidatePreview', 'candidateNotApplicable']) {
    assert.match(cand, new RegExp(key), '候选区必须含 ' + key);
  }
  assert.match(cand, /previewCandidate/);
  assert.match(cand, /profileKeyZh\(candidate\.profile_key/);
  assert.match(cand, /'预设：'/);
  assert.match(cand, /'模型：'/);
  assert.match(cand, /draftPreviews/);
});

test('候选预览复用 /draft/preview 只读流，不带 apply 写回入口', () => {
  const act = functionBody('makeCandidateActions');
  assert.match(act, /\/draft\/preview/);
  assert.doesNotMatch(act, /\/evolution\/apply/);
});

test('/list 复用现有通道下发候选（source=evolution 且 draft，不新增路由）', () => {
  assert.match(routesSource, /evolutionCandidates/);
  assert.match(routesSource, /Array\.isArray\(result\.candidates\)/);
});

test('tokenTier 估算口径：结果卡 chip 与表单说明，无裸「档位」字符串残留', () => {
  assert.match(source, /chipTier: '档位（估算口径）'/);
  assert.match(source, /ledgerByTier: '按档位（估算口径）'/);
  assert.match(source, /tokenTier: '档位（估算口径）'/);
  assert.match(source, /modelEfforts: '模型支持的推理强度'/);
  assert.match(source, /tierFormHint: '档位仅影响估算与方案排序，不改变派发模型；显式选择模型才决定实际模型'/);
  const card = functionBody('buildAddCard');
  assert.match(card, /buildTierField/);
  assert.equal(source.includes("'档位'"), false, '不得再出现裸「档位」字符串');
  assert.equal(source.includes("'按档位'"), false, '不得再出现裸「按档位」字符串');
  assert.equal(source.includes("'模型支持档位'"), false, '不得再出现裸「模型支持档位」字符串');
});
