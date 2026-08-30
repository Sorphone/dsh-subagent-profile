// test/background-ledger.test.mjs — 后台派发结算内存台账（Task 38a 兜底）。
// 纯函数：record/get/clear/上限；路由：GET /ledger/jobs?session= 返回空数组（无记录）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundLedger } from '../lib/core/background-ledger.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

test('background ledger：record 后按 session 读取，输出不存正文', () => {
  const ledger = createBackgroundLedger();
  const settled = { status: 'completed', stopReason: 'completed', elapsedMs: 10, childTotalTokens: 123, childUsage: { inputTokens: 1, outputTokens: 2 }, calls: { totalCalls: 2 }, output: 'should-not-be-stored' };
  ledger.record('s1', 'job1', settled);
  const list = ledger.get('s1');
  assert.equal(list.length, 1);
  assert.equal(list[0].jobId, 'job1');
  assert.equal(list[0].settled.status, 'completed');
  assert.equal(list[0].settled.childTotalTokens, 123);
  assert.equal(list[0].settled.outputLen, 20);
  assert.equal(list[0].settled.output, undefined, '不存子输出正文');
  assert.deepEqual(ledger.get('missing'), []);
});

test('background ledger：record 带 callId（Task 44 BP-05 运行中卡片配对），缺失时省略', () => {
  const ledger = createBackgroundLedger();
  const settled = { status: 'completed', stopReason: 'completed', elapsedMs: 10, childTotalTokens: 123, output: 'x' };
  ledger.record('s1', 'job1', settled, 'call-1');
  ledger.record('s1', 'job2', settled);
  const list = ledger.get('s1');
  assert.equal(list[0].callId, 'call-1', 'callId 必须随记录存储');
  assert.equal(list[1].callId, undefined, '未提供 callId 时不得虚构该键');
});

test('background ledger：超上限丢弃最旧，clear 清空', () => {
  const ledger = createBackgroundLedger({ maxPerSession: 2, maxTotal: 3 });
  ledger.record('s1', 'a', { status: 'completed' });
  ledger.record('s1', 'b', { status: 'completed' });
  ledger.record('s1', 'c', { status: 'completed' });
  assert.deepEqual(ledger.get('s1').map((x) => x.jobId), ['b', 'c']);
  ledger.clear();
  assert.deepEqual(ledger.get('s1'), []);
});

test('GET /ledger/jobs：未知 session 返回空数组', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { webServer, routes } = makeRouteHarness();
    const { ctx } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const res = await callRoute(routes[0].handler, 'GET', '/ledger/jobs?session=missing');
    assert.equal(res.code, 200);
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.jobs, []);
  } finally { iso.restore(); iso.teardown(); }
});
