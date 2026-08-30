// test/ledger-toolset-fields.test.mjs — 批次 7 工具集子节 host 侧最小字段集：
// intersection 闸（continuable）output 增加 effectiveAllowNames 与 removedTools
// （移除清单：run_code 固定移除 + 不在白名单），台账证据层工具集子节展示用。
// removedTools 超 8 项截断为 { values, truncated }，与名单类截断口径一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIntersectionGate } from '../lib/core/dispatch-gates.mjs';

function gateOf() {
  const trace = { gates: [] };
  applyIntersectionGate(trace, 'continuable', { parentToolCount: 5, requestedToolFilter: { allow: ['read', 'grep'] }, mode: 'continuable' }, { toolFilter: { allow: ['read', 'grep'] } }, ['read', 'write', 'grep', 'bash', 'run_code', 'glob']);
  const gate = trace.gates.find((g) => g.name === 'intersection');
  assert.ok(gate, '必须有 intersection 闸');
  assert.equal(gate.verdict, 'pass');
  return gate;
}

test('continuable 交集闸：effectiveAllowNames + removedTools（run_code 固定移除原因）', () => {
  const gate = gateOf();
  assert.equal(gate.output.effectiveAllowCount, 2);
  assert.deepEqual(gate.output.effectiveAllowNames, ['read', 'grep']);
  const removed = gate.output.removedTools;
  assert.ok(Array.isArray(removed), 'removedTools 必须为数组');
  const runCode = removed.find((r) => r.name === 'run_code');
  assert.ok(runCode, 'run_code 必须在移除清单');
  assert.equal(runCode.reason, '安全策略：子代理不执行代码');
  const write = removed.find((r) => r.name === 'write');
  assert.equal(write.reason, '不在白名单');
});

test('removedTools 超 8 项截断为 { values, truncated }', () => {
  const parent = ['run_code', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
  const trace = { gates: [] };
  applyIntersectionGate(trace, 'continuable', { parentToolCount: 10, mode: 'continuable' }, { toolFilter: { deny: ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'] } }, parent);
  const gate = trace.gates.find((g) => g.name === 'intersection');
  assert.equal(gate.verdict, 'pass');
  assert.equal(gate.output.effectiveAllowCount, 1);
  assert.equal(gate.output.removedTools.truncated, true, '截断标记');
  assert.equal(gate.output.removedTools.values.length, 8, '前 8 项');
});
