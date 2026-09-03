// test/client-phase-machine.test.mjs — 派发链路 live 状态机机检。
// client.js 为浏览器 bundle（无 DOM 测试基建），本文件以源码结构断言 phase 徽标
// 推导与轮询兜底的存在性；行为面由 host 侧 background-ledger callId 用例锁配对口径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

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

test('phase 状态机纯函数存在且五相齐全', () => {
  const body = functionBody('phaseStepsOf');
  for (const key of ['phaseInitiate', 'phaseGuards', 'phaseCreate', 'phaseRun', 'phaseDone', 'phaseFailed']) {
    assert.match(body, new RegExp('ZH\\.' + key), `phase 必须含 ${key}`);
  }
  // 前台终态：护栏闸失败 → fail；stopReason 非 completed → 失败。
  assert.match(body, /gateFailed/, '护栏结果必须进 phase');
  assert.match(body, /stop !== '' && stop !== 'completed'/, '前台终态按 stopReason 判失败');
  // 后台轮询配对：jobSettled 优先于 result 静态态。
  assert.match(body, /jobSettled/, '后台 live 结算必须进 phase');
});

test('后台 live 轮询兜底（/ledger/jobs 按 callId 配对，上限 100 次）', () => {
  const body = functionBody('useBackgroundJobPoll');
  assert.match(body, /ledger\/jobs\?session=/, '轮询必须走 /ledger/jobs 路由');
  assert.match(body, /callId/, '运行中卡片必须按 callId 配对结算');
  assert.match(body, /attempts >= 100/, '轮询必须有上限（100 次）');
  assert.match(body, /setInterval\(poll, 3000\)/, '轮询间隔 3 秒');
  assert.match(body, /clearInterval/, '配对成功/卸载必须清理定时器');
});

test('phase 徽标行未展开即渲染（在摘要行上方）', () => {
  const body = functionBody('DispatchToolview');
  const retIdx = body.indexOf('return el(');
  assert.ok(retIdx >= 0);
  const tree = body.slice(retIdx);
  const phaseIdx = tree.indexOf('buildDispatchPhaseLine(');
  const summaryIdx = tree.indexOf('summary');
  assert.ok(phaseIdx >= 0, 'phase 徽标行必须渲染');
  assert.ok(summaryIdx < 0 || phaseIdx < summaryIdx, 'phase 行必须先于摘要行（未展开即渲染）');
});

test('continuable 无「执行中→完成」虚报（启动即终态，phase 恒静态）', () => {
  const body = functionBody('useBackgroundJobPoll');
  assert.match(body, /runInBackground !== true/, '非后台派发不启动轮询');
});

test('台账 tab 后台任务 live 结算：3 秒轮询、仅未结算后台启动、配对即停', () => {
  const poll = functionBody('startLedgerJobsPoll');
  assert.match(poll, /fetchLedgerJobs/, '轮询必须复用 /ledger/jobs 拉取');
  assert.match(poll, /attempts >= 100/, '轮询必须有 100 次上限');
  assert.match(poll, /setInterval\(/, '有定时轮询');
  assert.match(poll, /3000\)/, '轮询间隔 3 秒');
  assert.match(poll, /allJobsSettled/, '待配对 job 全部结算即停');
  assert.match(poll, /clearInterval/, '停止/卸载必须清理定时器');
  const hook = functionBody('useLedgerJobs');
  assert.match(hook, /startLedgerJobsPoll/, '台账数据装载必须接轮询 hook');
  const pending = functionBody('pendingBackgroundJobIds');
  assert.match(pending, /execution\.kind !== 'background'/, '非后台记录不启动轮询');
  assert.match(pending, /trace\.settled !== null/, '已结算记录不启动轮询');
});
