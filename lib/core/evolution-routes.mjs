// lib/core/evolution-routes.mjs — 进化资产路由处理（/evolution/assets 只读列表 +
// /evolution/apply 应用写路径）。loopback 与 CSRF 守卫由 createHttpRoutes 入口统一
// 完成，本模块只做 body 解析与响应组装。apply 拒绝（400）回传原因与可选逐项 checks；
// 成功回传新方案 id、资产状态与 persisted 信号。apply 业务本体（三道闸/审计/锁）
// 在 evolution-engine 内，本模块不触碰任何闸判定。

import { json, readBody } from './http-helpers.mjs';

async function handleEvolutionAssets(deps, res) {
  const assets = deps.evolution !== undefined && typeof deps.evolution.list === 'function' ? deps.evolution.list() : [];
  return json(res, 200, { ok: true, assets });
}

async function handleEvolutionApply(deps, req, res) {
  const body = await readBody(req);
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  if (assetId === '') return json(res, 400, { ok: false, error: 'assetId 不能为空' });
  if (deps.evolution === undefined || typeof deps.evolution.apply !== 'function') {
    return json(res, 404, { ok: false, error: '进化 apply 引擎未装配' });
  }
  const result = await deps.evolution.apply({ assetId, humanConfirmed: body.human_confirmed === true });
  if (!result.ok) {
    const payload = { ok: false, error: result.reason };
    if (result.checks !== undefined) payload.checks = result.checks;
    return json(res, 400, payload);
  }
  return json(res, 200, {
    ok: true,
    id: result.id,
    state: result.state,
    persisted: result.persisted,
    ...(result.persisted ? {} : { persistWarning: '已应用但未持久化' }),
  });
}

export { handleEvolutionAssets, handleEvolutionApply };
