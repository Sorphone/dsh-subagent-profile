// lib/core/adoption-tracker.mjs — parent_adopted 三态判定（0.4.0 E-1 调研结论落地）。
// 不改宿主：插件侧用 session/event 事件流 + decisionTrace.execution 锚点判定父 Agent
// 后续会话「采纳 / 明确未采纳 / 待定」子结果。判定窗口两个维度：
//   N 轮（session/event 的 turn/end 计数）与 T ms（进程内 setTimeout + unref；重启后
//   pending 记录按 dispatchedAt 时间窗继续判定，窗口连续性按 E-1 诚实边界保持 live-only）。
//
// 三态语义（复用 evolution-summary.adoptStatus）：adoptedAt 有值 → 'true'（父后续会话
// 引用 childId/jobId 或复用子输出内容）；decidedFalse → 'false'（用户拒绝/父会话结束/
// 窗口到期未引用）；其余 → 'unknown'（窗口内无信号，不惩罚）。
//
// 聚合 join：confirmedFalseCounts() 按 ledgerKey（与 computeSummaries 的 L1 身份键
// 同源，经 evolution-summary.profileKeyOf 生成）汇总已确认未采纳计数，由调用方传入
// refreshSummaries({ opts: { parentAdoptedConfirmedFalse } }) 惰性 join 进
// weighted_success（-0.3 惩罚）。不写回 append-only 的 dispatch.jsonl（既有纪律）。
//
// 隐私红线：只持久化结构字段（ledgerKey/sessionId/id/mode/时间戳/锚点/轮数/判定），
// 绝不落子输出正文——outputSnippet 仅内存存在，供内容复用判定（第二层信号）后随进程
// 生命周期丢弃。import-free（仅 node 内置 + evolution-summary），可被裸 CI 单测 import。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { adoptStatus } from './evolution-summary.mjs';

// 判定窗口与内容复用参数（建议初值，待实测校准；windowN/windowMs 可经工厂注入）。
const DEFAULT_WINDOW_N = 3;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const SNIPPET_CHARS = 80;
const MIN_REUSE_CHARS = 40;

function emptyKey(value) {
  return typeof value !== 'string' || value === '';
}

// 记录键：parentSessionId + '\u0000' + childId/jobId（\u0000 不出现在 JSON 字符串）。
function recordKey(parentSessionId, id) {
  return parentSessionId + '\u0000' + id;
}

// --- sidecar 持久化（原子写 tmp+rename；损坏 fail-soft 从空起步）--------------------

function isRecordShape(rec) {
  return rec !== null && typeof rec === 'object' && typeof rec.parentSessionId === 'string'
    && typeof rec.id === 'string' && typeof rec.ledgerKey === 'string';
}

function loadState(stateFile, records, warn) {
  if (stateFile === undefined) return;
  try {
    if (!existsSync(stateFile)) return;
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1 || !Array.isArray(parsed.records)) {
      warn('adoption tracker: 判定状态文件版本或形状不符，从空状态起步');
      return;
    }
    for (const raw of parsed.records) {
      if (!isRecordShape(raw)) continue;
      records.set(recordKey(raw.parentSessionId, raw.id), {
        parentSessionId: raw.parentSessionId,
        id: raw.id,
        ledgerKey: raw.ledgerKey,
        mode: typeof raw.mode === 'string' ? raw.mode : 'one-shot',
        dispatchedAt: Number.isFinite(raw.dispatchedAt) ? raw.dispatchedAt : 0,
        anchorSeq: Number.isFinite(raw.anchorSeq) ? raw.anchorSeq : null,
        anchorTurn: Number.isFinite(raw.anchorTurn) ? raw.anchorTurn : null,
        adoptedAt: Number.isFinite(raw.adoptedAt) ? raw.adoptedAt : null,
        decidedFalse: raw.decidedFalse === true,
        snippet: '',
      });
    }
  } catch (error) {
    warn('adoption tracker: 判定状态文件读取失败，从空状态起步（' + (error instanceof Error ? error.message : String(error)) + '）');
  }
}

