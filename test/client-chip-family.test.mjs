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

test('Task 45：三处展示使用同一 chip 组件族（makeChip 经参数注入，chip() 调用同族）', () => {
  // makeChip 是唯一 chip 工厂，返回 (key,label,value,opts) 组件；三处均以 chip 参数接收。
  assert.match(source, /function makeChip\(el\)/);
  const dispatchChips = functionBody('buildDispatchChips');
  assert.match(dispatchChips, /chip\(/, '父卡 chip 行必须使用 chip 组件族');
  const profileRows = functionBody('buildProfileRows');
  assert.match(profileRows, /chip\(/, '方案卡 chipItems 必须使用 chip 组件族');
  const banner = functionBody('buildSubagentBanner');
  assert.match(banner, /chip\(/, '子会话 banner 必须使用 chip 组件族');
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

test('Task 45：层 2 显 n/a 不虚报 + SC2 continuable 兜底文案', () => {
  assert.match(source, /委派深度\/工具集摘要\/固化模型：n\/a（宿主未投影）/);
  assert.match(source, /已读模型\/工具\/人格，强度与预设受宿主限制/);
});
