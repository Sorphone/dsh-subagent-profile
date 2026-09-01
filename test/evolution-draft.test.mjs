// test/evolution-draft.test.mjs — 进化候选生成器（evolution-draft）纯函数单测。
// 覆盖：降档（模型/结构/预设优先级 + 白名单外跳过 + 全无候选 null）、升档
// （reasoningEffort 阶梯 / maxTokens ×2 封顶 / 无预算值 null）、平→null、
// id 冲突重试与 sanitize 友好、输出过 sanitizeProfile(strict)、隐私（无原文）、
// profileFingerprint 确定性与敏感性。零 IO、零依赖注入服务。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TOKENS, sanitizeProfile } from '../lib/core/pure.mjs';
import {
  EFFORT_LADDER,
  buildEvolutionDraft,
  buildEvolutionCandidates,
  nextDraftId,
  profileFingerprint,
  sourceConfigFromKey,
} from '../lib/core/evolution-draft.mjs';

const SNAPSHOT = {
  models: [
    { provider: 'p1', id: 'deepseek-v4-pro' },
    { provider: 'p1', id: 'deepseek-v4-flash' },
    { provider: 'p1', id: 'deepseek-v4-vision' },
    { provider: 'p2', id: 'deepseek-v4-flash' },
  ],
  presets: [{ id: 'standard' }, { id: 'code' }, { id: 'minimal' }],
  tools: [],
};

const WHITELIST = new Set(['standard', 'code', 'minimal']);

function build({ profileKey, suggestion = '降', l2 = {}, snapshot = SNAPSHOT, whitelist = WHITELIST, takenIds = [] }) {
  return buildEvolutionDraft({
    advice: { profileKey, suggestion, confidence: 'medium', performanceText: '过去 3 次：完成 1、失败 2', cooldownUntil: 100 },
    l1Entry: { score: { weighted_success: 0.333 }, confidence: { n: 3, level: 'medium' } },
    l2,
    snapshot,
    whitelist,
    takenIds: takenIds instanceof Set ? takenIds : new Set(takenIds),
    now: 1000,
  });
}

function assertSanitizeClean(draft) {
  const { warnings } = sanitizeProfile({ ...draft.config, name: draft.name, description: draft.description }, { strict: true });
  assert.deepEqual(warnings, [], '输出必须过 sanitizeProfile(strict)');
}

// --- 降档：模型 ---------------------------------------------------------------

test('降档：有更低单价模型 → 同 provider 取更低档（不跨 provider、不取未定价档）', () => {
  const draft = build({ profileKey: 'preset:standard|provider:p1|model:deepseek-v4-pro' });
  assert.ok(draft, '应产出候选');
  assert.equal(draft.config.model, 'deepseek-v4-flash');
  assert.equal(draft.config.provider, 'p1');
  assert.equal(draft.config.preset, 'standard');
  assert.equal(draft.basis.profileKey, 'preset:standard|provider:p1|model:deepseek-v4-pro');
  assert.equal(draft.basis.suggestion, '降');
  assertSanitizeClean(draft);
});

test('降档：无 provider 段时从目录反查当前模型 provider', () => {
  const draft = build({ profileKey: 'model:deepseek-v4-pro' });
  assert.ok(draft, '应产出候选');
  assert.equal(draft.config.model, 'deepseek-v4-flash');
  assert.equal(draft.config.provider, 'p1');
  assertSanitizeClean(draft);
});

// --- 降档：结构移除（persona/toolFilter absent）-------------------------------

test('降档：无更低档 → 跳过模型步，persona/toolFilter 置 absent', () => {
  const draft = build({ profileKey: 'preset:standard|provider:p1|model:deepseek-v4-flash|persona:1|toolFilter:1' });
  assert.ok(draft, '应产出结构降档候选');
  assert.equal(draft.config.preset, 'standard');
  assert.equal(draft.config.model, 'deepseek-v4-flash');
  assert.ok(!('persona' in draft.config), '候选不得携带 persona');
  assert.ok(!('toolFilter' in draft.config), '候选不得携带 toolFilter');
  assertSanitizeClean(draft);
});

test('降档：仅 persona 段 → 候选为移除结构后的空能力配置', () => {
  const draft = build({ profileKey: 'persona:1' });
  assert.ok(draft, '应产出结构降档候选');
  assert.ok(!('persona' in draft.config));
  assert.ok(!('preset' in draft.config));
  assertSanitizeClean(draft);
});

