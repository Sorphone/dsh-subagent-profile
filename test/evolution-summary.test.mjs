// test/evolution-summary.test.mjs — 派发台账（dispatch.jsonl）的确定性双层聚合。
//   * computeSummaries：从 fixture records 复算 L1（按 profile）/L2（按轴值），断言可
//     复现（字段值精确）；
//   * weightedSuccess：unknown 计 0 不惩罚、仅 confirmed false 受 0.3 惩罚、下限 0；
//   * adoptStatus：三态在窗口内恒 unknown、窗口外落 false、adoptedAt 有值恒 true；
//   * confidenceLevel：3/10 阈值分段；
//   * parseDispatchRecords：损坏行 fail-soft 跳过 + 计数；
//   * 确定性：同输入两次调用 deepEqual；
//   * writeSummaries：原子写（tmp+rename）、顶层 v 版本、失败不 throw。
// 纯函数为主，不含 index.mjs apply 依赖，可在 bare CI 直接 import。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSummaries,
  parseDispatchRecords,
  refreshSummaries,
  writeSummaries,
  weightedSuccess,
  adoptStatus,
  confidenceLevel,
} from '../lib/core/evolution-summary.mjs';

// --- fixture：与 evolution-ledger 记录 schema 一致 ----------------------------------

const FIXTURE_RECORDS = [
  {
    child_id: 'child-completed-1',
    mode: 'foreground',
    requested: { preset: 'standard', provider: 'p1', model: 'm1', reasoningEffort: 'medium', maxTokens: 4000, persona_present: true, toolFilter_present: true },
    effective: { preset: 'standard', provider: 'p1', model: 'm1', reasoningEffort: 'medium', maxTokens: 4000, persona_present: true, toolFilter_present: true },
    outcome: { status: 'completed', elapsed_ms: 100, output_len: 500, tool_count: 5, stop_reason: 'completed' },
  },
  {
    child_id: 'child-completed-2',
    mode: 'foreground',
    requested: { preset: 'standard', provider: 'p1', model: 'm1', reasoningEffort: 'medium', maxTokens: 4000, persona_present: true, toolFilter_present: true },
    effective: { preset: 'standard', provider: 'p1', model: 'm1', reasoningEffort: 'medium', maxTokens: 4000, persona_present: true, toolFilter_present: true },
    outcome: { status: 'completed', elapsed_ms: 200, output_len: 700, tool_count: 8, stop_reason: 'completed' },
  },
  {
    child_id: 'child-failed-1',
    mode: 'foreground',
    requested: { preset: 'standard', provider: 'p1', model: 'm1', reasoningEffort: 'medium', maxTokens: 4000, persona_present: true, toolFilter_present: true },
    effective: { preset: 'standard', provider: 'p1', model: 'm1', reasoningEffort: 'medium', maxTokens: 4000, persona_present: true, toolFilter_present: true },
    outcome: { status: 'failed', elapsed_ms: 150, output_len: 300, tool_count: null, stop_reason: 'error' },
  },
  {
    child_id: 'child-killed-1',
    mode: 'background',
    requested: { preset: 'researcher', provider: 'p1', model: 'm2', reasoningEffort: 'off', maxTokens: null, persona_present: false, toolFilter_present: false },
    effective: { preset: 'researcher', provider: 'p1', model: 'm2', reasoningEffort: 'off', maxTokens: null, persona_present: false, toolFilter_present: false },
    outcome: { status: 'killed', elapsed_ms: 50, output_len: 100, tool_count: null, stop_reason: 'aborted' },
  },
  // continuable 无 outcome：不被 deployments_total 计入，但参与轴分布。
  {
    child_id: 'child-cont-1',
    mode: 'continuable',
    requested: { preset: 'inherit', provider: 'pX', model: 'mX', persona_present: false, toolFilter_present: false },
    effective: { preset: 'inherit', provider: 'pX', model: 'mX', persona_present: false, toolFilter_present: false },
  },
];

