// lib/core/background-ledger.mjs — 后台派发结算内存台账（兜底）。
// 后台 execute 返回时任务未结算，decisionTrace 无 settled；结算后无法回写已返回的
// 会话块，故按 sessionId 记录 jobId → settled 摘要，供 /ledger/jobs?session= 路由
// 让 client 按 jobId join；另带 callId（运行中的 tool-call 块没有
// jobId，按 callId 精确配对 live 状态）。仅存可观测结算字段，不存子输出正文。进程重启即失。

function sanitizeSettled(settled) {
  if (settled === null || typeof settled !== 'object') return { status: 'failed', stopReason: 'error' }
  return {
    status: typeof settled.status === 'string' ? settled.status : 'failed',
    stopReason: typeof settled.stopReason === 'string' ? settled.stopReason : 'error',
    elapsedMs: Number.isFinite(settled.elapsedMs) ? settled.elapsedMs : null,
    ...(Number.isFinite(settled.childTotalTokens) ? { childTotalTokens: settled.childTotalTokens } : {}),
    ...(settled.childUsage !== null && typeof settled.childUsage === 'object' ? { childUsage: settled.childUsage } : {}),
    ...(settled.calls !== null && typeof settled.calls === 'object' ? { calls: settled.calls } : {}),
    ...(typeof settled.childSessionId === 'string' && settled.childSessionId !== '' ? { childSessionId: settled.childSessionId } : {}),
    outputLen: typeof settled.output === 'string' ? settled.output.length : 0,
  }
}

// 条数上限淘汰（与结算记录共用）：每会话/总量超限丢最旧，绝不抛。
function trimSessions(sessions, maxPerSession, maxTotal) {
  let total = 0; for (const l of sessions.values()) total += l.length;
  while (total > maxTotal) {
    const firstKey = sessions.keys().next();
    if (firstKey.done) break;
    const first = sessions.get(firstKey.value);
    first.shift();
    if (first.length === 0) sessions.delete(firstKey.value);
    total -= 1;
  }
}

function createBackgroundLedger({ maxPerSession = 50, maxTotal = 500 } = {}) {
  const sessions = new Map();
  const record = (sessionId, jobId, settled, callId) => {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof jobId !== 'string' || jobId === '') return;
    let list = sessions.get(sessionId);
    if (list === undefined) { list = []; sessions.set(sessionId, list); }
    const existing = list.find((item) => item.jobId === jobId);
    if (existing !== undefined) {
      if (typeof callId === 'string' && callId !== '') existing.callId = callId;
      existing.settled = sanitizeSettled(settled);
      return;
    }
    list.push({ jobId, ...(typeof callId === 'string' && callId !== '' ? { callId } : {}), settled: sanitizeSettled(settled) });
    if (list.length > maxPerSession) list.shift();
    trimSessions(sessions, maxPerSession, maxTotal);
  };
  // 运行中的后台任务补记 childSessionId（jobId → 子会话 id）：结算前就可供
  // /ledger/jobs 与子会话页头识别「这是后台派发的子会话」。重复记录只补字段。
  const recordChild = (sessionId, jobId, childSessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof jobId !== 'string' || jobId === '' || typeof childSessionId !== 'string' || childSessionId === '') return;
    let list = sessions.get(sessionId);
    if (list === undefined) { list = []; sessions.set(sessionId, list); }
    const existing = list.find((item) => item.jobId === jobId);
    if (existing !== undefined) { existing.childSessionId = childSessionId; return; }
    list.push({ jobId, childSessionId });
    if (list.length > maxPerSession) list.shift();
    trimSessions(sessions, maxPerSession, maxTotal);
  };
  const get = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return [];
    const list = sessions.get(sessionId);
    return list === undefined ? [] : [...list];
  };
  const clear = () => sessions.clear();
  return { record, recordChild, get, clear };
}

export { createBackgroundLedger };