// --- 降档：预设 ------------------------------------------------------------------

test('降档：无模型/结构候选 → presets 名册相邻低档（白名单内）', () => {
  const draft = build({ profileKey: 'preset:code' });
  assert.ok(draft, '应产出预设降档候选');
  assert.equal(draft.config.preset, 'standard');
  assertSanitizeClean(draft);
});

test('降档：相邻低档不在白名单 → 跳过该步，全无候选返回 null', () => {
  const roster = [{ id: 'evil' }, { id: 'standard' }];
  const snapshot = { ...SNAPSHOT, presets: roster };
  const draft = build({ profileKey: 'preset:standard', snapshot, whitelist: new Set(['standard']) });
  assert.equal(draft, null, '白名单外低档必须跳过，不产空草稿');
});

test('降档：全无候选（无更低模型/无结构/无预设）→ null', () => {
  const draft = build({ profileKey: 'model:deepseek-v4-flash|provider:p1' });
  assert.equal(draft, null);
});

// --- 升档：预算轴 ---------------------------------------------------------------

test('升档：reasoningEffort 升一级（阶梯与派发档位同源）', () => {
  const l2 = { '(inline):reasoningEffort:off': {} };
  const draft = build({ profileKey: '(inline)', suggestion: '升', l2 });
  assert.ok(draft, '应产出升档候选');
  assert.equal(draft.config.reasoningEffort, 'low');
  assert.equal(draft.basis.suggestion, '升');
  assertSanitizeClean(draft);
});

test('升档：effort 取组内阶梯最高档再升一级；maxTokens ×2', () => {
  const l2 = { '(inline):reasoningEffort:off': {}, '(inline):reasoningEffort:high': {}, '(inline):maxTokens:1000': {} };
  const effortDraft = build({ profileKey: '(inline)', suggestion: '升', l2 });
  assert.equal(effortDraft.config.reasoningEffort, 'max', 'off+high → 最高档 high → 升到 max');
  const tokensDraft = build({ profileKey: '(inline)', suggestion: '升', l2: { '(inline):maxTokens:1000': {} } });
  assert.equal(tokensDraft.config.maxTokens, 2000, 'maxTokens ×2');
});

test('升档：maxTokens ×2 封顶硬上限；已在顶档或无预算值 → null', () => {
  const capped = build({ profileKey: '(inline)', suggestion: '升', l2: { '(inline):maxTokens:40000': {} } });
  assert.equal(capped.config.maxTokens, MAX_TOKENS, '80000 封顶 65536');
  const atTop = build({ profileKey: '(inline)', suggestion: '升', l2: { ['(inline):maxTokens:' + MAX_TOKENS]: {} } });
  assert.equal(atTop, null, '已在上限 ×2 无变化 → null');
  assert.equal(build({ profileKey: '(inline)', suggestion: '升' }), null, '无具体预算值 → null');
});

// --- 平 → null -----------------------------------------------------------------

test('平 → null（维持现状不产草稿）', () => {
  assert.equal(build({ profileKey: 'preset:standard', suggestion: '平' }), null);
});

// --- id 生成 --------------------------------------------------------------------

test('id：evo-<方向>-<摘要>，冲突追加 -2/-3（≤5 次重试，仍冲突 → null）', () => {
  const key = 'preset:standard';
  assert.equal(nextDraftId('down', key, new Set()), 'evo-down-preset-standard');
  assert.equal(nextDraftId('down', key, new Set(['evo-down-preset-standard'])), 'evo-down-preset-standard-2');
  assert.equal(
    nextDraftId('down', key, new Set(['evo-down-preset-standard', 'evo-down-preset-standard-2'])),
    'evo-down-preset-standard-3'
  );
  const exhausted = new Set(['evo-down-preset-standard', 'evo-down-preset-standard-2', 'evo-down-preset-standard-3', 'evo-down-preset-standard-4', 'evo-down-preset-standard-5', 'evo-down-preset-standard-6']);
  assert.equal(nextDraftId('down', key, exhausted), null, '重试超过 5 次 → null');
});

