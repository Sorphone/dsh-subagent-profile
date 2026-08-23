// index.mjs — dsh-subagent-profile 宿主侧正式插件 bundle（只做装配）。
// 源自原型动态插件 `code.host` 主体；宿主导入面（registerTool/defineTool/
// handle）收敛在 lib/core/shims.mjs，装配块按模块拆分驻留 lib/core/（catalog /
// presets-sync / profiles-store / cost-guard / whitelist / intersection /
// delegation / pure / shims / http-routes / profile-provider / dispatch-tool /
// dispatch-guard）。
// apply 的装配辅助函数（syncBundledPresetsToHome / provideProfileService /
// registerSystemPromptSections / registerSettingsRoutes）保持 section 文本与
// 门控逐字不变；`enabled` 始终经 getter 注入，门控读取当前值。

import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { syncBundledPresets } from './lib/core/presets-sync.mjs';
import { dshHome, createProfileStore } from './lib/core/profiles-store.mjs';
import { createHttpRoutes } from './lib/core/http-routes.mjs';
import { createProfileProvider } from './lib/core/profile-provider.mjs';
import { createDispatchTool } from './lib/core/dispatch-tool.mjs';
import { createDispatchGuard } from './lib/core/dispatch-guard.mjs';
import { createCatalogCache } from './lib/core/catalog-cache.mjs';
import { createFailureLedger } from './lib/core/decision-trace.mjs';
import { createEvolutionLedger } from './lib/core/evolution-ledger.mjs';
import { tierSortKey } from './lib/core/pure.mjs';

export const name = 'dsh-subagent-profile';
export const inject = ['subagents', 'tools', 'agents'];

// Self-install the bundled "orchestrator" agent preset into the DSH
// agent-presets root so the mode appears in the new-session picker without
// manual copying (mirrors the shipped dsh-liangshen self-install). Idempotent:
// byte-identical trees are skipped; a bundle change rewrites the preset — the
// intended upgrade path. Fail-soft: the dispatch tool and settings page keep
// working even if the write is denied.
function syncBundledPresetsToHome(ctx) {
  try {
    const presetRoot = join(dshHome(), '.agent-presets');
    const sync = syncBundledPresets(presetRoot);
    for (const { id, error } of sync.failed) ctx.logger.warn(`[dsh-subagent-profile] preset ${id} sync failed: ${error}`);
    if (sync.synced.length > 0) ctx.logger.info(`[dsh-subagent-profile] presets synced into ${presetRoot}: ${sync.synced.join(', ')}`);
    if (sync.userModified.length > 0) ctx.logger.warn(`[dsh-subagent-profile] presets left untouched (user-modified): ${sync.userModified.join(', ')}`);
  } catch (error) {
    ctx.logger.warn('[dsh-subagent-profile] preset sync failed:', error instanceof Error ? error.message : String(error));
  }
}

// 卸载清理：删除本插件持久化的 3 个数据文件 + 自装的 orchestrator 预设目录（只删
// 本插件拥有的 orchestrator 目录，不碰 .agent-presets 下其它插件/用户的目录）。复活
// 口径：重新安装/启动插件会经 syncBundledPresetsToHome 重新同步预设，数据文件重新
// 生成。fail-soft：删失败不抛（卸载不应因清理失败而阻断）。
function removeOwnedData(home) {
  for (const file of ['subagent-profiles.json', 'subagent-profiles.state.json', 'subagent-profiles.failed-traces.json']) {
    try { rmSync(join(home, file), { force: true }); } catch { /* best effort */ }
  }
  try { rmSync(join(home, '.agent-presets', 'orchestrator'), { recursive: true, force: true }); } catch { /* best effort */ }
}

// 卸载接线：注销 dispatch 工具（若仍注册）+ 清空失败台账 + 级联取消在途派发 +
// 清空守卫记账 + 删本插件数据文件与自装预设目录。另挂钩宿主 agent/disposed
// （Agent 注册 fiber 卸载时发射）：父会话逻辑结束时按父释放并发/token 记账，
// 防配额随会话累积驻留。
function registerTeardown(ctx, dispatch, ledger, guard, home) {
  ctx.effect(() => dispatch.dispose);
  ctx.effect(() => ledger.clear);
  ctx.effect(() => () => {
    guard.cancelAll();
    guard.reset();
    removeOwnedData(home);
  });
  const onAgentDisposed = ({ agent }) => {
    const parentSessionId = agent?.session?.header?.id;
    if (parentSessionId !== undefined && parentSessionId !== null && parentSessionId !== '') {
      guard.resetParent(parentSessionId);
    }
  };
  ctx.on('agent/disposed', onAgentDisposed);
  ctx.effect(() => () => ctx.off('agent/disposed', onAgentDisposed));
}

