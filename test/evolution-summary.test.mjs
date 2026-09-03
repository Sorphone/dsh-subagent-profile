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
  writeSummaries,
  weightedSuccess,
  adoptStatus,
  confidenceLevel,
} from '../lib/core/evolution-summary.mjs';
import {
  computeAdvice,
  buildAdviceText,
  readSummaries,
  refreshSummaries,
  suggestAdvice,
} from '../lib/core/evolution-advice.mjs';

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
// 身份 = 生效配置签名；无区分性配置时记 '(inline)'。预算轴 effort 不并入能力身份
// （2026-08 评审第二轮：同一配置不同档位不拆组；纯 effort 配置才单独成键）。
const STANDARD_L1_KEY = 'preset:standard|provider:p1|model:m1|persona:1|toolFilter:1';
const RESEARCHER_L1_KEY = 'preset:researcher|provider:p1|model:m2';
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

// --- 版本校验（2026-08 评审第二轮）------------------------------------------

test('readSummaries：未知版本 fail-soft 跳过（v≠1 → null + warn，不读数据）', () => {
  const t = tmpDir();
  try {
    const file = join(t.dir, 'subagent-evolution', 'summaries.json');
    const warns = [];
    mkdirSync(join(t.dir, 'subagent-evolution'), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 2, l1: { 'preset:standard': { deployments_total: 99 } } }), 'utf8');
    assert.equal(readSummaries(file, { warn: (m) => warns.push(m) }), null, '未知版本跳过');
    assert.equal(readSummaries(file, { warn: (m) => warns.push(m) }), null);
    // 无 logger 也不抛。
    assert.equal(readSummaries(file), null);
    assert.ok(warns.length >= 1, 'warn 留痕');
    assert.ok(warns[0].includes('版本'), 'warn 提及版本');
  } finally { t.cleanup(); }
});

test('readSummaries：v=1 正常读取；损坏/形状不符 fail-soft 返回 null', () => {
  const t = tmpDir();
  try {
    const file = join(t.dir, 'subagent-evolution', 'summaries.json');
    mkdirSync(join(t.dir, 'subagent-evolution'), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, l1: { a: 1 }, l2: {} }), 'utf8');
    const parsed = readSummaries(file);
    assert.equal(parsed.v, 1);
    assert.deepEqual(parsed.l1, { a: 1 });
    // 损坏文件 → null。
    writeFileSync(file, '{broken', 'utf8');
    assert.equal(readSummaries(file), null);
    // 形状不符（无 l1）→ null。
    writeFileSync(file, JSON.stringify({ v: 1 }), 'utf8');
    assert.equal(readSummaries(file), null);
  } finally { t.cleanup(); }
});

test('computeAdvice：从 summaries 产出结构化建议 + 全局汇总', () => {
  const t = tmpDir();
  try {
    const file = join(t.dir, 'summaries.json');
    const l1 = {
      'preset:standard|model:m1': {
        deployments_total: 4,
        outcome: { completed: 2, failed: 2, killed: 0 },
        score: { weighted_success: 0.5, win_rate: 0.5 },
        perf: { avg_elapsed_ms: 100, avg_output_len: 200, avg_tool_count: 3 },
        confidence: { n: 4, min_n_required: 3, level: 'medium' },
        cooldown: { until_ts: null, last_apply_ts: null },
      },
    };
    writeFileSync(file, JSON.stringify({ v: 1, l1, l2: {} }), 'utf8');
    const { advice, global, produced } = computeAdvice({ summariesFile: file, whitelist: new Set(['standard']), logger: { warn: () => {} } });
    assert.equal(advice.length, 1);
    assert.equal(advice[0].profileKey, 'preset:standard|model:m1');
    assert.equal(advice[0].suggestion, '降');
    assert.equal(advice[0].confidence, 'medium');
    assert.equal(global.total, 4);
    assert.equal(global.completed, 2);
    assert.equal(global.failed, 2);
    assert.equal(produced.length, 1);
    assert.equal(produced[0][0], 'preset:standard|model:m1');
  } finally { t.cleanup(); }
});

