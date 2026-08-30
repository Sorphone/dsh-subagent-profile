// test/reminder-store.test.mjs — 提醒系统（Task 42 NT1）host store + 路由。
// 一条提醒 = 一条治理审计记录；全动作（创建/已读/采纳/忽略/拒绝/关闭）入审计；
// P0 三要件字段（severity 上色源、unread 常驻至已读、sessionId 标识）；持久化重启。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReminderStore, reminderDetailText } from '../lib/core/reminder-store.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute } from './harness/routes.mjs';

const mod = await import('../index.mjs');

test('reminder store：record 归一（severity 回退 P2、空 sessionId 归一 null）+ P0 三要件字段', () => {
  const audits = [];
  const store = createReminderStore({ audit: (entry) => audits.push(entry) });
  const p0 = store.record({ severity: 'P0', kind: 'audit-degraded', title: '审计降级', detail: 'd', sessionId: null });
  assert.equal(p0.severity, 'P0');
  assert.equal(p0.sessionId, null, '全局异常 sessionId 必须显式 null（client 标注「全局」）');
  assert.equal(p0.unread, true, 'P0 必须未读起步（常驻至已读）');
  assert.equal(typeof p0.id, 'string');
  const bad = store.record({ severity: 'X', kind: 'k', title: 't', detail: 'd', sessionId: '' });
  assert.equal(bad.severity, 'P2', '非法 severity 回退 P2');
  assert.equal(bad.sessionId, null, '空 sessionId 归一 null');
  const withSession = store.record({ severity: 'P1', kind: 'escape-allow', title: 't', detail: 'd', sessionId: 's1' });
  assert.equal(withSession.sessionId, 's1', '会话级提醒必须带 session 标识');
  assert.equal(audits.length, 3, '每条提醒创建即审计');
});

test('reminder store：全动作入审计（已读/采纳/忽略/拒绝/关闭留痕）', () => {
  const audits = [];
  const store = createReminderStore({ audit: (entry) => audits.push(entry) });
  const r = store.record({ severity: 'P1', kind: 'escape-allow', title: 't', detail: 'd', sessionId: 's1' });
  store.ack([r.id]);
  assert.equal(store.unreadCount(), 0, '已读后不再未读');
  for (const action of ['adopt', 'ignore', 'reject', 'dismiss']) {
    const r2 = store.record({ severity: 'P2', kind: 'adoption-false', title: 't', detail: 'd', sessionId: 's2' });
    assert.equal(store.actOn(r2.id, action), true, action + ' 必须成功');
  }
  assert.equal(store.actOn('missing', 'adopt'), false, '未知 id 拒绝');
  assert.equal(store.actOn(r.id, 'bogus'), false, '非法动作拒绝');
  const kinds = audits.map((a) => a.kind + ':' + (a.action ?? ''));
  assert.ok(kinds.includes('reminder-created:'));
  assert.ok(kinds.includes('reminder-acked:'));
  for (const action of ['adopt', 'ignore', 'reject', 'dismiss']) {
    assert.ok(kinds.includes('reminder-action:' + action), '动作 ' + action + ' 必须审计留痕');
  }
});