// subagent-profiles service over the store's per-apply profiles Map —
// lets the outside world enumerate and extend the registry without touching
// internals.
function provideProfileService(ctx, store) {
  ctx.provide('subagent-profiles', {
    register(profile) {
      if (!profile || typeof profile.id !== 'string' || profile.id.length === 0) {
        throw new Error('subagent-profiles: profile id must be a non-empty string');
      }
      if (store.profiles.has(profile.id)) {
        throw new Error(`subagent-profiles: profile "${profile.id}" is already registered`);
      }
      const registered = { ...profile };
      store.profiles.set(profile.id, registered);
      return () => {
        if (store.profiles.get(profile.id) === registered) store.profiles.delete(profile.id);
      };
    },
    get(id) {
      return store.profiles.get(id);
    },
    list() {
      return [...store.profiles.values()];
    },
    resolve(id) {
      return store.resolveProfile(id);
    }
  });
}

// 系统提示门控：两段 profile-mode section 只在当前会话 Agent 是编排者预设
// （orchestrator）时注入，从而消除从 standard/code/minimal 等不派发会话上的
// 每请求固定泄漏。判据（以源码为准确认，见 test/README.md）：主判据
// composedPreset(agentCtx)==='orchestrator'；否决 schemas(agent) 明确不含
// dispatch → 必空；回退 无 agentPresets → 保守不注入。
function sectionGatePasses(ctx, getEnabled, context) {
  if (!getEnabled()) return false;
  // 否决（防御性）：schemas(agent) 明确不含 dispatch → 必空。
  if (context !== undefined && context.agent !== undefined) {
    const schemas = ctx.tools.schemas(context.agent);
    if (Array.isArray(schemas) && !schemas.some((s) => s && s.name === 'dispatch')) {
      return false;
    }
  }
  // 主判据：preset 特征 —— composedPreset(agentCtx) === 'orchestrator'。
  const agentPresets = ctx.get('agentPresets');
  if (agentPresets !== undefined && typeof agentPresets.composedPreset === 'function') {
    const agentCtx = context !== undefined && context.agent !== undefined && context.agent.ctx !== undefined
      ? context.agent.ctx
      : ctx;
    try { return agentPresets.composedPreset(agentCtx) === 'orchestrator'; }
    catch { return false; }
  }
  // 无 agentPresets → 无法判别 → 保守不注入。
  return false;
}

// dispatch:profiles section 文本。引号引用：description 套引号；为空时显示
// 占位符（不套引号）。压平在存储层完成（sanitizeProfile），此处仅负责显示层包裹。
// 门控 profiles section 内附一行行为规则提示（非开放的 persona 注入）。
function profileSectionText(store, gate, context) {
  if (!gate(context)) return '';
  const rows = [...store.profiles.values()]
    .filter((p) => p.enabled !== false)
    .sort((a, b) => tierSortKey(a.tokenTier) - tierSortKey(b.tokenTier))
    .map((p) => {
      const desc = typeof p.description === 'string' && p.description.length > 0 ? `"${p.description}"` : '(无描述)';
      return `- ${p.id}: ${desc}${p.preset !== undefined ? ` (preset: ${p.preset})` : ''}`;
    });
  if (rows.length === 0) return '';
  const note = '- 选择方案时先匹配任务复杂度与方案描述的能力边界，成本只在能力都胜任的方案之间比较——复杂任务不得为省 token 改用能力不足的便宜方案。\n- 别把 1-2 步即可自查/可搜完的小事委派出去 —— 几分钟内能自查完的直接做。';
  return `Available dispatch profiles (dispatch.profile):\n${rows.join('\n')}\n${note}`;
}

// orchestrator:mode section 文本（逐字保留；与 profiles 同门控）。
const ORCHESTRATOR_MODE_TEXT = '本机已安装 dsh-subagent-profile 插件的「编排者模式」agent preset：新建会话的预设选择器中可选「编排者模式」。该模式把 Agent 定位为主协调者——拆解任务后按场景用 dispatch（内置 swap-standard=标准编码、researcher=调研检索，可在「子 Agent 方案」设置页自定义）与 subagent/subagent_fork/workflow 委派给子 Agent，再整合结果。preset 文件由插件维护于 ~/.dsh/.agent-presets，安装/升级时自动同步；用户提到「编排者模式 / orchestrator / 主协调模式」时即指本预设，请据此协作。';

// Directory section rendering the available profiles (systemPrompt's
// section `text` accepts a function, as the shipped tool-subagent proves).
// gate: `enabled` must be read live (getter), so /set-enabled toggles
// apply immediately without a restart.
function registerSystemPromptSections(ctx, store, getEnabled) {
  const pluginSystemPrompt = ctx.get('systemPrompt');
  if (pluginSystemPrompt === undefined) return;
  const gate = (context) => sectionGatePasses(ctx, getEnabled, context);
  pluginSystemPrompt.section({
    name: 'dispatch:profiles',
    order: 116.5,
    text: (context) => profileSectionText(store, gate, context),
  });
  // Announce the self-installed orchestrator preset so the current agent
  // knows the mode exists and can point the user to it. Gated the same
  // way — only a dispatch-capable agent sees it.
  pluginSystemPrompt.section({
    name: 'orchestrator:mode',
    order: 117,
    text: (context) => (gate(context) ? ORCHESTRATOR_MODE_TEXT : ''),
  });
}

