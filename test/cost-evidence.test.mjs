// test/cost-evidence.test.mjs — 省 token 证据（Task 38b/38c）。
// 纯函数：prices 单价表 + counterfactualFor + summarizeCosts。已知 usage × 单价
// 断言 cost/saving 与聚合；未指定 model saving=0 + inherit 标；mixed records 断言
// 继承占比。不依赖 index.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avgCostFor, priceKeyFor, MODEL_AVG_COST } from '../lib/core/prices.mjs';
import { dispatchCost, counterfactualFor, summarizeCosts } from '../lib/core/cost-evidence.mjs';

test('prices：A 级单价表与别名归一（flash/pro）', () => {
  assert.equal(avgCostFor('deepseek-v4-flash'), 0.0039);
  assert.equal(avgCostFor('deepseek-v4-pro'), 0.0104);
  assert.equal(priceKeyFor('some-flash-7b'), 'deepseek-v4-flash');
  assert.equal(priceKeyFor('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(priceKeyFor('unknown'), undefined);
  assert.equal(avgCostFor('unknown'), undefined);
  assert.ok(Object.keys(MODEL_AVG_COST).includes('deepseek-v4-flash'));
});

test('dispatchCost：B 级五段价格缺数据时回退 A 级单次均价', () => {
  assert.equal(dispatchCost({ model: 'deepseek-v4-flash' }), 0.0039);
  assert.equal(dispatchCost({ model: 'deepseek-v4-pro', usage: {} }), 0.0104);
  assert.equal(dispatchCost({ model: 'unknown' }), undefined);
});

test('counterfactualFor：显式 model=flash 且父 pro → saving=pro−flash', () => {
  const record = {
    requested: { model: 'deepseek-v4-flash' },
    parent_model: 'deepseek-v4-pro',
    outcome: { usage: { inputTokens: 100, outputTokens: 50 } },
  };
  const c = counterfactualFor(record);
  assert.equal(c.inherit, false);
  assert.equal(c.actual, 0.0039);
  assert.equal(c.counterfactual, 0.0104);
  assert.equal(c.saving, 0.0065);
  assert.equal(c.ratio, 2.67);
});

test('counterfactualFor：未指定 model（继承父）→ saving=0 且 inherit=true', () => {
  const record = {
    requested: {},
    parent_model: 'deepseek-v4-pro',
    outcome: { usage: { inputTokens: 100 } },
  };
  const c = counterfactualFor(record);
  assert.equal(c.inherit, true);
  assert.equal(c.model, 'deepseek-v4-pro');
  assert.equal(c.actual, 0.0104);
  assert.equal(c.saving, 0);
  assert.equal(c.ratio, null);
});

test('counterfactualFor：父模型无价格 → 显式模型记录返回 undefined（fail-soft）', () => {
  const record = { requested: { model: 'deepseek-v4-flash' }, parent_model: null, outcome: {} };
  assert.equal(counterfactualFor(record), undefined);
});

test('summarizeCosts：聚合估算成本/继承占比（mixed records）', () => {
  const records = [
    { requested: { model: 'deepseek-v4-flash' }, parent_model: 'deepseek-v4-pro', outcome: {} },
    { requested: {}, parent_model: 'deepseek-v4-pro', outcome: {} },
    { requested: { model: 'deepseek-v4-pro' }, parent_model: 'deepseek-v4-pro', outcome: {} },
  ];
  const s = summarizeCosts(records);
  assert.equal(s.priced, 3);
  assert.equal(s.estimated_cost, 0.0247);
  assert.equal(s.estimated_inherit_cost, 0.0312);
  assert.equal(s.estimated_saving, 0.0065);
  assert.equal(s.inherit_count, 1);
  assert.equal(s.inherit_ratio, 0.333);
});