// 标准 profile 的 L1 键（由 effective cfg 确定性重建）。台账不存 profileId，故 profile
// 身份 = 生效配置签名；无区分性配置时记 '(inline)'。
const STANDARD_L1_KEY = 'preset:standard|provider:p1|model:m1|effort:medium|persona:1|toolFilter:1';
const RESEARCHER_L1_KEY = 'preset:researcher|provider:p1|model:m2|effort:off';
const CONTINUABLE_L1_KEY = 'provider:pX|model:mX';

// --- L1/L2 复算：字段精确断言 + 可复现 ---------------------------------------------

test('computeSummaries L1：标准 profile 复算 deployments/outcome/score/perf/confidence/cooldown', () => {
  const { l1, l2 } = computeSummaries(FIXTURE_RECORDS);
  const g = l1[STANDARD_L1_KEY];
  assert.ok(g, `必须含标准 profile 键 ${STANDARD_L1_KEY}`);
  assert.equal(g.deployments_total, 3);
  assert.deepEqual(g.outcome, { completed: 2, failed: 1, killed: 0 });
  assert.deepEqual(g.score, { weighted_success: 0.667, win_rate: 0.667 });
  assert.deepEqual(g.perf, { avg_elapsed_ms: 150, avg_output_len: 500, avg_tool_count: 6.5 });
  assert.deepEqual(g.confidence, { n: 3, min_n_required: 3, level: 'medium' });
  assert.deepEqual(g.cooldown, { until_ts: null, last_apply_ts: null });
  // L2 键集：能力轴（preset/model/provider/persona/toolFilter_from）+ 预算轴（maxTokens/reasoningEffort）。
  assert.ok(l2[`${STANDARD_L1_KEY}:preset:standard`]);
});

test('computeSummaries L1/L2：各 profile 独立聚合，continuable 无 outcome 计 0 deployments', () => {
  const { l1, l2 } = computeSummaries(FIXTURE_RECORDS);
  const r = l1[RESEARCHER_L1_KEY];
  assert.equal(r.deployments_total, 1);
  assert.deepEqual(r.outcome, { completed: 0, failed: 0, killed: 1 });
  assert.equal(r.score.weighted_success, 0);
  assert.equal(r.confidence.n, 1);
  assert.equal(r.confidence.level, 'low');

  const c = l1[CONTINUABLE_L1_KEY];
  assert.equal(c.deployments_total, 0, 'continuable 无结算不计数');
  assert.deepEqual(c.outcome, { completed: 0, failed: 0, killed: 0 });
  assert.equal(c.perf.avg_elapsed_ms, null);
  assert.equal(c.confidence.n, 0);
  assert.equal(c.confidence.level, 'low');
  // 无 outcome 的 continuable 仍出现在 L2 轴分布里（provider/model 轴）。
  assert.ok(l2[`${CONTINUABLE_L1_KEY}:provider:pX`]);
  assert.ok(l2[`${CONTINUABLE_L1_KEY}:model:mX`]);
});

test('computeSummaries 轴提取：toolFilter_from 区分 requested/effective 来源，预算轴含 maxTokens/reasoningEffort', () => {
  const { l2 } = computeSummaries(FIXTURE_RECORDS);
  // 标准 profile 的 toolFilter 在 requested 与 effective 都 present。
  assert.ok(l2[`${STANDARD_L1_KEY}:toolFilter_from:requested-and-effective`]);
  // researcher 两者都 absent。
  assert.ok(l2[`${RESEARCHER_L1_KEY}:toolFilter_from:absent`]);
  // 预算轴：maxTokens 与 reasoningEffort。
  assert.ok(l2[`${STANDARD_L1_KEY}:maxTokens:4000`]);
  assert.ok(l2[`${STANDARD_L1_KEY}:reasoningEffort:medium`]);
  // researcher 无 maxTokens（async null）→ 无该轴；reasoningEffort=off 有轴。
  assert.ok(!l2[`${RESEARCHER_L1_KEY}:maxTokens:null`]);
  assert.ok(l2[`${RESEARCHER_L1_KEY}:reasoningEffort:off`]);
});

