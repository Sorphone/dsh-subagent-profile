// lib/core/cost-evidence.mjs — 省 token 证据（反事实对照，Task 38c 纯函数）。
// 判定读 trace.requested.model（不能读 effective.model：buildMeta 会把继承的父
// 模型名写进 effective，无法区分「继承父」与「显式选 pro」）。未指定 model 时
// saving=0 并打标「未指定模型（继承父）」，让根因①可见。
//
// 成本口径：B 级五段单价可用时按 usage 逐段计价（元/千 token）；否则回退 A 级
// 单次均价（docs/cost-closed-loop-design.md L14 实测）。无价格/无 usage/无模型
// 一律 fail-soft 返回 undefined，不显示不猜数。

import { MODEL_AVG_COST, MODEL_USAGE_PRICES, priceKeyFor } from './prices.mjs';

function costFromUsage(model, usage) {
  const key = priceKeyFor(model);
  if (key === undefined) return undefined;
  const prices = MODEL_USAGE_PRICES[key];
  if (prices === undefined) return undefined;
  let total = 0;
  let any = false;
  for (const seg of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const unit = prices[seg];
    const amount = usage?.[seg];
    if (typeof unit === 'number' && Number.isFinite(unit) && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
      total += (unit * amount) / 1000;
      any = true;
    }
  }
  return any ? Number(total.toFixed(6)) : undefined;
}

// 单条派发的估算成本（元）。优先五段计价，其次 A 级单次均价。
export function dispatchCost({ model, usage } = {}) {
  const key = priceKeyFor(model);
  if (key === undefined) return undefined;
  const byUsage = costFromUsage(model, usage);
  if (byUsage !== undefined) return byUsage;
  const avg = MODEL_AVG_COST[key];
  return typeof avg === 'number' ? avg : undefined;
}

// 反事实对照结果。record 为 dispatch.jsonl 行；显式指定 model 才有「继承父 vs
// 指定 model」价差，未指定（继承父）saving 恒 0 并打 inherit 标。
export function counterfactualFor(record) {
  if (record === null || typeof record !== 'object') return undefined;
  const requestedModel = record.requested?.model;
  const usage = record.outcome?.usage;
  const parentModel = record.parent_model;
  if (typeof requestedModel !== 'string' || requestedModel === '') {
    const parentCost = dispatchCost({ model: parentModel, usage });
    return {
      inherit: true,
      model: parentModel ?? null,
      actual: parentCost,
      counterfactual: parentCost,
      saving: 0,
      ratio: null,
    };
  }
  const actual = dispatchCost({ model: requestedModel, usage });
  const counterfactual = dispatchCost({ model: parentModel, usage });
  if (actual === undefined || counterfactual === undefined) return undefined;
  const saving = Number((counterfactual - actual).toFixed(6));
  return {
    inherit: false,
    model: requestedModel,
    parentModel: parentModel ?? null,
    actual,
    counterfactual,
    saving,
    ratio: actual > 0 ? Number((counterfactual / actual).toFixed(2)) : null,
  };
}

// 聚合一组 record 的估算成本与继承占比。只统计可计价（actual 非 undefined）记录。
export function summarizeCosts(records) {
  let actualSum = 0;
  let counterfactualSum = 0;
  let savingSum = 0;
  let priced = 0;
  let inheritCount = 0;
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const c = counterfactualFor(record);
    if (c === undefined) continue;
    if (c.actual === undefined) continue;
    actualSum += c.actual;
    if (c.counterfactual !== undefined) counterfactualSum += c.counterfactual;
    savingSum += c.saving;
    priced += 1;
    if (c.inherit) inheritCount += 1;
  }
  return {
    estimated_cost: Number(actualSum.toFixed(4)),
    estimated_inherit_cost: Number(counterfactualSum.toFixed(4)),
    estimated_saving: Number(savingSum.toFixed(4)),
    priced,
    inherit_count: inheritCount,
    inherit_ratio: priced > 0 ? Number((inheritCount / priced).toFixed(3)) : 0,
  };
}

// 从 summaries.json 的 l1/l2 聚合成本汇总：全局（所有 L1 组求和）与按模型轴
// （l2 的 :model: 键，同一模型多组归并）。同一记录只属一个 L1 组与一个 model 轴键，
// 故全局与模型轴各自无重复。无数据返回空汇总（调用方省略显示）。
export function costSummaryFromSummaries(summaries) {
  const root = summaries !== null && typeof summaries === 'object' ? summaries : {};
  const l1 = root.l1 !== null && typeof root.l1 === 'object' ? root.l1 : {};
  const l2 = root.l2 !== null && typeof root.l2 === 'object' ? root.l2 : {};
  const global = { estimated_cost: 0, estimated_inherit_cost: 0, estimated_saving: 0, priced: 0, inherit_count: 0 };
  for (const group of Object.values(l1)) {
    const c = group !== null && typeof group === 'object' ? group.cost : null;
    if (c === null || typeof c !== 'object') continue;
    if (typeof c.estimated_cost === 'number') global.estimated_cost += c.estimated_cost;
    if (typeof c.estimated_inherit_cost === 'number') global.estimated_inherit_cost += c.estimated_inherit_cost;
    if (typeof c.estimated_saving === 'number') global.estimated_saving += c.estimated_saving;
    if (typeof c.priced === 'number') global.priced += c.priced;
    if (typeof c.inherit_count === 'number') global.inherit_count += c.inherit_count;
  }
  global.estimated_cost = Number(global.estimated_cost.toFixed(4));
  global.estimated_inherit_cost = Number(global.estimated_inherit_cost.toFixed(4));
  global.estimated_saving = Number(global.estimated_saving.toFixed(4));
  global.inherit_ratio = global.priced > 0 ? Number((global.inherit_count / global.priced).toFixed(3)) : 0;
  const byModel = new Map();
  for (const [key, group] of Object.entries(l2)) {
    if (group === null || typeof group !== 'object') continue;
    const match = /:model:([^|]+)$/.exec(key);
    if (match === null) continue;
    const model = match[1];
    const cur = byModel.get(model) ?? { model, estimated_cost: 0, priced: 0, deployments: 0 };
    const c = group.cost;
    if (c !== null && typeof c === 'object') {
      if (typeof c.estimated_cost === 'number') cur.estimated_cost += c.estimated_cost;
      if (typeof c.priced === 'number') cur.priced += c.priced;
    }
    if (typeof group.deployments_total === 'number') cur.deployments += group.deployments_total;
    byModel.set(model, cur);
  }
  const modelRows = [...byModel.values()].map((m) => ({
    model: m.model,
    deployments: m.deployments,
    estimated_cost: Number(m.estimated_cost.toFixed(4)),
    priced: m.priced,
    avg_cost: m.priced > 0 ? Number((m.estimated_cost / m.priced).toFixed(4)) : null,
  })).sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return { global, byModel: modelRows };
}
