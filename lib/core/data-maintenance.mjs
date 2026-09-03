// lib/core/data-maintenance.mjs — 设置页数据维护（四区清理 + 快照管理路由）。
// 一个入口四区（避免多按钮）：① 候选/建议清理（进化资产域全清）② 快照清理
// （snapshots/ 一键清理）③ 提醒中心已处理归档（只移出活动列表，存储与
// governance-audit 保留——提醒=审计记录，绝不物理删除）④ 重置统计（dispatch.jsonl
// 封存为 dispatch-archive-<ts>.jsonl，历史台账归档保留、统计从零开始；summaries.json
// 置空重建）。每次清理记一条治理审计（kind: data-cleared / reminder-archived /
// stats-reset，字段 target/count/ts）。快照列表/开关/单条查看路由同驻本模块
// （快照域装配与清除口径单一来源）。CSRF 与 loopback 守卫由 createHttpRoutes
// 入口统一完成，本模块只做解析与执行。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { json, readBody, persistOk } from './http-helpers.mjs';
import { writeSummaries } from './evolution-summary.mjs';
import { SNAPSHOT_CAP } from './snapshots.mjs';

// ④ 重置统计执行：活动台账封存（rename，内容字节不变）+ 空台账重建 + summaries
// 置空。归档名有意不匹配轮转封存件模式（dispatch-<seq>-<ts>.jsonl）：金丝雀基线
// 不再读入（统计从零开始），后续自动轮转也不会淘汰（决策留痕保留）。
function resetStats(deps) {
  const dir = dirname(deps.dispatchFile);
  let count = 0;
  let archivedFile = null;
  if (existsSync(deps.dispatchFile)) {
    try {
      count = readFileSync(deps.dispatchFile, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
    } catch { count = 0; }
    if (count > 0) {
      const stamp = Date.now();
      let archive = join(dir, `dispatch-archive-${stamp}.jsonl`);
      let attempt = 0;
      while (existsSync(archive)) {
        attempt += 1;
        archive = join(dir, `dispatch-archive-${stamp}-${attempt}.jsonl`);
      }
      try {
        mkdirSync(dir, { recursive: true });
        renameSync(deps.dispatchFile, archive);
        archivedFile = basename(archive);
      } catch (error) {
        deps.logger.warn(`[dsh-subagent-profile] 台账封存失败（${error instanceof Error ? error.message : String(error)}），统计未重置`);
        return { count: 0, error: '台账封存失败，统计未重置' };
      }
    }
  }
  try {
    writeFileSync(deps.dispatchFile, '', 'utf8');
    writeSummaries(deps.summariesFile, { l1: {}, l2: {} });
  } catch (error) {
    deps.logger.warn(`[dsh-subagent-profile] 统计重建失败（${error instanceof Error ? error.message : String(error)}）`);
    return { count, archivedFile, error: '统计重建失败' };
  }
  deps.recordAudit({ kind: 'stats-reset', target: 'stats', count, ts: Date.now(), ...(archivedFile !== null ? { archivedFile } : {}) });
  return { count, archivedFile };
}

export function createDataMaintenance({ dispatchFile, summariesFile, snapshots, reminderStore, evolution, logger, store, recordAudit = () => {} } = {}) {
  const deps = { dispatchFile, summariesFile, snapshots, reminderStore, evolution, logger, store, recordAudit };
  return {
    // 四区清理：非法 zone 返回 null（调用方 400）；成功返回 { count, ... }。
    // 审计一次清理一条（target/count/ts），快照清理沿用 B8 口径 kind=data-cleared。
    clean(zone) {
      if (zone === 'candidates') {
        const count = deps.evolution !== undefined && typeof deps.evolution.purgeCandidates === 'function' ? deps.evolution.purgeCandidates() : 0;
        deps.recordAudit({ kind: 'data-cleared', target: 'candidates', count, ts: Date.now() });
        return { count };
      }
      if (zone === 'snapshots') {
        const count = deps.snapshots !== undefined && typeof deps.snapshots.clear === 'function' ? deps.snapshots.clear() : 0;
        deps.recordAudit({ kind: 'data-cleared', target: 'snapshots', count, ts: Date.now() });
        return { count };
      }
      if (zone === 'reminders') {
        const count = deps.reminderStore !== undefined && typeof deps.reminderStore.archiveActed === 'function' ? deps.reminderStore.archiveActed() : 0;
        deps.recordAudit({ kind: 'reminder-archived', target: 'reminders', count, ts: Date.now() });
        return { count };
      }
      if (zone === 'stats') return resetStats(deps);
      return null;
    },
  };
}

// ── 路由处理（快照管理 + 数据维护 + 提醒归档视图）─────────────────────────────

function handleSnapshotsList(deps, res) {
  if (deps.snapshots === undefined) return json(res, 404, { ok: false, error: '配置快照域未装配' });
  return json(res, 200, {
    ok: true,
    snapshotEnabled: typeof deps.store.loadSnapshotEnabled === 'function' ? deps.store.loadSnapshotEnabled() : false,
    count: deps.snapshots.count(),
    cap: SNAPSHOT_CAP,
    entries: deps.snapshots.list(),
  });
}

async function handleSnapshotsSetEnabled(deps, req, res) {
  const body = await readBody(req);
  const next = !!(body && body.snapshotEnabled === true);
  const persist = deps.store.persistSnapshotEnabled(next);
  return persistOk(res, { snapshotEnabled: deps.store.loadSnapshotEnabled() }, persist);
}

function handleSnapshotView(deps, url, res) {
  const id = url.searchParams.get('id') ?? '';
  const snapshot = deps.snapshots !== undefined ? deps.snapshots.view(id) : null;
  if (snapshot === null) return json(res, 404, { ok: false, error: '快照不存在或已损坏' });
  return json(res, 200, { ok: true, snapshot });
}

async function handleMaintenanceClean(deps, req, res) {
  const body = await readBody(req);
  const zone = typeof body.zone === 'string' ? body.zone : '';
  if (zone === '') return json(res, 400, { ok: false, error: 'zone 不能为空' });
  if (deps.maintenance === undefined) return json(res, 404, { ok: false, error: '数据维护入口未装配' });
  const result = deps.maintenance.clean(zone);
  if (result === null) return json(res, 400, { ok: false, error: 'zone 无效（candidates/snapshots/reminders/stats）' });
  if (result.error !== undefined) return json(res, 500, { ok: false, error: result.error });
  return json(res, 200, { ok: true, zone, count: result.count, ...(result.archivedFile !== undefined ? { archivedFile: result.archivedFile } : {}) });
}

function handleRemindersArchived(deps, url, res) {
  const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
  const page = deps.reminderStore !== undefined && typeof deps.reminderStore.listArchived === 'function'
    ? deps.reminderStore.listArchived({ offset, limit })
    : { reminders: [], total: 0, offset: 0, limit: 20 };
  return json(res, 200, { ok: true, ...page });
}

// 数据维护域路由分发：只处理本域路径，未知交给统一 404。
export async function routeDataMaintenance(deps, req, res, url, sub) {
  if (req.method === 'GET' && sub === '/snapshots') return handleSnapshotsList(deps, res);
  if (req.method === 'POST' && sub === '/snapshots/set-enabled') return handleSnapshotsSetEnabled(deps, req, res);
  if (req.method === 'GET' && sub === '/snapshot') return handleSnapshotView(deps, url, res);
  if (req.method === 'POST' && sub === '/maintenance/clean') return handleMaintenanceClean(deps, req, res);
  if (req.method === 'GET' && sub === '/reminders/archived') return handleRemindersArchived(deps, url, res);
  return json(res, 404, { ok: false, error: `未知路由 ${sub}` });
}
