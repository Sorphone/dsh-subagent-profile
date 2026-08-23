// test/trust-label.test.mjs — 输出回灌信任标注：completed 子结果进父上下文前加
// 结构化前缀 `[dispatch:trusted-output] profile=<profile> preset=<preset>`，避免父
// 模型把子 Agent 输出误当高信任指令。
// 覆盖：
//   * trustLabel / trustAudit 纯函数：字段缺失省略段（preset 继承父省略 preset 段）、
//     无 prompt/persona 原文、审计 JSON 只含 profile/preset。
//   * 前台（execute completed）output 以标注前缀开头；审计只进 logger、不进结果字符串。
//   * 后台（settleStart completed）output 以标注前缀开头（有 logger 时审计；无 logger 不抛）。
//   * render 行首部格式不变（仍 `[dispatch]` 开头），前缀只进 output 文本内部。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustLabel, trustAudit } from '../lib/core/pure.mjs';
import { settleStart } from '../lib/core/delegation.mjs';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';

const mod = await import('../index.mjs');

// ---- trustLabel 纯函数 ---------------------------------------------------------

test('trustLabel：profile + preset 均在场 → 完整前缀', () => {
  assert.equal(
    trustLabel({ profile: 'researcher', preset: 'standard' }),
    '[dispatch:trusted-output] profile=researcher preset=standard'
  );
});

test('trustLabel：preset=inherit（子继承父预设）→ 省略 preset 段', () => {
  assert.equal(
    trustLabel({ profile: '(inline)', preset: 'inherit' }),
    '[dispatch:trusted-output] profile=(inline)'
  );
});

test('trustLabel：preset 缺失 → 省略 preset 段；profile 缺失 → 省略 profile 段', () => {
  assert.equal(trustLabel({ profile: 'x' }), '[dispatch:trusted-output] profile=x');
  assert.equal(trustLabel({ preset: 'swap' }), '[dispatch:trusted-output] preset=swap');
  assert.equal(trustLabel({}), '[dispatch:trusted-output]');
  assert.equal(trustLabel(undefined), '[dispatch:trusted-output]');
  assert.equal(trustLabel(null), '[dispatch:trusted-output]');
});

test('trustLabel：不含 prompt / persona 原文（只含两个元数据标识符）', () => {
  const label = trustLabel({
    profile: 'p',
    preset: 's',
    prompt: 'SECRET-PROMPT-TEXT',
    persona: 'SECRET-PERSONA-TEXT',
  });
  assert.equal(label, '[dispatch:trusted-output] profile=p preset=s');
  assert.doesNotMatch(label, /SECRET/);
  assert.doesNotMatch(label, /prompt|persona/);
});

// ---- trustAudit 纯函数（审计只进 logger 的结构化 JSON） ------------------------

test('trustAudit：与 trustLabel 同字段集 JSON，无输出原文', () => {
  assert.equal(trustAudit({ profile: 'researcher', preset: 'standard' }), '{"profile":"researcher","preset":"standard"}');
  assert.equal(trustAudit({ profile: 'x', preset: 'inherit' }), '{"profile":"x"}');
  assert.equal(trustAudit({}), '{}');
});

// ---- 前台（execute completed）：output 以标注前缀开头 + 审计只进 logger ----------

function makeForegroundParent() {
  return { ctx: { get: () => undefined }, options: {} };
}