test('id：仅小写字母/数字/连字符且 ≤32（sanitize 友好）', () => {
  const draft = build({ profileKey: 'Preset:STD|model:DeepSeek V4 Pro|persona:1' });
  assert.ok(draft, '应产出');
  assert.match(draft.config.id, /^[a-z0-9-]+$/, 'id 只允许小写字母/数字/连字符');
  assert.ok(draft.config.id.length <= 32, 'id 长度 ≤32');
});

// --- sanitize + 隐私 --------------------------------------------------------------

test('输出（合并 name/description 后）全过 sanitizeProfile(strict)', () => {
  const keys = ['preset:standard|provider:p1|model:deepseek-v4-pro', 'preset:code', 'persona:1|toolFilter:1'];
  for (const key of keys) {
    const draft = build({ profileKey: key });
    assert.ok(draft, key + ' 应产出');
    assertSanitizeClean(draft);
  }
  const up = build({ profileKey: '(inline)', suggestion: '升', l2: { '(inline):maxTokens:1000': {} } });
  assertSanitizeClean(up);
});

test('隐私：config 与 basis 不含 prompt/persona 原文', () => {
  const draft = build({ profileKey: 'persona:1' });
  const serialized = JSON.stringify({ config: draft.config, basis: draft.basis });
  assert.ok(!('persona' in draft.config), 'config 不携带 persona 字段');
  assert.ok(!('toolFilter' in draft.config), 'config 不携带 toolFilter 字段');
  assert.ok(!serialized.includes('You are'), '不落 persona 原文');
  assert.ok(!serialized.includes('prompt'), '不落 prompt 原文');
});

// --- 指纹 ------------------------------------------------------------------------

test('profileFingerprint：同输入恒同输出；任一输入变化即失配', () => {
  const base = { profileKey: 'preset:standard', from: { preset: 'standard' }, registryEntries: [{ id: 'swap-standard', preset: 'standard' }] };
  const a = profileFingerprint(base);
  assert.equal(profileFingerprint(base), a, '确定性');
  assert.notEqual(profileFingerprint({ ...base, from: { preset: 'code' } }), a, 'from 变化失配');
  assert.notEqual(profileFingerprint({ ...base, registryEntries: [] }), a, '注册表方案变化失配');
  assert.notEqual(profileFingerprint({ ...base, profileKey: 'preset:code' }), a, '身份键变化失配');
});

test('sourceConfigFromKey：能力轴来自身份键、预算轴反查 L2', () => {
  const l2 = { '(inline):maxTokens:1000': {}, '(inline):reasoningEffort:off': {} };
  assert.deepEqual(sourceConfigFromKey('(inline)', l2), { maxTokens: 1000, reasoningEffort: 'off' });
  assert.deepEqual(sourceConfigFromKey('preset:standard|persona:1', {}), { preset: 'standard', persona_present: true });
  assert.deepEqual(EFFORT_LADDER, ['off', 'low', 'medium', 'high', 'max']);
});

// --- 多候选（候选分层轮）----------------------------------------------------------

function buildMany(profileKey, extra = {}) {
  return buildEvolutionCandidates({
    advice: { profileKey, suggestion: '降', confidence: 'medium', performanceText: '过去 3 次：完成 1、失败 2', cooldownUntil: 100 },
    l1Entry: { score: { weighted_success: 0.333 }, confidence: { n: 3, level: 'medium' } },
    l2: {},
    snapshot: SNAPSHOT,
    whitelist: WHITELIST,
    takenIds: [],
    now: 1000,
    ...extra,
  });
}

test('多候选：单步在前、组合在后，保守 → 更激进排序，上限 ≤3', () => {
  const drafts = buildMany('preset:standard|provider:p1|model:deepseek-v4-pro|toolFilter:1');
  assert.equal(drafts.length, 3, '模型单步 + 结构单步 + 组合 = 3 条');
  assert.equal(drafts[0].name, '模型改 deepseek-v4-flash（保守）');
  assert.equal(drafts[0].config.model, 'deepseek-v4-flash');
  assert.equal(drafts[1].name, '移除工具过滤（均衡）');
  assert.equal(drafts[1].config.model, 'deepseek-v4-pro', '结构单步保留原模型');
  assert.equal(drafts[2].name, '模型改 deepseek-v4-flash + 移除工具过滤（更激进）');
  assert.equal(drafts[2].config.model, 'deepseek-v4-flash');
  assert.ok(!('toolFilter' in drafts[2].config), '组合候选移除工具过滤');
  // 五步可产时仍只取前 3（模型/结构/预设/两个组合 → 截断）。
  const five = buildMany('preset:code|provider:p1|model:deepseek-v4-pro|persona:1');
  assert.equal(five.length, 3, '候选上限 ≤3');
});

