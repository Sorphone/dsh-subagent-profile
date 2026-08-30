// test/adoption-tracker.test.mjs — parent_adopted 三态信号生产接线（0.4.0 E-1，
// 任务书批次 2.1 唯一真断线）。集成级：模拟父会话采纳/未采纳事件流 → tracker 三态
// 判定 → confirmedFalseCounts join 进 refreshSummaries → weighted_success 与 win_rate
// 出现分歧（有采纳信号时二者不再恒等）。另锁 apply 接线契约（session/event 订阅、
// agent/disposed 挂钩）与 sidecar 持久化（重启后判定保留）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdoptionTracker } from '../lib/core/adoption-tracker.mjs';
import { adoptStatus, profileKeyOf } from '../lib/core/evolution-summary.mjs';
import { refreshSummaries, readSummaries } from '../lib/core/evolution-advice.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// ledgerKey 与聚合 L1 键同源（profileKeyOf 为单一事实来源）。
const LEDGER_KEY = profileKeyOf({ preset: 'standard', provider: 'p1', model: 'm1' });

function tmpEvoDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-adopt-'));
  const evoDir = join(dir, 'subagent-evolution');
  mkdirSync(evoDir, { recursive: true });
  return { dir, evoDir };
}

// 台账 fixture：2 完成 + 1 失败（win_rate=2/3，加权分 0.667；一例确认未采纳后 0.567）。
function writeLedgerFixture(evoDir) {
  const base = { v: 1, effective: { preset: 'standard', provider: 'p1', model: 'm1' } };
  const records = [
    { ...base, ts: 1, outcome: { status: 'completed' } },
    { ...base, ts: 2, outcome: { status: 'completed' } },
    { ...base, ts: 3, outcome: { status: 'failed' } },
  ];
  writeFileSync(join(evoDir, 'dispatch.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// dispatch 回灌锚点事件（E-1 A.4：父 tool/result 的 meta.decisionTrace.execution）。
function anchorEvent(seq, parentSessionId, kind, id) {
  const execution = { kind, parentSessionId };
  if (kind === 'background') execution.jobId = id;
  else execution.childSessionId = id;
  return { type: 'tool/result', seq, data: { meta: { decisionTrace: { execution } } } };
}

test('parent_adopted 接线：采纳/未采纳事件流后 weighted_success 与 win_rate 出现分歧', () => {
  const { dir, evoDir } = tmpEvoDir();
  try {
    writeLedgerFixture(evoDir);
    const decisions = [];
    const tracker = createAdoptionTracker({
      stateFile: join(evoDir, 'adopted-state.json'),
      windowN: 2,
      windowMs: null, // 关闭时间窗，纯轮次判定（确定性）
      now: () => 1000,
      onDecision: () => decisions.push('fired'),
    });
    tracker.register({ parentSessionId: 's1', id: 'c1', ledgerKey: LEDGER_KEY, mode: 'foreground', dispatchedAt: 0 });
    tracker.register({ parentSessionId: 's1', id: 'c2', ledgerKey: LEDGER_KEY, mode: 'foreground', dispatchedAt: 0 });
    // 锚点（turn 0 内，seq 1/2）；锚点本身不得触发采纳。
    tracker.handleEvent({ id: 's1' }, anchorEvent(1, 's1', 'foreground', 'c1'));
    tracker.handleEvent({ id: 's1' }, anchorEvent(2, 's1', 'foreground', 'c2'));
    assert.equal(tracker.statusOf('s1', 'c1', 1000), 'unknown', '锚点后无引用 → 待定');
    // 锚点之前的文本不得触发采纳（seq 守卫）。
    tracker.handleEvent({ id: 's1' }, { type: 'assistant/message', seq: 1, data: { message: { content: '引用 c2' } } });
    assert.equal(tracker.statusOf('s1', 'c2', 1000), 'unknown');
    // 父后续回合引用 c1 → 采纳；c2 无引用，推进 2 轮后窗口到期 → 明确未采纳。
    tracker.handleEvent({ id: 's1' }, { type: 'turn/end', seq: 3, data: { turn: 1 } });
    tracker.handleEvent({ id: 's1' }, { type: 'assistant/message', seq: 4, data: { message: { content: '采用 c1 的结论' } } });
    assert.equal(tracker.statusOf('s1', 'c1', 1000), 'true', '精确 id 引用 → 采纳');
    tracker.handleEvent({ id: 's1' }, { type: 'turn/end', seq: 5, data: { turn: 2 } });
    assert.equal(tracker.statusOf('s1', 'c2', 1000), 'false', '窗口到期未引用 → 明确未采纳');
    // adoptStatus 生产口径对照（windowN=2、roundsElapsed=2 → false）。
    assert.equal(adoptStatus({ windowN: 2, dispatchedAt: 0, adoptedAt: null, now: 1000, roundsElapsed: 2 }), 'false');
    // join：confirmedFalseCounts → refreshSummaries → 二者出现分歧。
    const counts = tracker.confirmedFalseCounts(1000);
    assert.equal(counts[LEDGER_KEY], 1, '仅 c2 计入已确认未采纳');
    const res = refreshSummaries({
      dispatchFile: join(evoDir, 'dispatch.jsonl'),
      summariesFile: join(evoDir, 'summaries.json'),
      opts: { parentAdoptedConfirmedFalse: counts },
    });
    assert.equal(res.persisted, true);
    const group = readSummaries(join(evoDir, 'summaries.json')).l1[LEDGER_KEY];
    assert.equal(group.score.win_rate, Number((2 / 3).toFixed(3)));
    assert.equal(group.score.weighted_success, Number(((2 - 0.3) / 3).toFixed(3)), '一例确认未采纳扣 0.3');
    assert.notEqual(group.score.weighted_success, group.score.win_rate, '有采纳信号时二者不再恒等');
    assert.ok(decisions.length >= 1, '判定变化必须触发聚合重算钩子');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parent_adopted：后台 job_output 精确引用判采纳；判定落盘重启后仍生效', () => {
  const { dir, evoDir } = tmpEvoDir();
  try {
    writeLedgerFixture(evoDir);
    const stateFile = join(evoDir, 'adopted-state.json');
    const tracker = createAdoptionTracker({ stateFile, windowN: 2, windowMs: null, now: () => 1000 });
    tracker.register({ parentSessionId: 's1', id: 'job1', ledgerKey: LEDGER_KEY, mode: 'background', dispatchedAt: 0 });
    tracker.handleEvent({ id: 's1' }, anchorEvent(1, 's1', 'background', 'job1'));
    tracker.handleEvent({ id: 's1' }, { type: 'tool/call', seq: 2, data: { name: 'job_output', arguments: '{"job_id":"job1"}' } });
    assert.equal(tracker.statusOf('s1', 'job1', 1000), 'true', 'job_output.job_id 精确命中 → 采纳');
    assert.ok(existsSync(stateFile), '判定状态必须落盘');
    const tracker2 = createAdoptionTracker({ stateFile, windowN: 2, windowMs: null, now: () => 1000 });
    assert.equal(tracker2.statusOf('s1', 'job1', 1000), 'true', '重启后判定保留');
    assert.deepEqual(tracker2.confirmedFalseCounts(1000), {}, '采纳记录不计入未采纳惩罚');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parent_adopted：父会话结束与窗口到期分别把未决记录判明确未采纳并持久化', () => {
  const { dir, evoDir } = tmpEvoDir();
  try {
    writeLedgerFixture(evoDir);
    const stateFile = join(evoDir, 'adopted-state.json');
    const tracker = createAdoptionTracker({ stateFile, windowN: 2, windowMs: null, now: () => 1000 });
    tracker.register({ parentSessionId: 's1', id: 'c1', ledgerKey: LEDGER_KEY, mode: 'foreground', dispatchedAt: 0 });
    tracker.register({ parentSessionId: 's2', id: 'c2', ledgerKey: LEDGER_KEY, mode: 'foreground', dispatchedAt: 0 });
    tracker.handleEvent({ id: 's1' }, anchorEvent(1, 's1', 'foreground', 'c1'));
    tracker.handleEvent({ id: 's2' }, anchorEvent(1, 's2', 'foreground', 'c2'));
    // s1 父会话结束 → c1 立即判未采纳。
    tracker.parentDisposed('s1');
    assert.equal(tracker.statusOf('s1', 'c1', 1000), 'false');
    // s2 无引用，推进 windowN=2 轮 → 窗口到期判未采纳。
    tracker.handleEvent({ id: 's2' }, { type: 'turn/end', seq: 2, data: { turn: 1 } });
    tracker.handleEvent({ id: 's2' }, { type: 'turn/end', seq: 3, data: { turn: 2 } });
    assert.equal(tracker.statusOf('s2', 'c2', 1000), 'false');
    assert.equal(tracker.pendingCount(), 0);
    // 重启后判定仍保留（sidecar 持久化）。
    const tracker2 = createAdoptionTracker({ stateFile, windowN: 2, windowMs: null, now: () => 1000 });
    assert.deepEqual(tracker2.confirmedFalseCounts(1000), { [LEDGER_KEY]: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parent_adopted：内容复用（子输出片段出现在父后续文本）判采纳', () => {
  const { dir, evoDir } = tmpEvoDir();
  try {
    writeLedgerFixture(evoDir);
    const tracker = createAdoptionTracker({ stateFile: join(evoDir, 'adopted-state.json'), windowN: 2, windowMs: null, now: () => 1000 });
    tracker.register({ parentSessionId: 's1', id: 'c1', ledgerKey: LEDGER_KEY, mode: 'foreground', dispatchedAt: 0 });
    const snippet = '结论：数据已迁移到新的存储层，无需回滚；旧表可在本周清理完毕，索引将在下周重建以提升查询性能。';
    tracker.updateOutput('s1', 'c1', snippet);
    tracker.handleEvent({ id: 's1' }, anchorEvent(1, 's1', 'foreground', 'c1'));
    tracker.handleEvent({ id: 's1' }, { type: 'assistant/message', seq: 2, data: { message: { content: '已确认：' + snippet + ' 下一步清理旧表。' } } });
    assert.equal(tracker.statusOf('s1', 'c1', 1000), 'true', '内容复用 → 采纳（第二层信号）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parent_adopted：onDecided 钩子逐条收到「明确未采纳」记录（Task 42 P2 提醒源）', () => {
  const { dir, evoDir } = tmpEvoDir();
  try {
    const decided = [];
    const tracker = createAdoptionTracker({
      stateFile: join(evoDir, 'adopted-state.json'),
      windowN: 2,
      windowMs: null,
      now: () => 1000,
      onDecided: (rec) => decided.push(rec),
    });
    tracker.register({ parentSessionId: 's1', id: 'c1', ledgerKey: LEDGER_KEY, mode: 'foreground', dispatchedAt: 0 });
    tracker.handleEvent({ id: 's1' }, anchorEvent(1, 's1', 'foreground', 'c1'));
    tracker.handleEvent({ id: 's1' }, { type: 'turn/end', seq: 2, data: { turn: 1 } });
    tracker.handleEvent({ id: 's1' }, { type: 'turn/end', seq: 3, data: { turn: 2 } });
    assert.equal(decided.length, 1, '窗口到期必须逐条触发 onDecided');
    assert.equal(decided[0].ledgerKey, LEDGER_KEY);
    assert.equal(decided[0].parentSessionId, 's1');
    assert.equal(decided[0].id, 'c1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply 接线：根 ctx 订阅 session/event，agent/disposed 触发采纳判定（契约级）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const sessionEvent = records.ons.find((e) => e.name === 'session/event');
    assert.ok(sessionEvent, 'apply 必须订阅 session/event');
    const agentDisposed = records.ons.find((e) => e.name === 'agent/disposed');
    assert.ok(agentDisposed, 'apply 必须订阅 agent/disposed');
    // 事件流驱动 fail-soft：真实事件形状不抛错。
    assert.doesNotThrow(() => sessionEvent.callback({ id: 'sx' }, { type: 'turn/end', seq: 1, data: { turn: 1 } }));
    assert.doesNotThrow(() => agentDisposed.callback({ agent: { session: { header: { id: 'sx' } } } }));
  } finally { iso.restore(); iso.teardown(); }
});