test('computeAdvice：无 summaries → 空建议 + 空全局', () => {
  const t = tmpDir();
  try {
    const { advice, global } = computeAdvice({ summariesFile: join(t.dir, 'missing.json'), whitelist: new Set(['standard']), logger: { warn: () => {} } });
    assert.deepEqual(advice, []);
    assert.equal(global.total, 0);
  } finally { t.cleanup(); }
});

// --- L1 键去 effort（聚合语义修正，2026-08 断线二）------------------

test('computeSummaries：同一 profile 不同 effort 聚合为一条 L1（effort 不混入身份键）', () => {
  const records = [
    { effective: { preset: 'standard', provider: 'p1', model: 'm1', reasoningEffort: 'medium' }, outcome: { status: 'completed' } },
    { effective: { preset: 'standard', provider: 'p1', model: 'm1', reasoningEffort: 'high' }, outcome: { status: 'failed' } },
  ];
  const { l1, l2 } = computeSummaries(records);
  const key = 'preset:standard|provider:p1|model:m1';
  assert.ok(l1[key], '同一方案不同 effort 必须聚合为一条 L1');
  assert.equal(l1[key].deployments_total, 2);
  assert.equal(l1[key].axes.capability, true);
  assert.equal(l1[key].axes.budget, true);
  // effort 只留在 L2 预算轴。
  assert.ok(l2[key + ':reasoningEffort:medium']);
  assert.ok(l2[key + ':reasoningEffort:high']);
  assert.ok(!l1[key + '|effort:medium'], 'effort 不得出现在 L1 键');
  assert.ok(!l1[key + '|effort:high'], 'effort 不得出现在 L1 键');
});

test('computeSummaries：纯 effort 配置聚合为 (inline)，预算轴可产出「升」建议', () => {
  const records = [
    { effective: { reasoningEffort: 'high' }, outcome: { status: 'completed' } },
    { effective: { reasoningEffort: 'high' }, outcome: { status: 'failed' } },
    { effective: { reasoningEffort: 'high' }, outcome: { status: 'failed' } },
  ];
  const { l1 } = computeSummaries(records);
  const group = l1['(inline)'];
  assert.ok(group, '纯 effort 配置落 (inline) 键');
  assert.equal(group.deployments_total, 3);
  assert.equal(group.axes.capability, false, '纯 effort 组无能力轴');
  assert.equal(group.axes.budget, true, '纯 effort 组有预算轴');
  const advice = suggestAdvice({ l1Entry: group, profileKey: '(inline)', now: 1000 });
  assert.ok(advice, '欠佳纯 effort 组应产出建议');
  assert.equal(advice.suggestion, '升', '预算轴升建议必须可达（axes 判定，而非键文本）');
});

test('suggestAdvice：legacy summaries（无 axes 字段）回退键文本判定', () => {
  // 旧 summaries.json 无 axes：effort 键文本仍有预算轴语义（升），inline 维持平。
  const legacyEntry = {
    deployments_total: 3,
    outcome: { completed: 1, failed: 2, killed: 0 },
    score: { weighted_success: 0.333, win_rate: 0.333 },
    perf: { avg_elapsed_ms: 150, avg_output_len: 500, avg_tool_count: 2 },
    confidence: { n: 3, min_n_required: 3, level: 'medium' },
    cooldown: { until_ts: null, last_apply_ts: null },
  };
  const legacyBudget = suggestAdvice({ l1Entry: legacyEntry, profileKey: 'effort:off', now: 1000 });
  assert.equal(legacyBudget.suggestion, '升');
  const legacyInline = suggestAdvice({ l1Entry: legacyEntry, profileKey: '(inline)', now: 1000 });
  assert.equal(legacyInline.suggestion, '平');
});

// --- F6：summaries.json 版本不符/损坏 → fail-soft 重建 ---------------------------------

