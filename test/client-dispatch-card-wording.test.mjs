// test/client-dispatch-card-wording.test.mjs — dispatch 卡片文案规范机检：
// 分隔符统一「·」、键名中文（结束原因：/耗时）、时间单位规则、缓存命中并入 token
// 括号、括号单层不嵌套、成本前缀、护栏行差异驱动（安全检查 ✅ / 失败展开）、
// 工具行诚实降级、Token 详情行前缀。client.js 为浏览器 bundle，源码结构断言。

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

test('摘要行分隔符「·」+ 键名中文 + 缓存命中并入 token 括号 + 成本前缀', () => {
  const body = functionBody('dispatchSummaryText');
  assert.match(body, /ZH\.toolLabel \+ ' · ' \+ kindLabel/, '前缀「派发子 Agent · 前台」');
  assert.match(body, /（' \+ ZH\.cacheHit \+ ' ' \+ cacheRead \+ '）'/, '缓存命中并入 token 括号');
  assert.match(body, /ZH\.ledgerElapsed \+ ' ' \+ formatDurationMs/, '耗时键名中文 + 时间单位规则');
  assert.match(body, /ZH\.ledgerStopReason \+ '：'/, '结束原因：');
  assert.match(body, /ZH\.costEstimated \+ ' ≈'/, '成本前缀「成本 ≈X 元」');
  assert.match(body, /ZH.inheritModelShort/, '继承父模型（括号单层不嵌套）');
  assert.match(body, /parts\.join\(' · '\)/, '分隔符统一「·」');
});

test('卡片护栏行差异驱动（全过单徽标 / 失败展开；审批 never 不再出现）', () => {
  const body = functionBody('safetyLineText');
  assert.match(body, /ZH\.ledgerSafetyBadge \+ ' ✅'/, '全过「安全检查 ✅」');
  assert.match(body, /failed.map/, '失败展开具体项');
  assert.doesNotMatch(source, /审批 = never|approvalNever/, '「审批 = never」不再出现');
});

test('工具行（continuable 数量 / 非 continuable 诚实降级）', () => {
  const body = functionBody('toolLineText');
  assert.match(body, /剔 run_code/, 'continuable 有真实交集显示数量');
  assert.match(body, /ZH.toolHostNarrow/, '非 continuable 诚实降级');
  assert.match(source, /toolHostNarrow: '工具由系统最终授予'/, '降级文案更新');
});

test('详情 Token 行前缀 + 缓存读统一为缓存命中', () => {
  const body = functionBody('usageDetailText');
  assert.match(body, /ZH.tokenDetailPrefix/, '「Token：」前缀定义单位域');
  assert.match(body, /ZH.cacheHit, usage.cacheReadTokens/, '缓存读 → 缓存命中');
  assert.doesNotMatch(body, /cacheWriteTokens/, '详情行数字不带单位');
  assert.match(source, /usageCacheRead: '缓存命中'/, 'ZH 表缓存读统一为缓存命中');
});

test('忽略 chips 键名中文化（⬆模型（已忽略））', () => {
  const body = functionBody('buildDispatchChips');
  assert.match(body, /FIELD_ZH[key] || key/, '忽略项 key 用中文名');
  assert.match(body, /ZH.ignoredMark/, '维持「（已忽略）」形态');
});
