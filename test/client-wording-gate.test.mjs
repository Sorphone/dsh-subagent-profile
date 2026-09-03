// test/client-wording-gate.test.mjs — 用词规范总表机检：
// 用户可见文案（含注释防漂移）零内部术语；规范词存在性断言。与上一版验收
// grep 九词构成完整用词门禁。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

test('用词规范：内部术语零命中（闸/护栏/五环/感知/请求值对照/P5 等）', () => {
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

test('用词规范：规范词存在（安全检查 / 交集非空 / 审批不豁免 / 发起 / 结算）', () => {
  for (const word of ['安全检查', '交集非空', '审批不豁免', '派发决策时间线', '① 发起', '④ 结算', '请求 vs 生效', '父会话', '结束原因', '成本']) {
    assert.ok(source.includes(word), '必须存在规范词：' + word);
  }
  // 闸名徽标五项齐（白名单/成本/交集非空/审批不豁免/预算）。
  const badges = source.indexOf("ledgerGateBadgeZh");
  assert.ok(badges >= 0, '安全检查五项徽标映射必须存在');
  assert.match(source.slice(badges, badges + 200), /白名单.*成本.*交集非空.*审批不豁免.*预算/);
});

test('用词规范：index.mjs 用户可见文案零内部词（逃生舱提醒/draft 检查）', () => {
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

test('用词规范：术语人话化零残留（空态/成功率 N=/加权成功分/阈值/箭头）', () => {
  // 旧文案零残留（2026-09-03 术语批次五项）：① 建议面板空态 ② 方案列表成功率/N=
  // ③ 近期表现指标行标签 ④ 审计停滞「阈值」⑤ 审计箭头 ▾。
  for (const stale of ['暂无建议（需累计', '加权成功分低于阈值', '成功率 ${profile.successRate}', '（N=${profile.n}）', '超过阈值 {t}s', '停滞阈值 30s', '查看完整因果链 ▾']) {
    assert.ok(!source.includes(stale), '旧术语文案不得残留：' + stale);
  }
  // 定稿文案存在：空态人话化 / 列表近期表现口径 / 指标行标签人话化 / 停滞上限 / 箭头 ▸。
  for (const fresh of ["advicePanelEmpty: '暂无建议（近期派发表现不佳时才会生成）'", '近期表现 ${Math.round(profile.successRate * 100)}/100', '（基于最近 ${profile.n} 次派发）', "if (index === 0) {", "return space > 0 ? '近期表现分 ' + metric.slice(space + 1) : metric", "ledgerStallThresholdNote: '停滞上限 30s（待实测）'", "ledgerEvidenceToggle: '查看完整因果链 ▸'"]) {
    assert.ok(source.includes(fresh), '定稿文案必须存在：' + fresh);
  }
});

test('建议面板用词收口：「加权成功分」零残留（lib+client 用户可见串），「近期表现分」在产', () => {
  // lib 全量扫描（client.js + lib/**/*.mjs）：剥离注释后代码不得再出现旧标签——
  // 只允许注释说明保留旧标签（如 client.js 的历史台账显示层映射说明、renewal 数据
  // 指纹注释），任何用户可见串（指标行/建议理由/面板渲染）一律用「近期表现分」。
  const libRoot = fileURLToPath(new URL('../lib', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.mjs') || ent.name.endsWith('.js')) files.push(p);
    }
  };
  walk(libRoot);
  assert.ok(files.length > 0, 'lib 扫描文件集非空');
  for (const p of files) {
    const text = readFileSync(p, 'utf8');
    const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!codeOnly.includes('加权成功分'), '用户可见串不得残留旧标签：' + p);
  }
  // 「近期表现分」必须是产出端与显示端共同的规范词。
  const advice = readFileSync(fileURLToPath(new URL('../lib/core/evolution-advice.mjs', import.meta.url)), 'utf8');
  assert.ok(advice.includes('近期表现分'), '建议指标行必须产出「近期表现分」');
  assert.ok(!advice.includes('加权成功分'), 'evolution-advice 不得再产出旧标签（含注释）');
  assert.ok(source.includes('近期表现分'), 'client.js 显示层映射目标必须是「近期表现分」');
});

