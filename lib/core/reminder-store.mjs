// lib/core/reminder-store.mjs — 提醒系统 host 侧 store + 审计同源。
// 一条提醒 = 一条治理审计记录（经 audit 钩子写入 governance-audit.jsonl，与 [6] 审计
// 同源）；每个用户动作（采纳/忽略/拒绝/关闭）与「标记已读」都追加审计留痕。P0 三要件：
// severity 上色（P0 由 client 用错误色渲染）、常驻至已读（unread 标记，绝不自动消失）、
// 带 session 标识（sessionId 字段；全局异常显式 null，client 标注「全局」）。
// 隐私红线：只落结构字段（severity/kind/title/detail/sessionId/时间戳）与「未采纳」
// 条目的展示字段（子会话 id/模式、prompt 摘要 ≤200 字符、结算摘要结构、估算成本）。
// prompt 摘要不存原文，结算摘要无子输出正文；其余提醒类不携带这些字段（null）。
// 落盘 subagent-evolution/reminders.json（原子写 tmp+rename；损坏/形状不符
// fail-soft 从空起步）。import-free（仅 node 内置），可被裸 CI 单测。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SEVERITIES = new Set(['P0', 'P1', 'P2']);
const MAX_REMINDERS = 200;

function isRecordShape(rec) {
  return rec !== null && typeof rec === 'object' && typeof rec.id === 'string'
    && typeof rec.severity === 'string' && typeof rec.kind === 'string'
    && typeof rec.title === 'string' && typeof rec.detail === 'string';
}

// 结算摘要形状守卫（宽松）：只接受非数组对象，具体字段逐个归一。
function isSettleShape(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSettled(value) {
  if (!isSettleShape(value)) return null;
  return {
    stopReason: typeof value.stopReason === 'string' ? value.stopReason : '',
    elapsedMs: Number.isFinite(value.elapsedMs) ? value.elapsedMs : null,
    ...(Number.isFinite(value.childTotalTokens) ? { childTotalTokens: value.childTotalTokens } : {}),
    ...(isSettleShape(value.childUsage) ? { childUsage: value.childUsage } : {}),
    ...(typeof value.childSessionId === 'string' && value.childSessionId !== '' ? { childSessionId: value.childSessionId } : {}),
  };
}

function loadState(stateFile, state, warn) {
  if (stateFile === undefined) return;
  try {
    if (!existsSync(stateFile)) return;
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1 || !Array.isArray(parsed.reminders)) {
      warn('reminder store: 提醒文件版本或形状不符，从空状态起步');
      return;
    }
    for (const raw of parsed.reminders) {
      if (!isRecordShape(raw)) continue;
      state.reminders.push({
        id: raw.id,
        severity: SEVERITIES.has(raw.severity) ? raw.severity : 'P2',
        kind: raw.kind,
        title: raw.title,
        detail: raw.detail,
        sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
        childId: typeof raw.childId === 'string' && raw.childId !== '' ? raw.childId : null,
        childSessionId: typeof raw.childSessionId === 'string' && raw.childSessionId !== '' ? raw.childSessionId : null,
        childMode: typeof raw.childMode === 'string' && raw.childMode !== '' ? raw.childMode : null,
        promptExcerpt: typeof raw.promptExcerpt === 'string' ? raw.promptExcerpt : '',
        settled: normalizeSettled(raw.settled),
        costEstimated: Number.isFinite(raw.costEstimated) ? raw.costEstimated : null,
        unread: raw.unread !== false,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
        action: typeof raw.action === 'string' ? raw.action : null,
        actedAt: Number.isFinite(raw.actedAt) ? raw.actedAt : null,
      });
    }
  } catch (error) {
    warn('reminder store: 提醒文件读取失败，从空状态起步（' + (error instanceof Error ? error.message : String(error)) + '）');
  }
}

function persistState(stateFile, state, warn) {
  if (stateFile === undefined) return;
  const tmp = stateFile + '.tmp';
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ v: 1, reminders: state.reminders }, null, 2), 'utf8');
    renameSync(tmp, stateFile);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    warn('reminder store: 提醒文件写入失败（' + (error instanceof Error ? error.message : String(error)) + '）');
  }
}