function persistState(stateFile, records, warn) {
  if (stateFile === undefined) return;
  const payload = {
    v: 1,
    records: [...records.values()].map((rec) => ({
      parentSessionId: rec.parentSessionId,
      id: rec.id,
      ledgerKey: rec.ledgerKey,
      mode: rec.mode,
      dispatchedAt: rec.dispatchedAt,
      anchorSeq: rec.anchorSeq,
      anchorTurn: rec.anchorTurn,
      adoptedAt: rec.adoptedAt,
      decidedFalse: rec.decidedFalse,
    })),
  };
  const tmp = stateFile + '.tmp';
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, stateFile);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    warn('adoption tracker: 判定状态写入失败（' + (error instanceof Error ? error.message : String(error)) + '）');
  }
}

// --- 事件面纯函数 ----------------------------------------------------------------

function parseArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

// 事件文本面：type + data 各字段文本（字符串原样、对象 JSON 化），供精确 id 引用与
// 内容复用两层判定做子串匹配。
function eventText(event) {
  if (event === null || typeof event !== 'object') return '';
  const data = event.data;
  const parts = typeof event.type === 'string' ? [event.type] : [];
  if (data === null || typeof data !== 'object') return parts.join('\n');
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'object') {
      try { parts.push(JSON.stringify(value)); } catch { /* best effort */ }
    } else parts.push(String(value));
  }
  return parts.join('\n');
}

// 引用判定（E-1 C.3 第一层精确 id）：job_output 的 job_id 精确等于 id（后台强信号），
// 或事件文本面包含 id（父 assistant/tool 文本直接引用 childId/jobId）。
function referencesId(event, id) {
  if (emptyKey(id)) return false;
  const data = event !== null && typeof event === 'object' ? event.data : null;
  if (event !== null && typeof event === 'object' && event.type === 'tool/call'
    && data !== null && typeof data === 'object' && data.name === 'job_output') {
    const args = parseArguments(data.arguments);
    if (args !== null && typeof args === 'object' && args.job_id === id) return true;
  }
  return eventText(event).includes(id);
}

// --- 状态操作（模块级，经 state 注入守函数行门）-------------------------------------

function createState(options) {
  const records = new Map();
  const sessionTurns = new Map();
  loadState(options.stateFile, records, options.warn);
  return {
    records,
    sessionTurns,
    stateFile: options.stateFile,
    windowN: options.windowN,
    windowMs: options.windowMs,
    warn: options.warn,
    onDecision: options.onDecision,
    onDecided: options.onDecided,
    now: options.now,
    dirty: false,
    timer: null,
  };
}

function pendingFor(state, parentSessionId) {
  const out = [];
  for (const rec of state.records.values()) {
    if (rec.parentSessionId === parentSessionId && rec.adoptedAt === null && rec.decidedFalse !== true) out.push(rec);
  }
  return out;
}

function hasPending(state) {
  for (const rec of state.records.values()) {
    if (rec.adoptedAt === null && rec.decidedFalse !== true) return true;
  }
  return false;
}

function roundsElapsedOf(state, rec) {
  if (rec.anchorTurn === null) return null;
  const current = state.sessionTurns.get(rec.parentSessionId);
  return current === undefined ? 0 : Math.max(0, current - rec.anchorTurn);
}

// 三态判定：复用 evolution-summary.adoptStatus（生产调用方）；decidedFalse 为 tracker
// 附加的强制未采纳（父会话结束/用户拒绝），优先级在窗口判定之上。
function triState(state, rec, ts) {
  if (rec.adoptedAt !== null && rec.adoptedAt !== undefined) return 'true';
  if (rec.decidedFalse === true) return 'false';
  return adoptStatus({
    windowN: state.windowN,
    windowMs: state.windowMs,
    dispatchedAt: rec.dispatchedAt,
    adoptedAt: rec.adoptedAt,
    now: ts,
    roundsElapsed: roundsElapsedOf(state, rec),
  });
}