test('computeAdvice：summaries.json 版本不符 → fail-soft 重建并产出建议（F6）', () => {
  const t = tmpDir();
  try {
    const evoDir = join(t.dir, 'subagent-evolution');
    mkdirSync(evoDir, { recursive: true });
    const dispatchFile = join(evoDir, 'dispatch.jsonl');
    const summariesFile = join(evoDir, 'summaries.json');
    // 台账：3 条欠佳标准 profile 记录（1 完成 2 失败 → 建议产出）。
    const base = { effective: { preset: 'standard', provider: 'p1', model: 'm1' } };
    writeFileSync(dispatchFile, [
      JSON.stringify({ ...base, outcome: { status: 'completed' } }),
      JSON.stringify({ ...base, outcome: { status: 'failed' } }),
      JSON.stringify({ ...base, outcome: { status: 'failed' } }),
    ].join('\n') + '\n', 'utf8');
    // 未知版本资产：必须被重建而非静默跳过。
    writeFileSync(summariesFile, JSON.stringify({ v: 2, l1: { bogus: { deployments_total: 99 } }, l2: {} }), 'utf8');
    const warns = [];
    const { advice, global } = computeAdvice({ summariesFile, dispatchFile, whitelist: new Set(['standard']), logger: { warn: (m) => warns.push(m) } });
    assert.equal(advice.length, 1, '重建后必须产出建议');
    assert.equal(advice[0].suggestion, '降');
    assert.equal(global.total, 3);
    const parsed = JSON.parse(readFileSync(summariesFile, 'utf8'));
    assert.equal(parsed.v, 1, '重建必须写回 v:1');
    assert.ok(warns.some((m) => m.includes('版本')), '版本不符必须告警留痕');
  } finally { t.cleanup(); }
});

test('computeAdvice：summaries.json 损坏 → fail-soft 重建（F6）', () => {
  const t = tmpDir();
  try {
    const evoDir = join(t.dir, 'subagent-evolution');
    mkdirSync(evoDir, { recursive: true });
    const dispatchFile = join(evoDir, 'dispatch.jsonl');
    const summariesFile = join(evoDir, 'summaries.json');
    writeFileSync(dispatchFile, JSON.stringify({ effective: { preset: 'standard' }, outcome: { status: 'completed' } }) + '\n', 'utf8');
    writeFileSync(summariesFile, '{broken json', 'utf8');
    const { advice } = computeAdvice({ summariesFile, dispatchFile, whitelist: new Set(['standard']), logger: { warn: () => {} } });
    assert.deepEqual(advice, [], 'N<3 重建后不产出建议但不得报错');
    const parsed = JSON.parse(readFileSync(summariesFile, 'utf8'));
    assert.equal(parsed.v, 1, '损坏资产必须被重建为 v:1');
  } finally { t.cleanup(); }
});

test('buildAdviceText：复用 computeAdvice 并写回 cooldown', () => {
  const t = tmpDir();
  try {
    const file = join(t.dir, 'summaries.json');
    const l1 = {
      'preset:standard|model:m1': {
        deployments_total: 4,
        outcome: { completed: 2, failed: 2, killed: 0 },
        score: { weighted_success: 0.5, win_rate: 0.5 },
        perf: { avg_elapsed_ms: 100, avg_output_len: 200, avg_tool_count: 3 },
        confidence: { n: 4, min_n_required: 3, level: 'medium' },
        cooldown: { until_ts: null, last_apply_ts: null },
      },
    };
    writeFileSync(file, JSON.stringify({ v: 1, l1, l2: {} }), 'utf8');
    const text = buildAdviceText({ summariesFile: file, whitelist: new Set(['standard']), logger: { warn: () => {} } });
    assert.match(text, /累计 4 次/);
    assert.match(text, /preset:standard|model:m1/);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(parsed.l1['preset:standard|model:m1'].cooldown.until_ts > Date.now() - 1000);
  } finally { t.cleanup(); }
});
