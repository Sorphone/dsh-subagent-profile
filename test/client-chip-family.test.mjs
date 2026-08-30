// test/client-chip-family.test.mjs — Task 45（SC1 层 1）机检：三处展示同一 chip
// 组件族 + 同口径（父会话 dispatch 卡片 / 子会话页头 banner / 设置页方案卡）。
// client.js 是浏览器 bundle（window.__ModuleLoader__），无 DOM 测试基建，故本文件
// 以源码结构断言（读取源码字符串做确定性机检），与 node --check 共同构成 client 门禁。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

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

test('父卡与方案卡使用同一 chip 组件族，banner 收敛为单一摘要标签', () => {
  // makeChip 是唯一 chip 工厂，返回 (key,label,value,opts) 组件；父卡与方案卡经 chip 参数接收。
  assert.match(source, /function makeChip\(el\)/);
  const dispatchChips = functionBody('buildDispatchChips');
  assert.match(dispatchChips, /chip\(/, '父卡 chip 行必须使用 chip 组件族');
  const profileRows = functionBody('buildProfileRows');
  assert.match(profileRows, /chip\(/, '方案卡 chipItems 必须使用 chip 组件族');
  const banner = functionBody('buildSubagentBanner');
  assert.doesNotMatch(banner, /chip\(/, 'banner 不再使用多 chip 行（单一摘要标签）');
  assert.match(banner, /sap-subagentBannerTag/, 'banner 必须渲染单一摘要标签');
});

test('Task 45：父卡 chip 行未展开即渲染（chips 在摘要/详情折叠之外）', () => {
  const body = functionBody('DispatchToolview');
  const retIdx = body.indexOf('return el(');
  assert.ok(retIdx >= 0, 'DispatchToolview 必须返回元素树');
  const tree = body.slice(retIdx);
  const chipsIdx = tree.indexOf("el('div', { className: 'sap-chips' }, chips)");
  const detailToggleIdx = tree.indexOf('detailToggle');
  assert.ok(chipsIdx >= 0, '父卡 chips 行必须存在');
  assert.ok(detailToggleIdx < 0 || chipsIdx < detailToggleIdx, 'chips 行必须先于详情折叠入口渲染（未展开即渲染）');
});

test('Task 45：banner 注册到 conversation.session.header.utilities 槽', () => {
  assert.match(source, /conversation\.session\.header\.utilities/);
  assert.match(source, /dsh-subagent-profile-subagent/, 'banner 条目 id 存在');
});

test('banner 最终形态：单一摘要标签 + title 全量详情 + 来源移入 title', () => {
  // 摘要标签：继承场景固定「继承父会话 · 模式」，有值场景按模型 · 强度 · 模式。
  const summary = functionBody('bannerSummaryText');
  assert.match(summary, /bannerInheritValue \+ ' · ' \+ bannerModeText/, '继承场景摘要必须固定文案');
  assert.match(summary, /\.join\(' · '\)/, '有值场景摘要必须 · 分隔');
  assert.match(summary, /bannerModelText/);
  assert.match(summary, /bannerEffortText/);
  // title 全量详情：模型/推理强度/预设/模式/来源五行，来源含完整父会话 id。
  const title = functionBody('bannerTitleText');
  for (const key of ['chipModel', 'chipEffort', 'chipPreset', 'chipMode', 'bannerOriginTitle']) {
    assert.match(title, new RegExp(key), 'title 详情必须含 ' + key);
  }
  assert.match(title, /parentId/, '来源必须带完整父会话 id');
  // 来源不再单独渲染常驻行。
  assert.doesNotMatch(source, /subagentOriginSuffix/);
  assert.doesNotMatch(source, /sap-subagentOrigin/);
  assert.doesNotMatch(source, /sap-subagentLine/);
  // 标签：紧凑胶囊、浅灰底、虚线边框、help 光标、上限 260px、永不挤宿主按钮。
  assert.match(source, /\.sap-subagentBannerTag\{[^}]*max-width:260px/);
  assert.match(source, /\.sap-subagentBannerTag\{[^}]*cursor:help/);
  assert.match(source, /\.sap-subagentBannerTag\{[^}]*border:1px dashed/);
  assert.match(source, /\.sap-subagentBanner\{[^}]*max-width:42%[^}]*min-width:0/);
});

test('banner 三种模式文案：继承父 / 有值 / 后台均有明确模式词', () => {
  const mode = functionBody('bannerModeText');
  assert.match(mode, /bannerModePersistent/, '持久模式必须用「持久」');
  assert.match(mode, /modeBackground/, '后台模式必须用「后台」');
  assert.match(mode, /modeForeground/, '前台模式必须用「前台」');
  assert.match(source, /bannerInheritValue: '继承父会话'/);
});

test('banner 模式识别：父快照 execution.kind 优先，后台经 /ledger/jobs 兜底', () => {
  const kind = functionBody('parentDispatchKindOf');
  assert.match(kind, /execution\.kind/, '模式必须读 decisionTrace.execution.kind');
  const load = functionBody('loadSubagentBanner');
  assert.match(load, /ledger\/jobs\?session=/, '后台兜底必须查 /ledger/jobs');
  assert.match(load, /childSessionId/, '后台兜底必须按子会话 id 配对');
});
