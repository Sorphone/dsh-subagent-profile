// test/official-visibility-line.test.mjs — 官方模型选择可见性行（dispatch:profiles
// 静态段 note 追加）：投影存在（已启用）→ 允许清单同源 readModelSelectionPolicy；
// 投影缺失（未启用）→ 无官方发现工具 + profiles_query 授权路由引导；畸形投影
// fail-soft（debug 日志 + 未启用文案）；目录文本为空不追加；orchestrator:mode
// 分工句「官方工具没出现=模型选择未启用」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendOfficialVisibilityLine, officialModelSelectionLine } from '../lib/core/model-policy.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

const POLICY_KEY = 'subagentModelSelectionPolicy';

function makeCtx(projectionValue) {
  const services = {};
  if (projectionValue !== undefined) {
    services.sessionProjections = {
      stateOf: (session, key) => {
        assert.equal(key, POLICY_KEY, '必须读取官方投影 key');
        return projectionValue;
      },
    };
  }
  const fake = createFakeCtx({ services });
  return { ctx: fake.ctx, records: fake.records };
}

test('未启用：投影缺失 → 未启用文案 + profiles_query 授权路由引导', () => {
  const { ctx } = makeCtx(undefined);
  const line = officialModelSelectionLine(ctx, { agent: { session: { header: { id: 's1' } } } });
  assert.match(line, /未启用/);
  assert.match(line, /无官方发现工具/);
  assert.match(line, /profiles_query 查看在册状态/);
});

test('已启用：投影存在 → 允许清单同源展示（provider/model 成对）', () => {
  const { ctx } = makeCtx([{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }]);
  const line = officialModelSelectionLine(ctx, { agent: { session: { header: { id: 's1' } } } });
  assert.equal(line, '官方子代理模型选择：已启用（允许：p1/m1、p2/m2）');
});

test('fail-soft：畸形投影（空数组 shape 校验 throw）→ debug 日志 + 未启用文案', () => {
  const { ctx } = makeCtx([]);
  const debugs = [];
  const line = officialModelSelectionLine(ctx, { agent: { session: { header: { id: 's1' } } } }, { debug: (m) => debugs.push(m) });
  assert.match(line, /未启用/, '畸形投影不得抛向上，按未启用展示');
  assert.equal(debugs.length, 1, '读取异常必须 debug 留痕');
});

test('包装：目录文本为空不追加；非空追加单行（含换行衔接）', () => {
  const { ctx } = makeCtx(undefined);
  assert.equal(appendOfficialVisibilityLine('', ctx, { agent: {} }), '');
  const out = appendOfficialVisibilityLine('Available dispatch profiles (dispatch.profile):\n- x: "d"', ctx, { agent: {} });
  assert.ok(out.startsWith('Available dispatch profiles'), '基础目录文本保留');
  assert.match(out, /\n官方子代理模型选择：/);
});

test('apply 集成：dispatch:profiles 段带可见性行；orchestrator:mode 带分工句', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx({ services: { agentPresets: { composedPreset: () => 'orchestrator-v2' } } });
    await mod.apply(ctx);
    const profiles = records.sectionCalls.find((s) => s.name === 'dispatch:profiles');
    const text = profiles.text({ agent: {} });
    assert.match(text, /官方子代理模型选择：未启用/, '无投影 → 未启用行');
    const orchestrator = records.sectionCalls.find((s) => s.name === 'orchestrator:mode');
    assert.ok(orchestrator.text({ agent: {} }).includes('官方工具没出现=模型选择未启用'), '分工句补进编排者模式文案');
  } finally { iso.restore(); iso.teardown(); }
});