test('computeSummaries 可复现：同输入两次调用 deepEqual 一致（确定性）', () => {
  const a = computeSummaries(FIXTURE_RECORDS);
  const b = computeSummaries(FIXTURE_RECORDS);
  assert.deepEqual(a, b);
  assert.deepEqual(a, computeSummaries(JSON.parse(JSON.stringify(FIXTURE_RECORDS))));
});

// --- 加权成功分：unknown 计 0、confirmed false 受 0.3 惩罚、下限 0 -------------------

test('weightedSuccess：completed 全胜、无惩罚', () => {
  assert.equal(weightedSuccess({ completed: 3, failed: 0, killed: 0 }), 1);
  assert.equal(weightedSuccess({ completed: 0, failed: 0, killed: 0 }), 0);
});

test('weightedSuccess：confirmed false 每例扣 0.3、unknown 计 0 不惩罚', () => {
  // 2 例 confirmed false → (2 - 0.6)/3 = 0.467。
  assert.equal(weightedSuccess({ completed: 2, failed: 1, killed: 0, parentAdoptedConfirmedFalse: 2 }), 0.467);
  // 同输入但 falseCount=0（unknown 计 0 不惩罚）→ 0.667。
  assert.equal(weightedSuccess({ completed: 2, failed: 1, killed: 0, parentAdoptedConfirmedFalse: 0 }), 0.667);
});

test('weightedSuccess：惩罚不下探负数（下限 0）', () => {
  assert.equal(weightedSuccess({ completed: 0, failed: 3, killed: 0, parentAdoptedConfirmedFalse: 5 }), 0);
  // 1 completed、3 confirmed false → (1-0.9)/4=0.025。
  assert.equal(weightedSuccess({ completed: 1, failed: 3, killed: 0, parentAdoptedConfirmedFalse: 3 }), 0.025);
});

// --- 采纳判定窗口三态 -----------------------------------------------------------------

test('adoptStatus：adoptedAt 有值恒 true；窗口内未决恒 unknown；窗口外落 false', () => {
  const now = 1000;
  // adoptedAt 有值 → true（不论窗口）。
  assert.equal(adoptStatus({ windowMs: 500, dispatchedAt: 100, adoptedAt: 400, now }), 'true');
  // 窗口内（200ms 于 500ms 窗口内）未引用 → unknown。
  assert.equal(adoptStatus({ windowMs: 500, dispatchedAt: 800, adoptedAt: null, now }), 'unknown');
  // 窗口外（800ms 超过 500ms）未引用 → false。
  assert.equal(adoptStatus({ windowMs: 500, dispatchedAt: 100, adoptedAt: null, now }), 'false');
  // 恰好等于窗口界（800-300=500，非 < 500）→ 窗口外 false。
  assert.equal(adoptStatus({ windowMs: 500, dispatchedAt: 500, adoptedAt: null, now }), 'false');
});

test('adoptStatus：N 轮窗口（roundsElapsed）三态参数化', () => {
  const now = 1000;
  // N=3 轮，elapsed=2 轮 <3 → 窗口内 unknown。
  assert.equal(adoptStatus({ windowN: 3, dispatchedAt: 0, adoptedAt: null, now, roundsElapsed: 2 }), 'unknown');
  // elapsed=3 轮 ≥3 → 窗口外 false。
  assert.equal(adoptStatus({ windowN: 3, dispatchedAt: 0, adoptedAt: null, now, roundsElapsed: 3 }), 'false');
  // 未提供 roundsElapsed（仅 N 维度）→ 圆窗维度取 0 < N → unknown（无轮数据按未决）。
  assert.equal(adoptStatus({ windowN: 3, dispatchedAt: 0, adoptedAt: null, now }), 'unknown');
});

// --- 置信度分段 -----------------------------------------------------------------------

test('confidenceLevel：3/10 阈值分段', () => {
  assert.equal(confidenceLevel(12), 'high');
  assert.equal(confidenceLevel(10), 'high');
  assert.equal(confidenceLevel(9), 'medium');
  assert.equal(confidenceLevel(3), 'medium');
  assert.equal(confidenceLevel(2), 'low');
  assert.equal(confidenceLevel(0), 'low');
});

