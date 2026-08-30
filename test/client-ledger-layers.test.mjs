// test/client-ledger-layers.test.mjs — 批次 7 三层信息架构机检。
// client.js 为浏览器 bundle（无 DOM 测试基建），本文件以源码结构断言三层递进、
// 差异驱动折叠、工具集/安全检查子节、执行过程事件线与双视图切换的存在性；
// 行为面由慕人工走查三场景（成功含干预 / 拒绝 / 后台执行中）。

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

test('批次 7：三层递进结构（折叠态行 → 结论层 → 证据层）', () => {
  const row = functionBody('buildLedgerRowHead');
  for (const cls of ['sap-ledgerTime', 'sap-ledgerMeta', 'sap-ledgerStatus', 'sap-ledgerCostText', 'sap-ledgerToolsText', 'sap-ledgerToggle']) {
    assert.match(row, new RegExp(cls), '折叠态行必须含 ' + cls);
  }
  const conclusion = functionBody('buildConclusionArea');
  for (const fn of ['buildProgressDots', 'buildSafetyBadges', 'buildCostCard', 'buildRejectBlock', 'ledgerEvidenceToggle']) {
    assert.match(conclusion, new RegExp(fn), '结论层必须含 ' + fn);
  }
  const evidence = functionBody('buildEvidenceArea');
  for (const fn of ['buildStartBlock', 'buildDecisionBlock', 'buildExecutionBlock', 'buildSettleBlock']) {
    assert.match(evidence, new RegExp(fn), '证据层必须含 ' + fn);
  }
  assert.match(source, /sap-ledgerRowFail/, '拒绝记录红色左边框 class');
});

test('批次 7：差异驱动（安全检查全过单徽标 / 请求 vs 生效全一致折叠 / 拒绝场景展开）', () => {
  const safety = functionBody('buildSafetyBadges');
  assert.match(safety, /ledgerSafetyAllPass/, '全过单徽标');
  assert.match(safety, /ledgerSafetyFail/, '失败展开');
  const vs = functionBody('buildRequestVsTable');
  assert.match(vs, /ledgerVsAllMatch/, '全一致折叠文案');
  assert.match(vs, /'details'/, '全一致时折叠为 details');
  assert.match(vs, /sap-ledgerVsDiff/, '差异行琥珀底');
  const precheck = functionBody('buildPrecheckSubSection');
  assert.match(precheck, /open: !s.allPass/, '拒绝场景默认展开');
});

test('批次 7：工具集子节（完整清单不截断 + 中文名 + 滚动兜底 + 诚实降级）', () => {
  const toolset = functionBody('buildToolsetSubSection');
  assert.match(toolset, /ledgerToolsetFormula/, '白名单 ∩ 父会话 → 实得公式');
  assert.match(toolset, /ledgerToolScroll/, '表格滚动兜底');
  assert.match(toolset, /ledgerToolsetHostNarrow/, '非 continuable 诚实降级');
  assert.match(toolset, /'details'/, '默认折叠');
  const nameFn = functionBody('toolNameZh');
  assert.match(nameFn, /toolZh/, '中文名查工具目录映射');
});

test('批次 7：执行过程事件线（停滞阈值待实测标注 / 干预 / 恢复）', () => {
  const proc = functionBody('processEventsOf');
  assert.match(proc, /STALL_THRESHOLD_MS/, '停滞阈值常量');
  assert.match(proc, /kind === 'user'/, '主 agent 干预（user 节点）');
  assert.match(proc, /stalled/, '停滞标记');
  const timeline = functionBody('buildProcessTimeline');
  assert.match(timeline, /ledgerStallThresholdNote/, '停滞阈值待实测标注');
  assert.match(timeline, /sap-ledgerEventLine/, '事件线容器');
});

test('批次 7：可视化 / 原始 JSON 双视图（四段各带切换）', () => {
  for (const [fn, key] of [['buildStartBlock', 'start'], ['buildDecisionBlock', 'decide'], ['buildExecutionBlock', 'execute'], ['buildSettleBlock', 'settle']]) {
    const body = functionBody(fn);
    assert.match(body, /buildViewToggle/, fn + ' 必须有视图切换');
    assert.match(body, /buildJsonBody/, fn + ' 必须有原始 JSON 视图');
    assert.match(body, new RegExp("'" + key + "'"), fn + ' 必须有独立 jsonView key');
  }
});

test('批次 7：用户可见文案零内部术语（五环/认知/感知/请求值对照）', () => {
  assert.doesNotMatch(source, /五环|认知闭环|新感知|请求值对照/);
  assert.match(source, /派发前 · 安全检查/);
  assert.match(source, /查看完整因果链/);
  assert.match(source, /由父会话派发/);
});
