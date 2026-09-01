// test/session-read.test.mjs — readSessionEvents 双轨读取四分支。
// 覆盖：
//   * session.events 为数组 → 返回该数组（同引用，非拷贝；同时有
//     snapshotEvents 时 events 优先）；
//   * 无 events 但有 snapshotEvents 函数 → 返回其无参调用结果；
//   * events 与 snapshotEvents 都缺失 → 返回 []；
//   * session 为 null / undefined → 返回 []，不抛。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSessionEvents } from '../lib/core/session-read.mjs';

test('readSessionEvents：session.events 为数组 → 返回原数组引用（events 优先于 snapshotEvents）', () => {
  const events = [{ type: 'step/start', data: {} }];
  const session = { events, snapshotEvents: () => [{ type: 'assistant/message' }] };
  assert.equal(readSessionEvents(session), events, '必须返回 events 原引用而非拷贝');
  assert.equal(readSessionEvents({ events }), events, '仅有 events 时同样返回原引用');
});

test('readSessionEvents：无 events 但有 snapshotEvents 函数 → 返回其无参调用结果', () => {
  const snapshot = [{ type: 'assistant/message', data: { usage: { inputTokens: 1 } } }];
  const calls = [];
  const session = {
    snapshotEvents: (...args) => {
      calls.push(args);
      return snapshot;
    },
  };
  assert.equal(readSessionEvents(session), snapshot);
  assert.deepEqual(calls, [[]], 'snapshotEvents 必须以无参形式调用（默认全量快照）');
});

test('readSessionEvents：events 与 snapshotEvents 都缺失 → 返回 []', () => {
  assert.deepEqual(readSessionEvents({}), []);
  assert.deepEqual(readSessionEvents({ events: '不是数组' }), []);
});

test('readSessionEvents：session 为 null / undefined → 返回 [] 不抛', () => {
  assert.deepEqual(readSessionEvents(null), []);
  assert.deepEqual(readSessionEvents(undefined), []);
});
