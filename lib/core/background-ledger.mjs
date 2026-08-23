// lib/core/background-ledger.mjs — 后台派发结算内存台账（Task 38a 兜底）。
// 后台 execute 返回时任务未结算，decisionTrace 无 settled；结算后无法回写已返回的
// 会话块，故按 sessionId 记录 jobId → settled 摘要，供 /ledger/jobs?session= 路由
// 让 client 按 jobId join。仅存可观测结算字段，不存子输出正文。进程重启即失。

function sanitizeSettled(settled) {
  if (settled === null || typeof settled !== 'object') return { status: 'failed', stopReason: 'error' }
  return {
    status: typeof settled.status === 'string' ? settled.status : 'failed',
    stopReason: typeof settled.stopReason === 'string' ? settled.stopReason : 'error',
    elapsedMs: Number.isFinite(settled.elapsedMs) ? settled.elapsedMs : null,
    ...(Number.isFinite(settled.childTotalTokens) ? { childTotalTokens: settled.childTotalTokens } : {}),
    ...(settled.childUsage !== null && typeof settled.childUsage === 'object' ? { childUsage: settled.childUsage } : {}),
    ...(settled.calls !== null && typeof settled.calls === 'object' ? { calls: settled.calls } : {}),
    outputLen: typeof settled.output === 'string' ? settled.output.length : 0,
  }
}

function createBackgroundLedger({ maxPerSession = 50, maxTotal = 500 } = {}) {
  const sessions = new Map();
  const record = (sessionId, jobId, settled) => {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof jobId !== 'string' || jobId === '') return;
    let list = sessions.get(sessionId);
    if (list === undefined) { list = []; sessions.set(sessionId, list); }
    list.push({ jobId, settled: sanitizeSettled(settled) });
    if (list.length > maxPerSession) list.shift();
    let total = 0; for (const l of sessions.values()) total += l.length;
    while (total > maxTotal) {
      const firstKey = sessions.keys().next();
      if (firstKey.done) break;
      const first = sessions.get(firstKey.value);
      first.shift();
      if (first.length === 0) sessions.delete(firstKey.value);
      total -= 1;
    }
  };
  const get = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return [];
    const list = sessions.get(sessionId);
    return list === undefined ? [] : [...list];
  };
  const clear = () => sessions.clear();
  return { record, get, clear };
}

export { createBackgroundLedger };