test('前台 completed → output 以标注前缀开头；审计只进 logger、不进结果字符串', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const subagentsStart = async () => ({
      result: { stopReason: 'completed', output: [{ type: 'text', text: 'hello-world' }] },
      localAgent: { session: { events: [] } },
      dispose: async () => {},
    });
    const { ctx, records } = createFakeCtx({ subagentsStart });
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const out = await tool.execute({ prompt: 'task' }, { agent: makeForegroundParent(), signal: undefined });
    // 前台 inline 派发：profile=(inline)、preset=inherit（省略 preset 段）。
    assert.ok(out.output.startsWith('[dispatch:trusted-output] profile=(inline)'), 'output 必须以标注前缀开头');
    assert.ok(out.output.endsWith('hello-world'), '子输出文本必须紧接前缀之后');
    // 审计进 logger：info 里有一条 `[dsh-subagent-profile] trusted-output: ` 记录。
    const auditLines = records.logs.info.filter((args) =>
      args.length > 0 && typeof args[0] === 'string' && args[0].startsWith('[dsh-subagent-profile] trusted-output: ')
    );
    assert.equal(auditLines.length, 1, 'completed 前台结算必须记一条审计');
    // 审计是结构化 JSON（preset=inherit 省略 preset 段），且绝不含子输出原文。
    const auditJson = auditLines[0][0].slice('[dsh-subagent-profile] trusted-output: '.length);
    assert.deepEqual(JSON.parse(auditJson), { profile: '(inline)' }, '审计 JSON 只含 profile（preset=inherit 省略）');
    assert.doesNotMatch(auditJson, /hello-world/, '审计 JSON 不含子输出原文');
    // 结果字符串不含审计字段（标注前缀本身即标注面，审计 JSON 只进 logger）。
    assert.doesNotMatch(out.output, /"profile"|"preset"/, '结果字符串不含审计 JSON 字段');
  } finally { iso.restore(); iso.teardown(); }
});

test('render 行：仍以 [dispatch] 开头，信任前缀在 output 文本内部', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { ctx, records } = createFakeCtx();
    await mod.apply(ctx);
    const tool = records.registerToolCalls.find((t) => t.name === 'dispatch');
    const value = {
      output: '[dispatch:trusted-output] profile=p preset=s child-text',
      profile: 'p',
      preset: 's',
      provider: 'pr',
      model: 'm',
      reasoningEffort: 'off',
      tokenTier: 'cheap',
      ignored: [],
    };
    const [block] = tool.output.render({}, value);
    assert.ok(block.text.startsWith('[dispatch]'), 'render 行首部格式不变');
    assert.ok(
      block.text.includes('\n\n[dispatch:trusted-output] profile=p preset=s child-text'),
      '信任前缀必须在 output 文本内部（正文带头）'
    );
  } finally { iso.restore(); iso.teardown(); }
});

// ---- 后台（settleStart completed）：output 以标注前缀开头 + 审计只进 logger -------

test('settleStart completed → output 以标注前缀开头；审计只进 logger', async () => {
  const start = async () => ({
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'bg-result' }] },
    localAgent: { session: { events: [] } },
    dispose: async () => {},
  });
  const logLines = [];
  const logger = { info: (...args) => logLines.push(args) };
  const out = await settleStart(start(), { aborted: false }, { profile: 'p', preset: 'swap' }, (b) => b, () => undefined, Date.now(), logger);
  assert.equal(out.status, 'completed');
  assert.ok(out.output.startsWith('[dispatch:trusted-output] profile=p preset=swap'), 'output 必须以标注前缀开头');
  assert.ok(out.output.endsWith('bg-result'), '子输出文本必须紧接前缀之后');
  assert.equal(logLines.length, 1, 'completed 后台结算必须记一条审计');
  assert.ok(logLines[0][0].startsWith('[dsh-subagent-profile] trusted-output: '), '审计前缀正确');
  assert.doesNotMatch(out.output, /"profile"|"preset"/, '结果字符串不含审计 JSON 字段');
});

test('settleStart completed + 无 logger → 不抛错、output 仍带前缀', async () => {
  const start = async () => ({
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'bg-no-logger' }] },
    localAgent: { session: { events: [] } },
    dispose: async () => {},
  });
  const out = await settleStart(start(), { aborted: false }, { profile: 'x' }, (b) => b, () => undefined);
  assert.equal(out.status, 'completed');
  assert.ok(out.output.startsWith('[dispatch:trusted-output] profile=x'), '无 logger 时仍加前缀、不抛错');
});
