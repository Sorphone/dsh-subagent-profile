// index.mjs — dsh-subagent-profile host side (formal plugin bundle).
// Converted from prototype/subagent-profile/host.plugin.js (the dynamic-plugin
// `code.host` body). V2.0-mid 12-module split: the harness-only APIs
// (registerTool/defineTool/handle) map to lib/shims.mjs, and the wiring blocks
// live in lib/ (catalog / presets-sync / profiles-store / cost-guard /
// whitelist / intersection / delegation / pure / shims / http-routes /
// profile-provider / dispatch-tool). This file only assembles them.

import { join } from 'node:path';
import { syncBundledPresets } from './lib/presets-sync.mjs';
import { dshHome, createProfileStore } from './lib/profiles-store.mjs';
import { createHttpRoutes } from './lib/http-routes.mjs';
import { createProfileProvider } from './lib/profile-provider.mjs';
import { createDispatchTool } from './lib/dispatch-tool.mjs';

export const name = 'dsh-subagent-profile';
export const inject = ['subagents', 'tools', 'agents'];

export async function apply(ctx) {
  // 0. Enable/disable switch: default on, toggled at runtime by the settings
  //    page and persisted across restarts. When off, the dispatch tool is
  //    unregistered so it disappears from the model's tool list.
  // 1. Profile registry + enable/disable switch + persistence now live in
  //    lib/profiles-store.mjs: createProfileStore({ dshHome, logger }) returns
  //    the profiles Map, deletedBuiltins Set, resolveProfile / loadProfiles /
  //    persistProfiles / loadEnabled / persistEnabled / getAllowFailOpen.
  //    loadProfiles runs once at startup via the explicit call below (the
  //    factory itself does not auto-load).
  const store = createProfileStore({ dshHome: dshHome(), logger: ctx.logger });
  let enabled = store.loadEnabled();
  store.loadProfiles();

  // 1c. Self-install the bundled "orchestrator" agent preset into the DSH
  // agent-presets root so the mode appears in the new-session picker without
  // manual copying (mirrors the shipped dsh-liangshen self-install). Idempotent:
  // byte-identical trees are skipped; a bundle change rewrites the preset — the
  // intended upgrade path. Fail-soft: the dispatch tool and settings page keep
  // working even if the write is denied.
  try {
    const presetRoot = join(dshHome(), '.agent-presets');
    const sync = syncBundledPresets(presetRoot);
    for (const { id, error } of sync.failed) ctx.logger.warn(`[dsh-subagent-profile] preset ${id} sync failed: ${error}`);
    if (sync.synced.length > 0) ctx.logger.info(`[dsh-subagent-profile] presets synced into ${presetRoot}: ${sync.synced.join(', ')}`);
  } catch (error) {
    ctx.logger.warn('[dsh-subagent-profile] preset sync failed:', error instanceof Error ? error.message : String(error));
  }

  // 4. `dispatch` tool — the defineTool block (schema + execute), the R1 schema
  //    lock and the syncTool register/unregister logic live in
  //    lib/dispatch-tool.mjs (imported above): createDispatchTool({ register,
  //    store, getEnabled, getService, logger, subagents }) returns
  //    { syncTool, dispose }. Created BEFORE the HTTP inject so
  //    createHttpRoutes can capture dispatch.syncTool (/set-enabled).
  const dispatch = createDispatchTool({
    register: (tool) => ctx.tools.register(tool),
    store,
    getEnabled: () => enabled,
    getService: (name) => ctx.get(name),
    logger: ctx.logger,
    subagents: ctx.subagents,
  });

  // C: subagent-profiles service over the store's per-apply profiles Map —
  // lets the outside world enumerate and extend the registry without touching
  // internals.
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

  // C: directory section rendering the available profiles (systemPrompt's
  // section `text` accepts a function, as the shipped tool-subagent proves).
  const pluginSystemPrompt = ctx.get('systemPrompt');
  if (pluginSystemPrompt !== undefined) {
    // §8.1 系统提示门控：两段 profile-mode section **只在当前席 Agent 是编排者
    // 预设（orchestrator）**时注入，从而消除从 standard/code/minimal 等不派发
    // 会话上的每请求固定泄漏。
    //
    // —— 门控判据（以源码为准确认，见 test/README.md）——
    // 主判据（preset 特征）：`composedPreset(agentCtx) === 'orchestrator'`。这是
    // 判别「是否编排者会话」的可靠信号：dispatch 工具由本 host 行注册、经
    // dsh-tools `schemas(scope)` 的 global 继承起点对**每个** agent 恒可见，因此
    // 「schemas(agent) 含 dispatch」在宿主架构下恒真，**不能**作为主判据（规格
    // 评审意见：schemas 判据降为否决）。
    // 否决（防御，防假阳性）：若 `schemas(agent)` **明确不含** dispatch → 必空。
    // 生产环境恒含 dispatch（host-global），此否决在正常路径不触发；它只防御任何
    // 让 dispatch 从 agent 视野消失的宿主行为。
    // 回退：拿不到 agentPresets（composedPreset 不可用）时无法判别当前 Agent 的
    // 组成，保守不注入（无泄漏风险）。
    //
    // section.text(context) 由宿主以 assembleContextFor(agent, signal) =
    // { agent, scope: agent, signal } 调用（@deepseek-ai/dsh-agent），因此 text()
    // 能拿到 context.agent；Agent 实例带 .ctx（dsh-agent-presets 的
    // composedPreset(agentCtx) 正以 agentCtx 作为期望入参），故主判据优先取
    // context.agent.ctx。
    const sectionGatePasses = (context) => {
      if (!enabled) return false;
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
    };
    pluginSystemPrompt.section({
      name: 'dispatch:profiles',
      order: 116.5,
      text: (context) => {
        if (!sectionGatePasses(context)) return '';
        const rows = [...store.profiles.values()]
          .filter((p) => p.enabled !== false)
          .map((p) => {
            // 引号引用：description 套引号；为空时显示占位符（不套引号）。压平
            // 在存储层完成（sanitizeProfile），此处仅负责显示层包裹。
            const desc = typeof p.description === 'string' && p.description.length > 0 ? `"${p.description}"` : '(无描述)';
            return `- ${p.id}: ${desc}${p.preset !== undefined ? ` (preset: ${p.preset})` : ''}`;
          });
        if (rows.length === 0) return '';
        // §8.3 一行行为规则（进门控 profiles section，非常开 persona）：用相对
        // 锚点降低「几分钟内可自查完的小任务」被派发的概率（SPEC §8.1 残留分歧
        // 已定：行为规则注入点取门控 profiles section）。
        const note = '- 别把 1-2 步即可自查/可搜完的小事委派出去 —— 几分钟内能自查完的直接做。';
        return `Available dispatch profiles (dispatch.profile):\n${rows.join('\n')}\n${note}`;
      }
    });
    // Announce the self-installed orchestrator preset so the current agent
    // knows the mode exists and can point the user to it. §8.1: gated the same
    // way — only a dispatch-capable agent sees it.
    pluginSystemPrompt.section({
      name: 'orchestrator:mode',
      order: 117,
      text: (context) => {
        if (!sectionGatePasses(context)) return '';
        return '本机已安装 dsh-subagent-profile 插件的「编排者模式」agent preset：新建会话的预设选择器中可选「编排者模式」。该模式把 Agent 定位为主协调者——拆解任务后按场景用 dispatch（内置 swap-standard=标准编码、researcher=调研检索，可在「子 Agent 方案」设置页自定义）与 subagent/subagent_fork/workflow 委派给子 Agent，再整合结果。preset 文件由插件维护于 ~/.dsh/.agent-presets，安装/升级时自动同步；用户提到「编排者模式 / orchestrator / 主协调模式」时即指本预设，请据此协作。';
      }
    });
  }

  // 3. `profile` subagent provider — setup/start/prepareContinuable live in
  //    lib/profile-provider.mjs (imported above): createProfileProvider({
  //    subagents, store, getEnabled, logger }) registers the provider and
  //    returns registerProvider's disposer.
  const disposeProvider = createProfileProvider({
    subagents: ctx.subagents,
    store,
    getEnabled: () => enabled,
    logger: ctx.logger,
  });
  if (typeof disposeProvider === 'function') ctx.effect(() => disposeProvider);

  // 1c. HTTP loopback routes for the Client settings UI (webServer.register ↔
  // client fetch; JSON only) — the routes themselves live in
  // lib/http-routes.mjs (imported above); this wiring only injects the
  // per-apply deps. webServer is optional — a headless deployment keeps the
  // dispatch tool and drops only the settings page. webServer's activation
  // (listen) is async and may not be ready when this plugin's inject deps
  // resolve, so register inside an inject sub-scope that waits for it
  // (ctx.get would read undefined at apply time).
  ctx.inject(['webServer'], (scope) => {
    scope.effect(createHttpRoutes({
      webServer: scope.webServer,
      store,
      getEnabled: () => enabled,
      setEnabled: (next) => { enabled = next; },
      syncTool: dispatch.syncTool,
      getLlm: () => ctx.get('llm'),
      getAgentPresets: () => ctx.get('agentPresets'),
      getTools: () => ctx.tools,
      logger: ctx.logger,
    }), 'dsh-subagent-profile: settings routes');
  });

  // Teardown: unregister the dispatch tool (if still registered).
  ctx.effect(() => dispatch.dispose);
}