function markDecidedFalse(state, rec) {
  if (rec.adoptedAt !== null || rec.decidedFalse === true) return false;
  rec.decidedFalse = true;
  state.dirty = true;
  // 逐条通知「明确未采纳」判定（Task 42 P2 提醒源），钩子失败不影响判定。
  if (typeof state.onDecided === 'function') {
    try { state.onDecided(rec); } catch { /* fail-soft */ }
  }
  return true;
}

// 判定变化后的统一出口：落盘 + 通知调用方重算聚合（fail-soft，绝不抛出）。
function fireChange(state) {
  if (state.dirty) { persistState(state.stateFile, state.records, state.warn); state.dirty = false; }
  try { state.onDecision(); } catch { /* 调用方钩子失败不影响判定 */ }
}

function checkWindows(state, ts) {
  let changed = false;
  for (const rec of state.records.values()) {
    if (triState(state, rec, ts) === 'false' && markDecidedFalse(state, rec)) changed = true;
  }
  return changed;
}

function ensureTimer(state) {
  if (state.timer !== null || state.windowMs === null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    const changed = checkWindows(state, state.now());
    if (changed) fireChange(state);
    else if (hasPending(state)) ensureTimer(state);
  }, state.windowMs + 1000);
  // 判定窗口定时器绝不阻塞进程退出（宿主退出/测试结束时丢弃未到期 timer；重启后
  // pending 记录按 dispatchedAt 时间窗继续判定，live-only 语义见 E-1）。
  if (state.timer !== null && typeof state.timer.unref === 'function') state.timer.unref();
}

// 锚点登记：父 tool/result 携带 decisionTrace.execution 的 dispatch 回灌（唯一可靠的
// 持久化 child 标识锚点，E-1 A.4）。返回登记的记录或 null。
function anchorRecord(state, sessionId, event, data, seq) {
  if (event.type !== 'tool/result') return null;
  const execution = data.meta?.decisionTrace?.execution;
  if (execution === null || typeof execution !== 'object') return null;
  const execParent = typeof execution.parentSessionId === 'string' && execution.parentSessionId !== ''
    ? execution.parentSessionId
    : sessionId;
  if (execParent !== sessionId) return null;
  const id = execution.kind === 'background'
    ? (typeof execution.jobId === 'string' ? execution.jobId : '')
    : (typeof execution.childSessionId === 'string' ? execution.childSessionId : '');
  if (id === '') return null;
  const rec = state.records.get(recordKey(sessionId, id));
  if (rec === undefined || rec.anchorSeq !== null) return null;
  rec.anchorSeq = seq;
  rec.anchorTurn = state.sessionTurns.get(sessionId) ?? 0;
  state.dirty = true;
  return rec;
}

// 引用判定：只扫描锚点之后的父事件（锚点自身必跳过）；命中 id 或复用输出片段即采纳。
function detectReferences(state, sessionId, event, seq, ts) {
  let adopted = false;
  for (const rec of pendingFor(state, sessionId)) {
    if (rec.anchorSeq === null) continue;
    if (seq !== null && seq <= rec.anchorSeq) continue;
    const idHit = referencesId(event, rec.id);
    const reuseHit = rec.snippet.length >= MIN_REUSE_CHARS && eventText(event).includes(rec.snippet);
    if (idHit || reuseHit) {
      rec.adoptedAt = ts;
      state.dirty = true;
      adopted = true;
    }
  }
  return adopted;
}

