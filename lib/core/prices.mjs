// lib/core/prices.mjs — 模型单价表（纯数据）。
// 来源：docs/measured-params.md / docs/cost-closed-loop-design.md（2026-08-24 实测）。
// 口径：估算、非精确计费；A 级为「单次均价」、B 级为「五段单价」（元/千 token）。
// 可被 A″ / F 数据层复用（同源同表，不散落魔法数）。

// A 级：模型 → 单次均价（元/次）。同规模派发实测：flash 0.0039、继承父（pro）0.0104。
export const MODEL_AVG_COST = Object.freeze({
  'deepseek-v4-flash': 0.0039,
  'deepseek-v4-pro': 0.0104,
});

// B 级：模型 → 五段单价（元/千 token）。当前仅有单次均价实测，五段单价先按
// 均价占位（input/output 同价），保留键结构供未来实测回填；cache 段缺数据记 null。
export const MODEL_USAGE_PRICES = Object.freeze({
  'deepseek-v4-flash': Object.freeze({
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    avgCost: MODEL_AVG_COST['deepseek-v4-flash'],
  }),
  'deepseek-v4-pro': Object.freeze({
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    avgCost: MODEL_AVG_COST['deepseek-v4-pro'],
  }),
});

// 模型名归一：常见别名/前缀统一到价格键；未知返回 undefined（fail-soft 不猜价）。
export function priceKeyFor(model) {
  if (typeof model !== 'string' || model === '') return undefined;
  const m = model.trim().toLowerCase();
  if (MODEL_AVG_COST[m] !== undefined) return m;
  if (m.includes('flash')) return 'deepseek-v4-flash';
  if (m.includes('pro')) return 'deepseek-v4-pro';
  return undefined;
}

export function avgCostFor(model) {
  const key = priceKeyFor(model);
  return key === undefined ? undefined : MODEL_AVG_COST[key];
}