test('多候选：id 带 -c<N>（N=1..3），冲突追加 -2 同旧规则，sanitize 友好', () => {
  const drafts = buildMany('preset:standard|provider:p1|model:deepseek-v4-pro|toolFilter:1');
  assert.match(drafts[0].config.id, /-c1$/);
  assert.match(drafts[1].config.id, /-c2$/);
  assert.match(drafts[2].config.id, /-c3$/);
  for (const draft of drafts) {
    assert.match(draft.config.id, /^[a-z0-9-]+$/);
    assert.ok(draft.config.id.length <= 32);
    assertSanitizeClean(draft);
  }
  const taken = new Set([drafts[0].config.id]);
  const conflicted = buildMany('preset:standard|provider:p1|model:deepseek-v4-pro|toolFilter:1', { takenIds: taken });
  assert.equal(conflicted[0].config.id, drafts[0].config.id + '-2', '冲突追加 -2');
});

test('多候选：互斥快照——每条候选是完整 config，候选间互不叠加', () => {
  const drafts = buildMany('preset:standard|provider:p1|model:deepseek-v4-pro|toolFilter:1');
  const ids = new Set(drafts.map((d) => d.config.id));
  assert.equal(ids.size, drafts.length, '候选 id 互不相同');
  assert.deepEqual(drafts[1].config.preset, drafts[0].config.preset, '结构单步保留身份键内其余字段');
  assert.ok(drafts[1].config.model !== drafts[0].config.model, '单步候选之间是替代关系而非累进');
  assert.ok(drafts[2].config.toolFilter === undefined && drafts[2].config.model === drafts[0].config.model, '组合候选 = 第一条改动 + 结构移除');
});

test('跨方向禁止：降方向候选只含能力轴字段，升方向候选只含预算轴字段', () => {
  const down = buildMany('preset:standard|provider:p1|model:deepseek-v4-pro|toolFilter:1');
  for (const draft of down) {
    assert.ok(!('reasoningEffort' in draft.config), '降候选不得携带推理强度');
    assert.ok(!('maxTokens' in draft.config), '降候选不得携带 token 上限');
  }
  const up = buildEvolutionCandidates({
    advice: { profileKey: '(inline)', suggestion: '升', confidence: 'medium', performanceText: 'x' },
    l1Entry: { score: { weighted_success: 0.3 }, confidence: { n: 3, level: 'medium' } },
    l2: { '(inline):reasoningEffort:off': {}, '(inline):maxTokens:1000': {} },
    snapshot: SNAPSHOT,
    whitelist: WHITELIST,
    takenIds: [],
    now: 1000,
  });
  assert.equal(up.length, 3, '推理单步 + token 单步 + 组合');
  for (const draft of up) {
    assert.ok(!('model' in draft.config) && !('preset' in draft.config) && !('provider' in draft.config), '升候选不得携带能力轴字段');
    assertSanitizeClean(draft);
  }
  assert.equal(up[0].config.reasoningEffort, 'low');
  assert.equal(up[1].config.maxTokens, 2000);
  assert.deepEqual(up[2].config, { id: up[2].config.id, reasoningEffort: 'low', maxTokens: 2000, tokenTier: 'balanced' });
});

test('多候选：单候选时 buildEvolutionDraft 取第一条（最保守），语义兼容旧入口', () => {
  const single = buildEvolutionDraft({
    advice: { profileKey: 'persona:1', suggestion: '降', confidence: 'medium', performanceText: 'x' },
    l1Entry: { score: { weighted_success: 0.3 }, confidence: { n: 3, level: 'medium' } },
    l2: {},
    snapshot: SNAPSHOT,
    whitelist: WHITELIST,
    takenIds: [],
    now: 1000,
  });
  assert.ok(single, '旧入口仍产出');
  assert.equal(single.name, '去掉自定义人格（保守）');
  assert.match(single.config.id, /-c1$/);
  assertSanitizeClean(single);
});