// session/event firehose 入口（index.mjs 用根 ctx 全局订阅，按 session.id 过滤后调用）。
function handleEvent(state, session, event) {
  if (session === null || typeof session !== 'object' || event === null || typeof event !== 'object') return;
  const sessionId = typeof session.id === 'string' ? session.id : (typeof session.header?.id === 'string' ? session.header.id : '');
  if (sessionId === '') return;
  const seq = Number.isFinite(event.seq) ? event.seq : null;
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
  // 回合推进：turn/end（finally 必发，E-1 D.2）以 data.turn 为准维护会话回合号。
  if (event.type === 'turn/end') {
    const turn = Number.isFinite(data.turn) ? data.turn : (state.sessionTurns.get(sessionId) ?? 0) + 1;
    state.sessionTurns.set(sessionId, turn);
  }
  anchorRecord(state, sessionId, event, data, seq);
  const adopted = detectReferences(state, sessionId, event, seq, state.now());
  if (adopted || checkWindows(state, state.now())) fireChange(state);
}

function register(state, { parentSessionId, id, ledgerKey, mode, dispatchedAt }) {
  if (emptyKey(parentSessionId) || emptyKey(id) || emptyKey(ledgerKey)) return false;
  const key = recordKey(parentSessionId, id);
  if (state.records.has(key)) return false;
  state.records.set(key, {
    parentSessionId,
    id,
    ledgerKey,
    mode: typeof mode === 'string' ? mode : 'one-shot',
    dispatchedAt: Number.isFinite(dispatchedAt) ? dispatchedAt : state.now(),
    anchorSeq: null,
    anchorTurn: null,
    adoptedAt: null,
    decidedFalse: false,
    snippet: '',
  });
  state.dirty = true;
  persistState(state.stateFile, state.records, state.warn);
  state.dirty = false;
  ensureTimer(state);
  return true;
}

// 子结算时注入输出片段（仅内存；内容复用判定第二层信号，绝不落盘）。
function updateOutput(state, parentSessionId, id, output) {
  const rec = state.records.get(recordKey(parentSessionId, id));
  if (rec === undefined) return;
  if (typeof output !== 'string' || output === '') return;
  rec.snippet = output.slice(0, SNIPPET_CHARS);
}

// 父会话结束（agent/disposed 挂钩）：未决记录一律判明确未采纳并触发重算。
function parentDisposed(state, parentSessionId) {
  if (emptyKey(parentSessionId)) return;
  let changed = false;
  for (const rec of pendingFor(state, parentSessionId)) {
    if (markDecidedFalse(state, rec)) changed = true;
  }
  if (changed) fireChange(state);
}

function confirmedFalseCounts(state, ts) {
  const counts = new Map();
  for (const rec of state.records.values()) {
    if (triState(state, rec, ts) !== 'false') continue;
    counts.set(rec.ledgerKey, (counts.get(rec.ledgerKey) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

function pendingCountOf(state) {
  let count = 0;
  for (const rec of state.records.values()) {
    if (rec.adoptedAt === null && rec.decidedFalse !== true) count += 1;
  }
  return count;
}

export function createAdoptionTracker(options = {}) {
  const state = createState({
    stateFile: options.stateFile,
    windowN: options.windowN ?? DEFAULT_WINDOW_N,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    warn: options.warn ?? (() => {}),
    onDecision: options.onDecision ?? (() => {}),
    onDecided: options.onDecided ?? (() => {}),
    now: options.now ?? Date.now,
  });
  return {
    register: (entry) => register(state, entry),
    updateOutput: (parentSessionId, id, output) => updateOutput(state, parentSessionId, id, output),
    handleEvent: (session, event) => handleEvent(state, session, event),
    parentDisposed: (parentSessionId) => parentDisposed(state, parentSessionId),
    checkWindows: (ts) => checkWindows(state, ts),
    triState: (rec, ts) => triState(state, rec, ts),
    // 按记录查询三态（测试与排障用）：未知记录返回 null。
    statusOf(parentSessionId, id, ts) {
      const rec = state.records.get(recordKey(parentSessionId, id));
      if (rec === undefined) return null;
      return triState(state, rec, ts);
    },
    confirmedFalseCounts: (ts = state.now()) => confirmedFalseCounts(state, ts),
    pendingCount: () => pendingCountOf(state),
    dispose() {
      if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
    },
  };
}