// --- 损坏行 fail-soft 跳过 + 计数 -----------------------------------------------------

test('parseDispatchRecords：损坏/空行跳过并计数，有效记录保留', () => {
  const jsonl = [
    JSON.stringify(FIXTURE_RECORDS[0]),
    '{ this is not json ',
    '',
    JSON.stringify(FIXTURE_RECORDS[1]),
    '   ',
  ];
  const { records, skipped } = parseDispatchRecords(jsonl);
  assert.equal(records.length, 2);
  assert.equal(skipped, 3);
  assert.equal(records[0].child_id, 'child-completed-1');
});

test('computeSummaries 容忍输入含损坏记录（非对象）按跳过处理', () => {
  const { l1 } = computeSummaries([null, 42, 'x', FIXTURE_RECORDS[0]]);
  assert.equal(l1[STANDARD_L1_KEY].deployments_total, 1);
});

// --- 原子写 ---------------------------------------------------------------------------

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-evo-summary-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

test('writeSummaries：原子写（tmp+rename）、顶层 v=1、含数据且无残留 tmp', () => {
  const t = tmpDir();
  try {
    const file = join(t.dir, 'subagent-evolution', 'summaries.json');
    const res = writeSummaries(file, { l1: {}, l2: {} });
    assert.equal(res.persisted, true);
    assert.ok(existsSync(file), '目标文件落盘');
    assert.ok(!existsSync(`${file}.tmp`), '无残留 tmp（rename 成功）');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.v, 1);
    assert.deepEqual(parsed.l1, {});
    assert.deepEqual(parsed.l2, {});
    assert.equal(typeof parsed._computed_at, 'number');
  } finally { t.cleanup(); }
});

test('writeSummaries：覆盖旧文件（同路径再写）不 throw', () => {
  const t = tmpDir();
  try {
    const file = join(t.dir, 'subagent-evolution', 'summaries.json');
    writeSummaries(file, { l1: { a: 1 } });
    writeFileSync(file, 'old-content', 'utf8');
    const res = writeSummaries(file, { l1: { b: 2 } });
    assert.equal(res.persisted, true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(parsed.l1, { b: 2 });
  } finally { t.cleanup(); }
});

test('refreshSummaries：读 dispatch.jsonl → computeSummaries → writeSummaries（T1 生产聚合）', () => {
  const t = tmpDir();
  try {
    const evoDir = join(t.dir, 'subagent-evolution');
    mkdirSync(evoDir, { recursive: true });
    const dispatchFile = join(evoDir, 'dispatch.jsonl');
    const summariesFile = join(evoDir, 'summaries.json');
    // 写两行台账：一条 completed + 一条损坏行（末尾不带换行，避免尾随空行计 skipped）。
    writeFileSync(dispatchFile, `${JSON.stringify(FIXTURE_RECORDS[0])}\nnot-json`, 'utf8');
    const res = refreshSummaries({ dispatchFile, summariesFile });
    assert.equal(res.persisted, true);
    assert.equal(res.records, 1, '只有 1 条有效记录参与聚合');
    assert.equal(res.skippedLines, 1, '损坏行计数');
    assert.ok(existsSync(summariesFile), 'summaries.json 被生成');
    const parsed = JSON.parse(readFileSync(summariesFile, 'utf8'));
    assert.equal(parsed.v, 1);
    assert.ok(parsed.l1[STANDARD_L1_KEY], 'L1 聚合按 profile 键生成');
  } finally { t.cleanup(); }
});

test('refreshSummaries：dispatch.jsonl 缺失返回 skipped:no-ledger（不写空 summaries）', () => {
  const t = tmpDir();
  try {
    const summariesFile = join(t.dir, 'subagent-evolution', 'summaries.json');
    const res = refreshSummaries({ dispatchFile: join(t.dir, 'subagent-evolution', 'dispatch.jsonl'), summariesFile });
    assert.equal(res.persisted, false);
    assert.equal(res.skipped, 'no-ledger');
    assert.ok(!existsSync(summariesFile), '无台账不写 summaries.json');
  } finally { t.cleanup(); }
});
