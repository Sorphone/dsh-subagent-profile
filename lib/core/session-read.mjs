// lib/core/session-read.mjs — 会话事件统一读取口（双轨兼容）。
//
// 读取会话事件的两个不兼容环境：
//   * 稳定线：session.events 是数组（本插件当前发布环境的形状）；
//   * 新线：session.events 属性被移除，改为按需读取 session.snapshotEvents()。
// 直接改成新 API 会让稳定线崩溃；直接保留旧读法会在新线崩溃。因此本 helper
// 逐次 feature-detect：events 数组优先，snapshotEvents() 其次，两轨都不可用
// 时返回空数组（fall-soft，绝不抛出）。
//
// 返回语义：稳定线分支返回 session.events 原数组引用（不拷贝），保持既有
// identity 语义与零开销；新线分支返回 snapshotEvents() 的返回值（默认全量快照）。
export function readSessionEvents(session) {
  if (session === null || session === undefined) return [];
  if (Array.isArray(session.events)) return session.events;
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
  return [];
}