// HTTP loopback routes for the Client settings UI (webServer.register ↔
// client fetch; JSON only) — the routes themselves live in
// lib/core/http-routes.mjs (imported above); this wiring only injects the
// per-apply deps. webServer is optional — a headless deployment keeps the
// dispatch tool and drops only the settings page. webServer's activation
// (listen) is async and may not be ready when this plugin's inject deps
// resolve, so register inside an inject sub-scope that waits for it
// (ctx.get would read undefined at apply time).
function registerSettingsRoutes(ctx, store, getEnabled, setEnabled, syncTool, catalog, ledger) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(createHttpRoutes({
      webServer: scope.webServer,
      store,
      getEnabled,
      setEnabled,
      syncTool,
      catalog,
      ledger,
      logger: ctx.logger,
    }), 'dsh-subagent-profile: settings routes');
  });
}

// 进程级共享 catalog 快照工厂：一处快照同时喂 /options 三路由与 dispatch 的
// cost guard（cost guard 经 parent.ctx.get('llm') 传父实例，同一 host llm 下
// 命中同一条目）。
function createSharedCatalog(ctx) {
  return createCatalogCache({
    getLlm: () => ctx.get('llm'),
    getAgentPresets: () => ctx.get('agentPresets'),
    getTools: () => ctx.tools,
    logger: ctx.logger,
  });
}

// 读本插件 package.json version 供派发台账 provenance 使用。fail-soft：读取/解析
// 失败回退 'unknown'，绝不阻断插件启动。
function readPluginVersion() {
  try {
    const pkg = createRequire(import.meta.url)('./package.json');
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function apply(ctx) {
  // Enable/disable switch (default on, runtime-toggled by the settings page) +
  // profile registry — lib/profiles-store.mjs: createProfileStore. loadProfiles
  // runs once at startup via the explicit call below (the factory does not auto-load).
  const home = dshHome();
  const store = createProfileStore({ dshHome: home, logger: ctx.logger });
  let enabled = store.loadEnabled();
  store.loadProfiles();
  // Self-install the bundled "orchestrator" preset (idempotent, fail-soft).
  syncBundledPresetsToHome(ctx);
  // 进程级共享 catalog 快照（/options 三路由 + dispatch cost guard 共用）。
  const catalog = createSharedCatalog(ctx);
  // 失败台账（stateFile 落盘 JSON，同进程共享同一实例）+ 总预算守卫（并发/token/在途）。
  const ledger = createFailureLedger({ warn: (message) => ctx.logger.warn(`[dsh-subagent-profile] ${message}`), stateFile: join(home, 'subagent-profiles.failed-traces.json') });
  const guard = createDispatchGuard({ warn: (message) => ctx.logger.warn(`[dsh-subagent-profile] ${message}`) });
  // 派发台账（~/.dsh/subagent-evolution/dispatch.jsonl，JSONL 追加不可变）。默认开。
  const evoLedger = createEvolutionLedger({ dshHome: home, pluginVersion: readPluginVersion(), warn: (message) => ctx.logger.warn(`[dsh-subagent-profile] ${message}`) });
  // `dispatch` tool（defineTool schema + execute + syncTool 注册/注销）。Created
  // BEFORE the HTTP inject so createHttpRoutes can capture dispatch.syncTool.
  const dispatch = createDispatchTool({
    register: (tool) => ctx.tools.register(tool),
    store,
    getEnabled: () => enabled,
    getService: (name) => ctx.get(name),
    logger: ctx.logger,
    subagents: ctx.subagents,
    catalog,
    ledger,
    guard,
    evoLedger,
  });
  // subagent-profiles service over the store's per-apply profiles Map.
  provideProfileService(ctx, store);
  // Gated system-prompt sections (profile directory + orchestrator mode).
  registerSystemPromptSections(ctx, store, () => enabled);
  // `profile` subagent provider（createProfileProvider registers + returns disposer）。
  const disposeProvider = createProfileProvider({
    subagents: ctx.subagents,
    store,
    getEnabled: () => enabled,
    logger: ctx.logger,
    catalog,
  });
  if (typeof disposeProvider === 'function') ctx.effect(() => disposeProvider);
  // HTTP loopback routes for the Client settings UI — lib/core/http-routes.mjs.
  registerSettingsRoutes(ctx, store, () => enabled, (next) => { enabled = next; }, dispatch.syncTool, catalog, ledger);
  registerTeardown(ctx, dispatch, ledger, guard, home);
}