function auditReminder(audit, kind, reminder, action) {
  audit({
    kind,
    reminderId: reminder.id,
    severity: reminder.severity,
    reminderKind: reminder.kind,
    ...(reminder.sessionId !== null ? { sessionId: reminder.sessionId } : {}),
    ...(action !== undefined ? { action } : {}),
  });
}

// 产生一条提醒：severity 非法回退 P2；空 sessionId 归一 null（全局）。「未采纳」
// 条目额外携带子会话 id/模式、prompt 摘要（≤200 字符再截一次防超）、结算摘要与估算
// 成本；其余提醒类这些字段为空/null。创建即审计。
function recordReminder(state, persist, audit, { severity, kind, title, detail, sessionId, childId, childSessionId, childMode, promptExcerpt, settled, costEstimated }) {
  const reminder = {
    id: 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    severity: SEVERITIES.has(severity) ? severity : 'P2',
    kind: typeof kind === 'string' && kind !== '' ? kind : 'event',
    title: typeof title === 'string' ? title : '',
    detail: typeof detail === 'string' ? detail : '',
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    childId: typeof childId === 'string' && childId !== '' ? childId : null,
    childSessionId: typeof childSessionId === 'string' && childSessionId !== '' ? childSessionId : null,
    childMode: typeof childMode === 'string' && childMode !== '' ? childMode : null,
    promptExcerpt: typeof promptExcerpt === 'string' ? promptExcerpt.slice(0, 200) : '',
    settled: normalizeSettled(settled),
    costEstimated: Number.isFinite(costEstimated) ? costEstimated : null,
    unread: true,
    createdAt: Date.now(),
    action: null,
    actedAt: null,
  };
  state.reminders.push(reminder);
  if (state.reminders.length > state.maxReminders) state.reminders.shift();
  persist();
  auditReminder(audit, 'reminder-created', reminder);
  return reminder;
}

// 标记已读（unread=false）：P0 角标常驻至已读的「已读」动作，逐条留痕。
function ackReminders(state, persist, audit, ids) {
  const list = Array.isArray(ids) ? ids : [];
  const acked = [];
  for (const reminder of state.reminders) {
    if (reminder.unread !== true || !list.includes(reminder.id)) continue;
    reminder.unread = false;
    acked.push(reminder.id);
    auditReminder(audit, 'reminder-acked', reminder);
  }
  if (acked.length > 0) persist();
  return acked;
}

// 用户动作（采纳/忽略/拒绝/关闭）：互斥终态 + 审计留痕（关闭留痕要求）。
function actOnReminder(state, persist, audit, id, action) {
  const reminder = state.reminders.find((r) => r.id === id);
  if (reminder === undefined) return false;
  if (action !== 'adopt' && action !== 'ignore' && action !== 'reject' && action !== 'dismiss') return false;
  reminder.action = action;
  reminder.actedAt = Date.now();
  reminder.unread = false;
  persist();
  auditReminder(audit, 'reminder-action', reminder, action);
  return true;
}

function listReminders(state, unreadOnly) {
  const all = [...state.reminders].reverse();
  return unreadOnly ? all.filter((r) => r.unread === true) : all;
}

export function createReminderStore({ dshHome, audit = () => {}, warn = () => {}, maxReminders = MAX_REMINDERS } = {}) {
  const state = { reminders: [], maxReminders: Number.isFinite(maxReminders) && maxReminders > 0 ? maxReminders : MAX_REMINDERS };
  const stateFile = dshHome !== undefined && dshHome !== '' ? join(dshHome, 'subagent-evolution', 'reminders.json') : undefined;
  loadState(stateFile, state, warn);
  const persist = () => persistState(stateFile, state, warn);
  return {
    record: (entry) => recordReminder(state, persist, audit, entry),
    ack: (ids) => ackReminders(state, persist, audit, ids),
    actOn: (id, action) => actOnReminder(state, persist, audit, id, action),
    list: ({ unreadOnly = false } = {}) => listReminders(state, unreadOnly),
    unreadCount: () => state.reminders.filter((r) => r.unread === true).length,
  };
}
