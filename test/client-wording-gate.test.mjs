// test/client-wording-gate.test.mjs — 批次 7 用词规范总表机检：
// 用户可见文案（含注释防漂移）零内部术语；规范词存在性断言。与批次 6 验收
// grep 九词构成完整用词门禁。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

test('批次 7 用词规范：内部术语零命中（闸/护栏/五环/感知/请求值对照/P5 等）', () => {
  const forbidden = [
    '护栏过', '预览闸', '过闸预览', '工具交集为空', '未能识别的闸',
    '审批 = never', '= never', '感知', '五环', '认知闭环', '新感知',
    'P5', 'system-trust', 'evolution:advice', 'dispatch.jsonl',
    '请求值对照', '父内部推理不暴露', '安全不变量'
  ];
  for (const word of forbidden) {
    assert.ok(!source.includes(word), '用户可见面不得出现内部术语：' + word);
  }
});

test('批次 7 用词规范：规范词存在（安全检查 / 交集非空 / 审批不豁免 / 发起 / 结算）', () => {
  for (const word of ['安全检查', '交集非空', '审批不豁免', '派发决策时间线', '① 发起', '④ 结算', '请求 vs 生效', '父会话', '结束原因', '成本']) {
    assert.ok(source.includes(word), '必须存在规范词：' + word);
  }
  // 闸名徽标五项齐（白名单/成本/交集非空/审批不豁免/预算）。
  const badges = source.indexOf("ledgerGateBadgeZh");
  assert.ok(badges >= 0, '安全检查五项徽标映射必须存在');
  assert.match(source.slice(badges, badges + 200), /白名单.*成本.*交集非空.*审批不豁免.*预算/);
});

test('批次 7 用词规范：index.mjs 用户可见文案零内部词（逃生舱提醒/draft 检查）', () => {
  const host = readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8');
  for (const word of ['system-trust', '三道闸', '过闸预览', '闸检查', '未通过闸', '方案键']) {
    assert.ok(!host.includes(word), 'index.mjs 用户可见面不得出现内部术语：' + word);
  }
  assert.ok(host.includes('非官方预设'), '逃生舱提醒必须用「非官方预设」');
  assert.ok(host.includes('其余安全检查仍全量生效'), '逃生舱提醒必须用「安全检查」');
});

test('host 侧未采纳事件：审计 + 注意级提醒同源 mint（条目补全）', () => {
  const host = readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8');
  const reminderMod = readFileSync(fileURLToPath(new URL('../lib/core/adoption-reminder.mjs', import.meta.url)), 'utf8');
  assert.ok(host.includes('mintUnadoptedReminder'), '未采纳判定必须接入提醒 mint');
  assert.ok(reminderMod.includes("kind: 'adoption-false'"), '未采纳事件必须写治理审计');
  assert.ok(reminderMod.includes("title: '派发结果未被采纳'"), '未采纳事件必须 mint 提醒条目');
  assert.ok(reminderMod.includes('父 Agent 未采用该结果'), '提醒说明必须人话可读');
});
