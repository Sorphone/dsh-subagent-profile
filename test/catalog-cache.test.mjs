// test/catalog-cache.test.mjs — catalog 快照缓存：
//   * TTL 过期重拉（注入 clock 推进时间，断言 listProviders 重拉）；
//   * 并发 cache-miss 在途去重（只拉一次目录）；
//   * 快照共享断言（/options 侧 getSnapshot() 与 cost guard 侧 getSnapshot(llm)
//     同一 llm 实例命中同一份快照）；
//   * invalidate 手动清缓存立即重拉；hit/miss 计数（stats）。
// mock getLlm/getAgentPresets（不经过 apply，直接测 catalog-cache 模块）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache, getCatalogSnapshot } from '../lib/core/catalog-cache.mjs';

// 最小 fake llm：按 providerId 返回 model 目录，并计数 listProviders/listModels。
function makeLlm(modelsPerProvider = {}) {
  const calls = { listProviders: 0, listModels: 0 };
  const llm = {
    async listProviders() {
      calls.listProviders += 1;
      return Object.keys(modelsPerProvider).map((id) => ({ id, name: id }));
    },
    async listModels(providerId) {
      calls.listModels += 1;
      return modelsPerProvider[providerId] ?? [];
    },
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'high', name: '高' }] } };
    },
  };
  return { llm, calls };
}

test('getCatalogSnapshot: 一次拉取 providers/models/efforts/presets/tools', async () => {
  const { llm } = makeLlm({ p1: [{ id: 'm1', name: '模型1' }] });
  const agentPresets = {
    list: async () => [
      { id: 'standard', name: '标准', trust: 'system' },
      { id: 'user', name: '用户', trust: 'user' },
    ],
  };
  const snapshot = await getCatalogSnapshot({
    getLlm: () => llm,
    getAgentPresets: () => agentPresets,
    getTools: () => undefined,
  });
  assert.equal(snapshot.llm.providers.length, 1);
  assert.equal(snapshot.llm.providers[0].id, 'p1');
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].id, 'm1');
  assert.equal(snapshot.models[0].provider, 'p1');
  assert.deepEqual(snapshot.presets, [{ id: 'standard', name: '标准' }], '仅 system-trust 预设入列');
  assert.equal(snapshot.efforts['m1'][0].id, 'high');
  assert.deepEqual(snapshot.tools, []);
});

test('catalog cache: TTL 内命中同一份快照，过期后重拉新目录', async () => {
  const { llm, calls } = makeLlm({ p1: [{ id: 'm1', name: '模型1' }] });
  let nowValue = 0;
  const cache = createCatalogCache({
    getLlm: () => llm,
    getAgentPresets: () => undefined,
    ttlMs: 100,
    now: () => nowValue,
  });
  const first = await cache.getSnapshot();
  assert.equal(calls.listProviders, 1, '首次 cache-miss 拉一次目录');
  const second = await cache.getSnapshot();
  assert.equal(calls.listProviders, 1, 'TTL 内命中缓存，不重拉');
  assert.strictEqual(second, first, 'TTL 内命中同一份快照对象');
  nowValue = 200; // 推进时钟越过 TTL
  const third = await cache.getSnapshot();
  assert.equal(calls.listProviders, 2, 'TTL 过期后重拉目录');
  assert.notStrictEqual(third, first, '过期后返回新快照');
});

test('catalog cache: 并发 cache-miss 复用同一条在途 Promise', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = { listProviders: 0 };
  const llm = {
    async listProviders() {
      calls.listProviders += 1;
      await gate;
      return [{ id: 'p1' }];
    },
    async listModels() { return []; },
  };
  const cache = createCatalogCache({
    getLlm: () => llm,
    getAgentPresets: () => undefined,
    ttlMs: 100,
    now: () => 0,
  });
  const p1 = cache.getSnapshot();
  const p2 = cache.getSnapshot();
  const p3 = cache.getSnapshot();
  release();
  const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
  assert.equal(calls.listProviders, 1, '并发在途只拉一次目录');
  assert.strictEqual(s1, s2);
  assert.strictEqual(s2, s3);
});

test('catalog cache: 同一 llm 实例经 getSnapshot() 与 getSnapshot(llm) 命中同一份快照', async () => {
  const { llm, calls } = makeLlm({ p1: [{ id: 'm1', name: '模型1' }] });
  const cache = createCatalogCache({
    getLlm: () => llm,
    getAgentPresets: () => undefined,
    ttlMs: 100000,
    now: () => 0,
  });
  const viaOptions = await cache.getSnapshot();    // /options 侧：无参走注入 getLlm()
  const viaGuard = await cache.getSnapshot(llm);   // cost guard 侧：传父 Agent 的 llm 实例
  assert.equal(calls.listProviders, 1, '同一实例只拉一次目录');
  assert.strictEqual(viaOptions, viaGuard, '同一 llm 实例命中同一份快照');
});

test('catalog cache: invalidate 清缓存后立即重拉', async () => {
  const { llm, calls } = makeLlm({ p1: [{ id: 'm1', name: '模型1' }] });
  const cache = createCatalogCache({
    getLlm: () => llm,
    getAgentPresets: () => undefined,
    ttlMs: 100000,
    now: () => 0,
  });
  await cache.getSnapshot();
  assert.equal(calls.listProviders, 1);
  cache.invalidate();
  await cache.getSnapshot();
  assert.equal(calls.listProviders, 2, 'invalidate 后立即重拉');
});

test('catalog cache: hit/miss 计数经 stats 暴露', async () => {
  const { llm } = makeLlm({ p1: [{ id: 'm1' }] });
  const cache = createCatalogCache({
    getLlm: () => llm,
    getAgentPresets: () => undefined,
    ttlMs: 100000,
    now: () => 0,
  });
  await cache.getSnapshot();
  await cache.getSnapshot();
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1 });
});

test('catalog cache: getter 抛错 → 不缓存且重抛', async () => {
  let boom = false;
  const cache = createCatalogCache({
    getLlm: () => {
      if (boom) throw new Error('getter 爆炸');
      return undefined;
    },
    getAgentPresets: () => undefined,
    ttlMs: 100000,
    now: () => 0,
  });
  await cache.getSnapshot(); // 正常一次
  boom = true;
  await assert.rejects(() => cache.getSnapshot(), /getter 爆炸/, 'getter 抛错必须重抛');
  boom = false;
  const after = await cache.getSnapshot();
  assert.notEqual(after, undefined, '失败不残留缓存条目，后续请求正常');
});

test('catalog cache: 目录错误态（providersError）不缓存，下次重试自愈', async () => {
  const calls = { listProviders: 0 };
  let failNext = true;
  const llm = {
    async listProviders() {
      calls.listProviders += 1;
      if (failNext) throw new Error('瞬时故障');
      return [{ id: 'p1' }];
    },
    async listModels() { return []; },
  };
  const cache = createCatalogCache({
    getLlm: () => llm,
    getAgentPresets: () => undefined,
    ttlMs: 100000,
    now: () => 0,
  });
  const degraded = await cache.getSnapshot();
  assert.notEqual(degraded.llm.providersError, undefined, '首次返回目录错误态快照');
  failNext = false;
  const recovered = await cache.getSnapshot();
  assert.equal(calls.listProviders, 2, '错误态不缓存，第二次即重试');
  assert.equal(recovered.llm.providersError, undefined, '第二次拿到正常目录');
  assert.equal(recovered.llm.providers.length, 1);
});