test('reminder store：持久化重启（动作态与已读态保留）+ 上限淘汰', () => {
  const iso = makeIsolatedDshHome();
  try {
    const file = join(iso.dir, 'subagent-evolution', 'reminders.json');
    const audits = [];
    const a = createReminderStore({ dshHome: iso.dir, audit: (entry) => audits.push(entry), maxReminders: 3 });
    const r1 = a.record({ severity: 'P0', kind: 'audit-degraded', title: 't1', detail: 'd', sessionId: null });
    a.record({ severity: 'P1', kind: 'x', title: 't2', detail: 'd', sessionId: 's1' });
    a.record({ severity: 'P2', kind: 'y', title: 't3', detail: 'd', sessionId: 's2' });
    const r4 = a.record({ severity: 'P2', kind: 'z', title: 't4', detail: 'd', sessionId: null });
    a.actOn(r4.id, 'dismiss');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.v, 1);
    assert.equal(parsed.reminders.length, 3, '上限淘汰最旧');
    assert.ok(!parsed.reminders.some((r) => r.id === r1.id), '最旧记录必须被淘汰');
    // 重启：从文件恢复。
    const b = createReminderStore({ dshHome: iso.dir, audit: () => {} });
    const restored = b.list().find((r) => r.id === r4.id);
    assert.ok(restored !== undefined);
    assert.equal(restored.action, 'dismiss', '动作态必须保留');
    assert.equal(restored.unread, false, '已读/动作后未读态必须保留');
  } finally { iso.restore(); iso.teardown(); }
});

test('路由：GET /reminders + POST /reminders/ack + POST /reminders/action（种子文件注入）', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const evoDir = join(iso.dir, 'subagent-evolution');
    mkdirSync(evoDir, { recursive: true });
    const seed = {
      v: 1,
      reminders: [
        { id: 'r-seed-1', severity: 'P0', kind: 'audit-degraded', title: '审计降级', detail: 'd', sessionId: null, unread: true, createdAt: 1, action: null, actedAt: null },
        { id: 'r-seed-2', severity: 'P2', kind: 'adoption-false', title: '未被采纳', detail: 'd', sessionId: 's1', unread: true, createdAt: 2, action: null, actedAt: null },
      ],
    };
    writeFileSync(join(evoDir, 'reminders.json'), JSON.stringify(seed), 'utf8');
    const { webServer, routes } = makeRouteHarness();
    const { ctx } = createFakeCtx({ services: { webServer } });
    await mod.apply(ctx);
    const handler = routes[0].handler;
    const list = await callRoute(handler, 'GET', '/reminders');
    assert.equal(list.json.ok, true);
    assert.equal(list.json.reminders.length, 2);
    assert.equal(list.json.unread, 2);
    const ack = await callRoute(handler, 'POST', '/reminders/ack', { ids: ['r-seed-1'] });
    assert.deepEqual(ack.json.acked, ['r-seed-1']);
    const act = await callRoute(handler, 'POST', '/reminders/action', { id: 'r-seed-2', action: 'dismiss' });
    assert.equal(act.code, 200);
    const badAct = await callRoute(handler, 'POST', '/reminders/action', { id: 'missing', action: 'adopt' });
    assert.equal(badAct.code, 400);
    // 全动作审计留痕：governance-audit.jsonl 出现 reminder-action 行。
    const auditText = readFileSync(join(evoDir, 'governance-audit.jsonl'), 'utf8');
    assert.match(auditText, /"kind":"reminder-action"[^}]*"action":"dismiss"/);
    assert.match(auditText, /"kind":"reminder-acked"/);
  } finally { iso.restore(); iso.teardown(); }
});

test('reminderDetailText：派发未被采纳提醒人话化（内部词零泄露）', () => {
  assert.equal(
    reminderDetailText('(inline)', 'foreground', 'c1'),
    '派发方案 内联（前台 c1）在判定窗口内未被父会话采纳',
    '内联键 + 前台模式必须人话化'
  );
  assert.equal(
    reminderDetailText('preset:researcher|model:deepseek-v4-pro', 'background', 'job-1'),
    '派发方案 预设 researcher · 模型 deepseek-v4-pro（后台 job-1）在判定窗口内未被父会话采纳',
    '配置重建键 + 后台模式必须人话化'
  );
  assert.equal(
    reminderDetailText('(inline)', 'continuable', 's9'),
    '派发方案 内联（持续 s9）在判定窗口内未被父会话采纳',
    'continuable 模式映射「持续」'
  );
  assert.ok(!reminderDetailText('(inline)', 'foreground', 'c1').includes('方案键'), '不得出现内部词「方案键」');
});
