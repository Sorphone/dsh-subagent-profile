// test/harness/ctx.mjs — characterization 快照共享的假 Cordis 上下文。
// 见 test/README.md。
//
// 本 fake 的范围：只 mock index.mjs 顶层 `apply(ctx)` 契约触达的表面——
// `inject` / `get` / `provide` / `effect` / `logger` /
// `subagents.registerProvider` / `tools.register` / `tools.schemas` /
// `webServer` 提供的 scope / `systemPrompt.section|context`。刻意不提供可用的
// `agents.create`（不能 mock 它；characterization 测试断言 apply() 从不触碰它）。
// provider.start / dispatch execute / HTTP 处理器不被 apply() 调用，故本 fake
// 不建模它们；它们明确在快照范围之外，并被断言为保持未测（见 test/README.md）。
//
// 是 characterization 而非仿真：这是当前可观察 apply 时接线的快照，不是完整
// harness。宿主升级后若某服务签名变化（如 webServer.register 或 tools.register
// 参数形状），必须对照新签名重新核验本 fake。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- DSH_HOME 隔离 ------------------------------------------------------------
// index.mjs 的 `dshHome()` 在调用时（apply() 内）读 `process.env.DSH_HOME`。
// 在 apply() **之前**把它设为全新临时目录，preset 自安装与 profile 加载就绝不
// 触碰真实 ~/.dsh。这是快照测试的前置条件——见 README。
function makeIsolatedDshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-subagent-profile-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return {
    dir,
    previous,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    },
    teardown() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

// fake 注册返回的 disposable。必须是可调用函数且容忍被调用（apply() 存它、
// 可能闭包持有；快照里不要求它做任何事）。
function makeDisposer() {
  return function disposer() {};
}

// 构造假 Cordis 上下文。`options.services` 覆盖/播种 `ctx.get(name)` 读回、
// `ctx.inject(deps, fn)` 消费的服务表。`webServer` 与 `systemPrompt` 默认提供，
// 开箱的 apply() 会注册设置路由与 systemPrompt sections；覆盖它们可走可选分支
// （如无 systemPrompt => 无 sections）。`options.toolSchemas` 覆盖
// `ctx.tools.schemas()` 返回的数组（缺省 `[{ name: 'dispatch' }]`——可派发的
// agent，默认 characterization 快照里提示门通过）。传 `[]` 模拟不可派发的
// agent。`options.subagentsStart` 覆盖 `ctx.subagents.start`
// （recycle/execute 测试用的假父 Agent 驱动）。
function createFakeCtx(options = {}) {
  const services = { ...(options.services ?? {}) };
  const toolSchemas = options.toolSchemas ?? [{ name: 'dispatch' }];
  const subagentsStart = options.subagentsStart ?? (() => {
    throw new Error('ctx.subagents.start is not available in the characterization fake');
  });
  const startContinuable = options.startContinuable ?? (() => {
    throw new Error('ctx.subagents.startContinuable is not available in the characterization fake');
  });
  const records = {
    logs: { info: [], warn: [], error: [] },
    effects: [],
    injects: [],
    provides: [],
    registerProviderCalls: [],
    registerToolCalls: [],
    webServerRegisterCalls: [],
    sectionCalls: [],
    contextCalls: [],
    schemaCalls: [],
    agentCreateCalls: 0,
    ons: [],
  };

  const logger = {
    info: (...args) => records.logs.info.push(args),
    warn: (...args) => records.logs.warn.push(args),
    error: (...args) => records.logs.error.push(args),
  };

  // Cordis `effect(fn)` 立即运行设置 `fn` 并保留它返回的 disposer；现在运行它
  // 正是让设置路由 effect 里的 webServer.register 调用在 apply() 期间真正触发。
  const runEffect = (fn, label) => {
    const disposer = fn();
    records.effects.push({ label, fn, disposer });
    return disposer;
  };

  const makeScope = (deps) => {
    const scope = {
      effect: runEffect,
      get: (name) => services[name],
      provide: (name, service) => records.provides.push({ name, service }),
      logger,
    };
    for (const dep of deps) scope[dep] = services[dep];
    return scope;
  };

  // webServer 服务（bundle 里可选；fake 默认提供，设置路由 inject scope 有东西
  // 可调）。传 `{ webServer: undefined }` 走 missing-webServer 分支（inject scope
  // 推迟，路由永不注册）。
  const webServer = 'webServer' in services
    ? services.webServer
    : {
        register(config) {
          records.webServerRegisterCalls.push(config);
          return makeDisposer();
        }
      };
  services.webServer = webServer;

  // systemPrompt 服务（bundle 里可选；fake 默认提供，apply() 注册快照断言的
  // 两个 systemPrompt sections）。传 `{ systemPrompt: undefined }` 走
  // no-systemPrompt 分支。
  const systemPrompt = 'systemPrompt' in services
    ? services.systemPrompt
    : {
        section(config) { records.sectionCalls.push(config); },
        context(config) { records.contextCalls.push(config); }
      };
  services.systemPrompt = systemPrompt;

  const ctx = {
    get(name) { return services[name]; },
    provide(name, service) { records.provides.push({ name, service }); },
    inject(deps, fn) {
      const scope = makeScope(deps);
      records.injects.push({ deps, fn, scope });
      // 对齐 Cordis：仅当请求的每个服务都在场时才运行回调。缺失服务
      // （如未提供 webServer）永远推迟——正是 apply() 期望的：设置路由注册是
      // 可选的。快照里 webServer 恒在场，故 fn 会运行。
      if (deps.every((dep) => services[dep] !== undefined)) fn(scope);
      return scope;
    },
    effect: runEffect,
    logger,
    // 事件总线最小 fake：on 登记回调、off 移除；apply 的 agent/disposed 挂钩
    // （registerTeardown）经此登记，测试可手动触发 records.ons 中的回调。
    on(name, callback) {
      records.ons.push({ name, callback });
      return () => {
        const index = records.ons.findIndex((entry) => entry.callback === callback);
        if (index >= 0) records.ons.splice(index, 1);
      };
    },
    off(name, callback) {
      const index = records.ons.findIndex((entry) => entry.name === name && entry.callback === callback);
      if (index >= 0) records.ons.splice(index, 1);
    },
    subagents: {
      registerProvider(provider) { records.registerProviderCalls.push(provider); return makeDisposer(); },
      start: subagentsStart,
      startContinuable,
    },
    tools: {
      register(tool) { records.registerToolCalls.push(tool); return makeDisposer(); },
      schemas(...args) { records.schemaCalls.push(args); return toolSchemas; },
      restrict() { throw new Error('ctx.tools.restrict is not available in the characterization fake'); }
    },
    agents: {
      // 未实现。只作绊线：apply() 若在顶层到达它，这里响亮地抛错并递增
      // 计数器，characterization 测试断言它保持 0。
      create() { records.agentCreateCalls += 1; throw new Error('ctx.agents.create is not implemented in the characterization fake — apply() must not reach it'); }
    }
  };

  return { ctx, records };
}

export { createFakeCtx, makeIsolatedDshHome };
