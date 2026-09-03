// test/official-api-guard.test.mjs — 官方 API 存在性护栏（2026-09-03 建立）。
//
// 目的：插件依赖官方 @deepseek-ai/* 包的导出面——
//   * shims.mjs 静态 import（守卫型）：assertSubagentMaxDepth / resolveChildDepth；
//   * shims.mjs 动态 loadSoft（函数映射型，有本地回退）：resolveChildAgentOptions；
//   * profile-provider.mjs 续聊：child.followup(createUserMessage(...))，其中
//     child = handle.agent（官方 Agent 公共契约），createUserMessage 取自
//     @deepseek-ai/dsh-llm。
// 官方 alpha.4/rc.1 持续演进（Session.events → seq/eventAt/snapshotEvents、
// report → send_message），本文件锁定当前依赖符号的存在性：官方再拆/改名 API
// 时这些断言会红，必须先评估插件影响面再升依赖版本。只断言官方包导出面，
// 不测插件本地 shims（本地回退路径由 facade / degradation 测试覆盖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

test('官方 @deepseek-ai/dsh-subagent 导出 resolveChildAgentOptions / assertSubagentMaxDepth / resolveChildDepth', async () => {
  const mod = await import('@deepseek-ai/dsh-subagent');
  for (const name of ['resolveChildAgentOptions', 'assertSubagentMaxDepth', 'resolveChildDepth']) {
    assert.equal(typeof mod[name], 'function', `@deepseek-ai/dsh-subagent 必须导出 ${name}（2026-09-03 护栏：官方拆 API 时此测试红）`);
  }
});

test('官方 @deepseek-ai/dsh-llm 导出 createUserMessage（续聊用户消息构造依赖）', async () => {
  const mod = await import('@deepseek-ai/dsh-llm');
  assert.equal(typeof mod.createUserMessage, 'function', '@deepseek-ai/dsh-llm 必须导出 createUserMessage（2026-09-03 护栏）');
});

test('官方续聊面：SubagentRuntime.prototype.followup 存在（官方 send_message 传递通道）', async () => {
  const { SubagentRuntime } = await import('@deepseek-ai/dsh-subagent');
  assert.equal(typeof SubagentRuntime, 'function', '@deepseek-ai/dsh-subagent 必须导出 SubagentRuntime');
  assert.equal(typeof SubagentRuntime.prototype.followup, 'function', 'SubagentRuntime.prototype.followup 必须存在（2026-09-03 护栏）');
});

test('官方子代理句柄契约：Agent 公共类型声明 followup（插件 child.followup 调用面）', () => {
  const pkgJson = require.resolve('@deepseek-ai/dsh-agent/package.json');
  const dtsPath = join(dirname(pkgJson), 'lib/types/runtime-types.d.ts');
  const dts = readFileSync(dtsPath, 'utf8');
  assert.match(dts, /followup\(message: UserMessage\): void;/, '官方 Agent 公共契约必须保留 followup(message)（2026-09-03 护栏）');
});
