// index.mjs — dsh-subagent-profile host side (formal plugin bundle).
// Converted from prototype/subagent-profile/host.plugin.js (the dynamic-plugin
// `code.host` body) with import slimming: the inline foldConsumedWork /
// accountsForClaim / lastAssistantContent / uuid / AbortController-shim are
// replaced by package imports or platform primitives where semantics match
// exactly, and the harness-only APIs (registerTool/defineTool/handle) are
// mapped to their bundle equivalents or guarded. See the import mapping table
// in README.md.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  appendDelegatedPolicyOverrides,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  createUserMessage,
  defineTool,
  readResult,
  resolveChildAgentOptions,
  resolveChildDepth,
} from './lib/shims.mjs';
import { textFrom, stopReasonError, withPartialText, sanitizeProfile, GUIDANCE_PREFIX, computeContinuableAllow, pruneBlocks, assertResultSchemaConsistency } from './lib/pure.mjs';
import { TOOL_ZH, TOOL_CATEGORY } from './lib/catalog.mjs';
import { syncBundledPresets } from './lib/presets-sync.mjs';
import { dshHome, BUILTIN_SEEDS, createProfileStore } from './lib/profiles-store.mjs';
import { assertCostGuard } from './lib/cost-guard.mjs';
import { resolveWhitelist } from './lib/whitelist.mjs';
import { computeEffectiveAllow } from './lib/intersection.mjs';
import { settleStart, DELEGATION_CONTEXT, buildDispatchMeta } from './lib/delegation.mjs';

export const name = 'dsh-subagent-profile';
export const inject = ['subagents', 'tools', 'agents'];

// Resolve the DSH home directory + the enable/disable switch + the profile
// registry store now live in lib/profiles-store.mjs (imported above): dshHome /
// BUILTIN_SEEDS / createProfileStore({ dshHome, logger }).

// --- bundled agent-preset self-install --------------------------------------
// Implemented in lib/presets-sync.mjs (imported above): bundledPresetsRoot /
// MTIME_TOLERANCE_MS / filesUnder / sameFile / copyTreeSync / pruneExtras /
// syncOnePreset / syncBundledPresets were moved there verbatim. The call site
// below keeps the same shape: syncBundledPresets(join(dshHome(), '.agent-presets')).

// Only the loopback interfaces may drive the settings HTTP routes.
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// --- module-level helpers (moved to lib/ in Task 7b) ---
// assertCostGuard → lib/cost-guard.mjs; settleStart / DELEGATION_CONTEXT /
// buildDispatchMeta → lib/delegation.mjs; computeEffectiveAllow →
// lib/intersection.mjs; FALLBACK_WHITELIST / resolveWhitelist →
// lib/whitelist.mjs. All four modules are imported at the top of this file;
// the remaining module-level bindings here are only LOOPBACKS and the
// export surface.

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

  // Tool-name → 中文说明 map (TOOL_ZH) and 功能分类 map (TOOL_CATEGORY) now live
  // in lib/catalog.mjs (imported at the top); the /options handler reads them
  // from the module-level bindings.

  // F6: the target-preset whitelist now lives in lib/whitelist.mjs (imported at
  // the top): FALLBACK_WHITELIST + resolveWhitelist(agentPresets). The caller
  // injects parent.ctx.get('agentPresets') (undefined → fallback, same semantics).

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

  // 1c. HTTP loopback routes for the Client settings UI (webServer.register ↔
  // client fetch; JSON only). webServer is optional — a headless deployment
  // keeps the dispatch tool and drops only the settings page. webServer's
  // activation (listen) is async and may not be ready when this plugin's
  // inject deps resolve, so register inside an inject sub-scope that waits for
  // it (ctx.get would read undefined at apply time).
  ctx.inject(['webServer'], (scope) => {
    const json = (res, code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    const readBody = (req) => new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1 << 20) { reject(new Error('请求体过大')); req.destroy(); return; }
        data += chunk;
      });
      req.on('end', () => {
        try { resolve(data === '' ? {} : JSON.parse(data)); } catch { reject(new Error('请求体不是合法 JSON')); }
      });
      req.on('error', reject);
    });
    // D5/B1 write-failure contract: the write routes return HTTP 200 with
    // `persisted` always present; when the disk write failed, persistWarning
    // explains "已保存但未持久化" (in-memory state drives this process, the
    // disk did not update). The client renders that as the amber warning.
    const persistOk = (res, payload, persist) => json(res, 200, {
      ok: true,
      ...payload,
      persisted: persist.persisted,
      ...(persist.persisted ? {} : { persistWarning: '已保存但未持久化' }),
    });
    const listClean = () => [...store.profiles.values()].map((profile) => {
      const clean = {};
      for (const [key, value] of Object.entries(profile)) if (value !== undefined && key !== 'persisted') clean[key] = value;
      // The internal `persisted` flag is stripped above; expose a UI-facing
      // "modified" signal so the reset panel can label a changed builtin.
      if (profile.builtin === true && profile.persisted === true) clean.modified = true;
      return clean;
    });
    const handler = async (req, res) => {
      const remote = req.socket?.remoteAddress;
      if (!LOOPBACKS.has(remote)) return json(res, 403, { ok: false, error: '仅限本机访问' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const sub = (url.pathname.replace(/^\/subagent-profiles/, '') || '/').replace(/\/+$/, '') || '/';
      try {
        if (req.method === 'GET' && (sub === '/' || sub === '/list')) {
          return json(res, 200, { ok: true, profiles: listClean() });
        }
        if (req.method === 'GET' && sub === '/options') {
          const models = [];
          const efforts = {};
          const presets = [];
          // Model directory + per-model reasoning-effort levels. The `llm`
          // service is optional (headless): a failure only empties the lists,
          // never breaks the settings page.
          const llm = ctx.get('llm');
          if (llm !== undefined) {
            try {
              const providers = await llm.listProviders();
              for (const provider of (providers ?? [])) {
                const providerId = provider && provider.id;
                if (typeof providerId !== 'string') continue;
                let modelList = [];
                try { modelList = await llm.listModels(providerId); } catch { /* skip this provider's catalog */ }
                for (const model of (modelList ?? [])) {
                  if (!model || typeof model.id !== 'string') continue;
                  models.push({
                    provider: providerId,
                    providerName: provider.name ?? providerId,
                    id: model.id,
                    name: model.name ?? model.id
                  });
                  try {
                    const info = await llm.resolveModelInfo(providerId, model.id);
                    const effortsList = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : [];
                    efforts[model.id] = effortsList.map((effort) => ({
                      id: effort.id,
                      name: effort.name ?? effort.id,
                      ...(effort.description !== undefined ? { description: effort.description } : {})
                    }));
                  } catch { /* exact-model lookup may reject; skip its efforts */ }
                }
              }
            } catch { /* llm directory unavailable; leave options empty */ }
          }
          // System-trust presets (agentPresets is optional; fail-soft).
          const agentPresets = ctx.get('agentPresets');
          if (agentPresets !== undefined) {
            try {
              const list = await agentPresets.list();
              for (const preset of (list ?? [])) {
                if (preset && preset.trust === 'system') {
                  presets.push({ id: preset.id, name: preset.name ?? preset.id });
                }
              }
            } catch { /* presets roster unavailable; leave empty */ }
          }
          // Full tool directory = global layer (deployment plugins) + every
          // preset's standing scope (the agent.cordis.yml tool rows). Each tool
          // is tagged with its source: 'global' or the preset id — the grouping
          // is fully dynamic, derived from the runtime's preset roster.
          let tools = [];
          try {
            const seen = new Set();
            const OFFICIAL_PRESETS = ['standard', 'code', 'minimal', 'cordis'];
            const layerOf = (source) => {
              if (source === 'global') return 'plugin';
              if (OFFICIAL_PRESETS.includes(source)) return 'core';
              return 'custom';
            };
            const groupOf = (name, source) => {
              const layer = layerOf(source);
              if (layer === 'core') return TOOL_CATEGORY[name] ?? '其他';
              if (layer === 'plugin') return name.includes('_') ? name.split('_')[0] : name;
              return source;
            };
            const push = (schemas, source) => {
              for (const s of (Array.isArray(schemas) ? schemas : [])) {
                if (!s || typeof s.name !== 'string' || s.name === 'run_code' || seen.has(s.name)) continue;
                seen.add(s.name);
                tools.push({ name: s.name, description: typeof s.description === 'string' ? s.description : '', zh: TOOL_ZH[s.name] ?? '', source, layer: layerOf(source), group: groupOf(s.name, source) });
              }
            };
            if (ctx.tools && typeof ctx.tools.schemas === 'function') {
              push(ctx.tools.schemas(), 'global');
              const agentPresets = ctx.get('agentPresets');
              if (agentPresets !== undefined && typeof agentPresets.list === 'function' && typeof agentPresets.standingKeyFor === 'function') {
                const presets = await agentPresets.list();
                for (const preset of (presets ?? [])) {
                  if (!preset || typeof preset.id !== 'string') continue;
                  try {
                    push(ctx.tools.schemas(await agentPresets.standingKeyFor(preset.id)), preset.id);
                  } catch { /* one preset's standing scope unavailable; skip */ }
                }
              }
            }
          } catch (error) {
            ctx.logger.warn('[dsh-subagent-profile] tools directory failed:', error instanceof Error ? error.message : String(error));
          }
          return json(res, 200, { ok: true, enabled, models, efforts, presets, tools });
        }
        if (req.method === 'POST' && sub === '/set-enabled') {
          const body = await readBody(req);
          const next = !!(body && body.enabled === true);
          enabled = next;
          store.persistEnabled(next);
          syncTool();
          return json(res, 200, { ok: true, enabled });
        }
        if (req.method === 'POST' && sub === '/add') {
          const body = await readBody(req);
          const profile = body && typeof body === 'object' ? body : {};
          if (typeof profile.id !== 'string' || profile.id.length === 0) {
            return json(res, 400, { ok: false, error: 'subagent-profiles: profile id must be a non-empty string' });
          }
          // 写路径上限（SPEC §7.2）：strict=true —— 超限/非法字段直接 400 拒绝，
          // 与 loadProfiles（strict=false 迁移宽松读取）的行为区分。列被拒字段与中文原因。
          const { clean, warnings } = sanitizeProfile(profile, { strict: true });
          if (warnings.length > 0) {
            const detail = warnings.map((w) => `${w.field}：${w.reason}`).join('；');
            return json(res, 400, { ok: false, error: `写入被拒绝：${detail}` });
          }
          const hadToolFilter = profile.toolFilter !== undefined;
          const existing = store.profiles.get(clean.id);
          const seed = BUILTIN_SEEDS.find((s) => s.id === clean.id);
          const isBuiltin = (existing !== undefined && existing.builtin === true) || seed !== undefined;
          // Merge (not replace): start from the existing profile — or its seed
          // when it was deleted — so fields not present in the form (e.g. a
          // builtin's persona/preset) survive an edit or a re-add. `clean` is the
          // sanitized request body, so a field absent from the request is absent
          // from clean and the existing value is preserved (merge semantics).
          const merged = { ...(existing ?? seed ?? {}) };
          merged.id = clean.id;
          for (const key of ['name', 'description', 'preset', 'provider', 'model', 'reasoningEffort', 'persona', 'enabled']) {
            if (clean[key] === undefined) continue;       // 未传：保留 existing 原值
            if (clean[key] === '' || clean[key] === null) { delete merged[key]; continue; }  // 空：清除字段
            merged[key] = clean[key];
          }
          // toolFilter 特殊处理：前端改成多选下拉后总是传数组，空数组 = 清除。
          // 请求未传 toolFilter 时保留 existing 原值（merge 语义）；传了但被
          // sanitize 归一为空（如 allow/deny 均空）则清除。
          if (hadToolFilter) {
            const tf = clean.toolFilter;
            if (tf !== undefined && ((Array.isArray(tf.allow) && tf.allow.length > 0) || (Array.isArray(tf.deny) && tf.deny.length > 0))) {
              merged.toolFilter = { ...(Array.isArray(tf.allow) && tf.allow.length > 0 ? { allow: tf.allow } : {}), ...(Array.isArray(tf.deny) && tf.deny.length > 0 ? { deny: tf.deny } : {}) };
            } else {
              delete merged.toolFilter;
            }
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === false ? false : true;
          store.profiles.set(merged.id, { ...merged, ...(isBuiltin ? { builtin: true } : {}), persisted: true });
          store.deletedBuiltins.delete(merged.id);
          return persistOk(res, { id: merged.id }, store.persistProfiles());
        }
        if (req.method === 'POST' && sub === '/remove') {
          const body = await readBody(req);
          const id = body && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
          const existing = store.profiles.get(id);
          if (existing === undefined) {
            return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" does not exist` });
          }
          store.profiles.delete(id);
          if (existing.builtin === true) store.deletedBuiltins.add(id);
          return persistOk(res, { id }, store.persistProfiles());
        }
        if (req.method === 'POST' && sub === '/reset') {
          const body = await readBody(req);
          const id = body && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
          const seed = BUILTIN_SEEDS.find((s) => s.id === id);
          if (seed === undefined) {
            return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" is not a builtin (nothing to reset)` });
          }
          store.profiles.set(id, { ...seed });
          store.deletedBuiltins.delete(id);
          return persistOk(res, { id }, store.persistProfiles());
        }
        if (req.method === 'POST' && sub === '/reset-all') {
          for (const seed of BUILTIN_SEEDS) {
            store.profiles.set(seed.id, { ...seed });
            store.deletedBuiltins.delete(seed.id);
          }
          return persistOk(res, { count: BUILTIN_SEEDS.length }, store.persistProfiles());
        }
        if (req.method === 'POST' && sub === '/set-profile-enabled') {
          const body = await readBody(req);
          const id = body && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
          const existing = store.profiles.get(id);
          if (existing === undefined) {
            return json(res, 404, { ok: false, error: `subagent-profiles: profile "${id}" does not exist` });
          }
          existing.enabled = body && body.enabled === false ? false : true;
          // Persist unconditionally (not just for builtins): a runtime-registered
          // profile's enable/disable must also survive a restart.
          existing.persisted = true;
          return persistOk(res, { id, enabled: existing.enabled }, store.persistProfiles());
        }
        json(res, 404, { ok: false, error: `未知路由 ${sub}` });
      } catch (error) {
        // 通用 500 不回显内部错误信息（防泄漏），详情只进宿主日志。
        ctx.logger.error('[dsh-subagent-profile] settings route error:', error instanceof Error ? (error.stack ?? error.message) : String(error));
        json(res, 500, { ok: false, error: '内部错误，详情见宿主日志' });
      }
    };
    scope.effect(() => {
      const disposeRoutes = scope.webServer.register({ kind: 'prefix', path: '/subagent-profiles', handler });
      return () => disposeRoutes();
    }, 'dsh-subagent-profile: settings routes');
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

  // 3. `profile` subagent provider.
  const disposeProvider = ctx.subagents.registerProvider({
    name: 'profile',
    capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    async start(request) {
      if (!enabled) {
        throw new Error('dispatch: the subagent-profile plugin is disabled (re-enable it in 设置 → 子 Agent 方案)');
      }
      const profile = request.profile;
      if (profile === undefined) {
        throw new Error('dispatch: request.profile is missing (the dispatch tool must resolve a profile before starting)');
      }
      const parent = request.parent;
      // F9: capture the delegation policy synchronously, before the first
      // await — a later parent switch belongs to the parent's future, not to
      // this child (shipped captureDelegatedPolicyOverrides). Passed to setup
      // through the closure.
      const delegated = captureDelegatedPolicyOverrides(parent);
      // F6: authoritative preset whitelist check against the runtime roster.
      const whitelist = new Set(await resolveWhitelist(parent.ctx.get('agentPresets')));
      if (typeof profile.preset === 'string' && profile.preset !== 'inherit' && !whitelist.has(profile.preset)) {
        throw new Error(`dispatch: preset "${profile.preset}" is not in the target-preset whitelist`);
      }
      // F5: authoritative cost guard (runtime-derived; hard caps always applied,
      // llm capability gated by allowFailOpen — SPEC §7.3).
      await assertCostGuard(parent, profile, store.getAllowFailOpen(), ctx.logger);
      // Delegation depth: shipped helpers — assert the cap value, then resolve
      // the child depth (parent floor + 1) and enforce the cap.
      assertSubagentMaxDepth(profile.maxDepth);
      const childDepth = resolveChildDepth(parent, profile.maxDepth);
      const childId = randomUUID();
      const parentAgentPresets = parent.ctx.get('agentPresets');
      const parentComposed = parentAgentPresets !== undefined ? parentAgentPresets.composedPreset(parent.ctx) : undefined;
      const swapPreset = typeof profile.preset === 'string' && profile.preset !== 'inherit' && profile.preset !== parentComposed;
      // F8: agentPreset is recorded only when a preset roster exists
      // (non-rosterless), otherwise omitted entirely. This meta is CUSTOM —
      // not the shipped childSessionMeta — because a swap records
      // profile.preset instead of the parent's composedPreset. The pure
      // assembly lives in lib/delegation.mjs: buildDispatchMeta.
      const meta = buildDispatchMeta({
        cwd: parent.session.header.cwd,
        hasPresets: parentAgentPresets !== undefined,
        swapPreset,
        preset: profile.preset,
        parentComposed,
        parentSession: parent.session.header.id,
        childDepth
      });
      // agentOptions: shipped resolveChildAgentOptions — parent route inherited
      // unless the profile overrides provider/model/maxTokens, stamped with the
      // child's own delegation depth.
      const agentOptions = resolveChildAgentOptions(parent, {
        ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
        ...(profile.model !== undefined ? { model: profile.model } : {}),
        ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {})
      }, childDepth);
      if (request.signal !== undefined && request.signal.aborted) {
        throw new Error('dispatch: subagent request was aborted before child publication');
      }
      const handle = await parent.ctx.agents.create({
        sessionId: childId,
        meta,
        agentOptions,
        signal: request.signal,
        setup: async (childCtx) => {
          // ① Preset composition: explicit swap mounts the target preset;
          //    otherwise compose from the parent. E: rosterless + explicit
          //    swap fails loud instead of silently degrading. This is CUSTOM —
          //    not the shipped applyChildComposition, which only composes from
          //    the parent.
          const childPresets = childCtx.get('agentPresets');
          if (swapPreset) {
            if (childPresets === undefined) {
              throw new Error('dispatch: cannot swap preset in a rosterless deployment');
            }
            await childPresets.mount(childCtx, profile.preset);
          } else if (childPresets !== undefined) {
            childPresets.composeFrom(childCtx, parent.ctx);
          }
          // ② Tool intersection (safety gate 1): parent set ∩ child set, minus
          //    run_code, minus deny, then narrowed by allow when present (pure
          //    core in lib/intersection.mjs: computeEffectiveAllow).
          const parentNames = new Set(parent.ctx.tools.schemas(parent).map((schema) => schema.name));
          const childNames = childCtx.tools.schemas(childCtx.agent).map((schema) => schema.name);
          const effective = computeEffectiveAllow(parentNames, childNames, profile.toolFilter);
          // F4: shipped restrict does NOT throw on allow:[] — fail loud here so
          // the empty-intersection case is explicit (throw => setupAndPublish
          // rolls the creation back).
          if (effective.length === 0) {
            throw new Error('dispatch: child tool intersection is empty (zero tools)');
          }
          // restrict throws on unknown/scope-local/reserved allow sets: wrap
          // in a clean error and rethrow to trigger creation rollback.
          try {
            childCtx.tools.restrict({ allow: effective });
          } catch (error) {
            throw new Error(`dispatch: child tool restriction failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          // ③ Delegation scope declaration (when systemPrompt is available).
          const systemPrompt = childCtx.get('systemPrompt');
          if (systemPrompt !== undefined) {
            systemPrompt.context({ name: 'subagent:delegation', order: 120, text: DELEGATION_CONTEXT });
          }
          // ④ Persona shadow (overrides deployment:persona at order 0). The
          // guidance marker is prefixed when the persona is non-empty (双防线):
          // the injected text is `${GUIDANCE_PREFIX}${persona}`, exactly the
          // length the sanitizeProfile cap validates (wrappedLength).
          if (profile.persona !== undefined && systemPrompt !== undefined) {
            systemPrompt.section({
              name: 'deployment:persona',
              order: 0,
              text: profile.persona.length > 0 ? `${GUIDANCE_PREFIX}${profile.persona}` : profile.persona,
            });
          }
          // ⑤ Reasoning-effort injection into every child request.
          if (profile.reasoningEffort !== undefined) {
            childCtx.on('agent/request', async (_payload, next) => {
              const resolved = await next();
              return { ...resolved, reasoningEffort: profile.reasoningEffort };
            });
          }
          // ⑥ Descriptor append inside the child's first turn.
          let appended = false;
          childCtx.on('agent/pre-step', async ({ agent }, next) => {
            const decision = await next();
            if (!appended && decision.kind === 'enter') {
              appended = true;
              agent.session.append('subagent/descriptor', request.descriptor);
            }
            return decision;
          });
          // ⑦ Delegation policy appends (shipped helper: sandbox/mode when the
          //    parent has an explicit override, approval/policy pinned 'never').
          appendDelegatedPolicyOverrides(childCtx.agent.session, delegated);
        }
      });
      // F3: post-publication cancellation wiring (drivePublishedRun): the
      // caller signal cancels the child and the result closure skips the
      // followup when already cancelled.
      const child = handle.agent;
      const boundary = child.session.events.length;
      const flags = { cancelled: false };
      const onAbort = () => {
        flags.cancelled = true;
        child.cancel({ kind: 'parent' });
      };
      const signal = request.signal;
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      const result = (async () => {
        try {
          if (!flags.cancelled) {
            child.followup(createUserMessage({ content: request.prompt, source: { kind: 'user' } }));
            await child.whenIdle();
          }
          const settled = readResult(child, boundary, flags.cancelled);
          // Decision-level log at result settlement (readResult, before return).
          ctx.logger.info('[dsh-subagent-profile] child:', JSON.stringify({ childId, preset: profile.preset ?? 'inherit', swapPreset, stopReason: settled.stopReason }));
          return settled;
        } finally {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        }
      })();
      return {
        id: childId,
        localAgent: child,
        result,
        async dispose() {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          flags.cancelled = true;
          const settled = await Promise.allSettled([handle.dispose(), result]);
          if (settled[0].status === 'rejected') throw settled[0].reason;
        }
      };
    },
    async prepareContinuable() {
      return {};
    }
  });
  if (typeof disposeProvider === 'function') ctx.effect(() => disposeProvider);

  // 4. `dispatch` tool — bundle registration: the dynamic-plugin harness pair
  //    (harness.defineTool/harness.registerTool) does not exist in a bundle, so
  //    this uses the shipped ctx.tools.register + imported defineTool. The tool
  //    is registered dynamically so the settings switch can unregister it at
  //    runtime (disappearing from the model's tool list) without a restart.
  const dispatchTool = defineTool({
    name: 'dispatch',
    description: 'Dispatch a subtask to a derived subagent, optionally overriding its preset, model, provider, reasoning effort, persona, tool whitelist, token budget, or recursion depth. Foreground waits for the result; run_in_background: true starts a background job (single turn); continuable: true starts a durable subagent whose conversation stays available for later turns via the send_message tool. 前瞻：continuable 模式忽略 preset 换用与 reasoningEffort（结果以 ignored 提示）。',
    parameters: {
      profile: { type: 'string', description: 'Optional profile id from the profile registry (built-ins: swap-standard, researcher, plus any you define in the settings page); omit to inherit the parent preset and tools as-is.' },
      preset: { type: 'string', description: 'Explicit target preset override; must be a system-trust preset of this runtime.' },
      model: { type: 'string', description: 'Explicit model override for the child.' },
      provider: { type: 'string', description: 'Explicit provider override for the child.' },
      reasoningEffort: { type: 'string', description: 'Explicit reasoning-effort override injected into every child request.' },
      persona: { type: 'string', description: 'Persona text shadowing the child deployment:persona section.' },
      toolFilter: {
        type: 'object',
        // F1: DSL object parameters reject unknown keys by default, so the
        // toolFilter object must close its schema or defineTool throws at
        // apply time and the plugin fails to load.
        additionalProperties: false,
        description: 'Extra tool whitelist intersection for the child (intersected with the parent tool set).',
        properties: {
          allow: { type: 'array', items: { type: 'string' }, description: 'When present, only these tool names are kept.' },
          deny: { type: 'array', items: { type: 'string' }, description: 'These tool names are always removed.' }
        }
      },
      maxTokens: { type: 'number', description: 'Explicit max-tokens budget for the child.' },
      maxDepth: { type: 'number', description: 'Absolute delegation-depth cap for this child.' },
      run_in_background: { type: 'boolean', description: '异步 one-shot：走 jobs.start 包 start()，返回 jobId；仍单轮即弃，非 continuable' },
      continuable: { type: 'boolean', description: 'Start a durable continuable subagent instead of a one-shot: returns a subagentId immediately and keeps the child conversation available for later turns via the send_message tool. Defaults to false.' },
      // §8.2 信封模式 = opt-in（仅「中段即交付物」的任务用）。首切片**仅预留**：
      // 工具 schema 暴露此参数作字段契约，execute 当前不消费它（结构化信封回收
      // 在 V2.0-中期启用）。见 execute 内注释。
      envelope: { type: 'boolean', description: '预留：结构化信封回收（V2.0 中期启用，当前不生效）' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the child (it does not see this conversation).' }
    },
    output: {
      schema: {
        // D: observability metadata on every result. OneOf covers the
        // background variant (kind/jobId) and the foreground variant (output),
        // both closed and both carrying the effective delegation values.
        // R1: `ignored` was added to ALL three branches (with the shared `preset`
        // / `provider` / `model` / `reasoningEffort` / `profile`), keeping the
        // closed oneOf consistent — assertResultSchemaConsistency(dispatchTool
        // .output.schema) in apply() fires if any 分支 忘补该字段.
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
              profile: { type: 'string' },
              preset: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
              ignored: { type: 'array', items: { type: 'string' } }
            }
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'continuable' },
              subagentId: { type: 'string', required: true },
              profile: { type: 'string' },
              preset: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
              ignored: { type: 'array', items: { type: 'string' } }
            }
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              output: { type: 'string', required: true },
              profile: { type: 'string' },
              preset: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
              ignored: { type: 'array', items: { type: 'string' } }
            }
          }
        ]
      },
      render: (_args, value) => {
        // §8.4: continuable 丢弃 preset 换用与 reasoningEffort —— 渲染行把
        // `ignored` 列表回显出来（`reasoningEffort=<值>(ignored)`，再加 ignored 项
        // 明细），让模型「看见」被丢弃项；background/foreground 无忽略项时该后缀为空。
        const ignored = value.ignored !== undefined && value.ignored.length > 0
          ? `(ignored: ${value.ignored.join(', ')})`
          : '';
        const text = value.kind === 'background'
          ? `[dispatch] background job ${value.jobId} · profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}`
          : value.kind === 'continuable'
            ? `[dispatch] started subagent ${value.subagentId} · profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}`
            : `[dispatch] profile=${value.profile} · preset=${value.preset} · provider=${value.provider} · model=${value.model} · reasoningEffort=${value.reasoningEffort}${ignored}\n\n${value.output}`;
        return [{ type: 'text', text }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('dispatch requires calling agent');
      // Resolve the base profile (side channel), then overlay explicit args.
      const base = args.profile !== undefined ? store.resolveProfile(args.profile) : {};
      const merged = { ...base };
      for (const key of ['preset', 'model', 'provider', 'reasoningEffort', 'persona', 'toolFilter', 'maxTokens', 'maxDepth']) {
        if (args[key] !== undefined) merged[key] = args[key];
      }
      // Pre-check: explicit concrete preset must be in the runtime-derived
      // whitelist (F6); a preset equal to the parent's composed preset is
      // rewritten to 'inherit' (no swap).
      if (typeof merged.preset === 'string' && merged.preset !== 'inherit') {
        const whitelist = new Set(await resolveWhitelist(parent.ctx.get('agentPresets')));
        if (!whitelist.has(merged.preset)) {
          throw new Error(`dispatch: preset "${merged.preset}" is not in the target-preset whitelist`);
        }
        const parentPresets = parent.ctx.get('agentPresets');
        const parentComposed = parentPresets !== undefined ? parentPresets.composedPreset(parent.ctx) : undefined;
        if (merged.preset === parentComposed) merged.preset = 'inherit';
      }
      // F5: cost guard (runtime-derived; hard caps always applied, llm capability
      // gated by allowFailOpen — SPEC §7.3).
      await assertCostGuard(parent, merged, store.getAllowFailOpen(), ctx.logger);
      // D: effective delegation values for observability.
      const meta = {
        profile: args.profile ?? '(inline)',
        preset: merged.preset ?? 'inherit',
        provider: merged.provider ?? parent.options.provider ?? '(parent)',
        model: merged.model ?? parent.options.model ?? '(parent)',
        reasoningEffort: merged.reasoningEffort ?? '(default)'
      };
      const request = {
        label: String(args.prompt ?? '').slice(0, 60),
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        signal: exec.signal,
        profile: merged,
        ...(merged.persona !== undefined ? { persona: merged.persona } : {}),
        ...(merged.toolFilter !== undefined ? { toolFilter: merged.toolFilter } : {}),
        ...(merged.maxDepth !== undefined ? { maxDepth: merged.maxDepth } : {})
      };
      // §8.2 结果回收默认剪枝：在 textFrom(result.output) 之前复用宿主
      // toolResultPruner.pruneContent 预剪。`pruneResultOutput` 每次现取
      // ctx.get('toolResultPruner') 以反映服务就绪状态；pruner 缺失时
      // pruneBlocks 回退为不剪（剪枝是增强、非硬依赖）。envelope 参数虽已在
      // 工具 schema 暴露（预留，V2.0-中期启用结构化信封回收），但 execute
      // **不消费**它——本首切片只实现「剪枝默认」，不做信封注入。
      const pruneResultOutput = (blocks) => pruneBlocks(blocks, ctx.get('toolResultPruner'));
      // Decision-level log: resolved effective delegation inputs, after the
      // cost guard and after request assembly, before dispatch.
      ctx.logger.info('[dsh-subagent-profile] dispatch:', JSON.stringify({
        profile: args.profile ?? '(inline)',
        preset: merged.preset ?? 'inherit',
        provider: merged.provider ?? parent.options.provider ?? '(parent)',
        model: merged.model ?? parent.options.model ?? '(parent)',
        reasoningEffort: merged.reasoningEffort ?? '(default)',
        maxDepth: merged.maxDepth ?? null,
        background: args.run_in_background === true,
        continuable: args.continuable === true
      }));
      // Continuable (durable) path — startContinuable publishes a persistent
      // child and returns its durable id; the official send_message tool drives
      // later turns. Treated first so a caller asking for both background and
      // continuable gets the continuable child.
      if (args.continuable === true) {
        // 安全 P0-b（SPEC §7.1 第 2 条）：provider `start` 的 !enabled 检查只拦
        // `start`，不拦 `startContinuable` —— 这里显式补上。当前 syncTool 会在
        // 禁用时注销 dispatch 工具（间接门），此处是防御性兜底：禁用后
        // dispatch(continuable:true) 必须 fail-loud，不得静默派生子树。
        if (!enabled) {
          throw new Error('dispatch: 插件已禁用（设置 → 子 Agent 方案 重新启用）');
        }
        if (args.run_in_background === true) {
          ctx.logger.warn('[dsh-subagent-profile] dispatch: both continuable and run_in_background are true; continuable takes precedence');
        }
        // 已知降级：continuable 标准路径不支持 preset swap 和 reasoningEffort（subagent 包的 SubagentStartRequest 无 preset 字段、AgentOptions 无 reasoningEffort 字段）
        if (merged.preset !== undefined && merged.preset !== 'inherit') {
          ctx.logger.warn(`[dsh-subagent-profile] continuable mode cannot swap preset; ignoring "${merged.preset}" (child inherits the parent preset)`);
        }
        if (merged.reasoningEffort !== undefined) {
          ctx.logger.warn(`[dsh-subagent-profile] continuable mode cannot set reasoningEffort; ignoring "${merged.reasoningEffort}"`);
        }
        // 安全 P0-b（SPEC §7.1 第 1 条）：预加工 toolFilter 为闭集 allow。continuable
        // 走宿主 applyChildComposition→tools.restrict，prepareContinuable 返回 {}，
        // 插件侧无法重算父∩子交集，故在此把 allow 预加工为闭集传到 request。
        //
        // 假设：continuable 继承父预设（preset swap 被忽略，见上方 warn）⇒
        // 子工具集 ≈ 父工具集，故 父集 − run_code − deny 可安全作为 restrict 的
        // allow。失效：任何导致子工具集与父工具集不一致的宿主行为变化（非仅
        // preset swap——例如未来允许 swap preset、组合不同工具集等），父集都可能
        // 含子集上不存在之工具 → tools.restrict 会抛「未知工具」→ 本缓解自动降级
        // 为 fail-loud（保守安全）——此时必须替换为真交集（父∩子）。
        const parentNames = new Set(parent.ctx.tools.schemas(parent).map((schema) => schema.name));
        const effectiveAllow = computeContinuableAllow(parentNames, merged.toolFilter);
        const hasAgentOptions = merged.provider !== undefined || merged.model !== undefined || merged.maxTokens !== undefined;
        const continuableRequest = {
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...(hasAgentOptions ? { agentOptions: {
            ...(merged.provider !== undefined ? { provider: merged.provider } : {}),
            ...(merged.model !== undefined ? { model: merged.model } : {}),
            ...(merged.maxTokens !== undefined ? { maxTokens: merged.maxTokens } : {})
          } } : {}),
          ...(merged.persona !== undefined ? { persona: merged.persona } : {}),
          // 恒传闭集 allow（覆盖原 merged.toolFilter 透传）；空集在
          // computeContinuableAllow 内 fail-loud。
          toolFilter: { allow: effectiveAllow },
          ...(merged.maxDepth !== undefined ? { maxDepth: merged.maxDepth } : {})
        };
        const { childId } = await ctx.subagents.startContinuable({
          provider: 'profile',
          label: String(args.prompt ?? '').slice(0, 60),
          request: continuableRequest,
          signal: exec.signal
        });
        // Continuable drops the profile's preset swap and reasoningEffort (the
        // child inherits the parent preset), so the observability meta must
        // report what actually took effect, not the requested-but-ignored values.
        // §8.4 可见性修复：`reasoningEffort` 回显**请求值**（经 meta.reasoningEffort，
        // 即 merged.reasoningEffort ?? '(default)'），`preset:'inherit'` 是真实生效值；
        // `ignored` 明确列出被丢弃项，让模型「看见」被忽略的字段。
        return {
          kind: 'continuable',
          subagentId: childId,
          profile: meta.profile,
          preset: 'inherit',
          provider: meta.provider,
          model: meta.model,
          reasoningEffort: meta.reasoningEffort,
          ignored: ['preset', 'reasoningEffort']
        };
      }
      // A: background one-shot (job) path — jobs.start wraps start() with a
      // native AbortController (a Node global in a bundle; the dynamic-plugin
      // sandbox needed the hand-rolled shim instead); still one turn, not
      // continuable.
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs');
        if (jobs === undefined) {
          throw new Error('dispatch: background jobs unavailable (load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs)');
        }
        const jobId = jobs.start({
          kind: 'subagent',
          label: String(args.prompt ?? '').slice(0, 60),
          owner: parent,
          run: () => {
            const controller = new AbortController();
            return {
              cancel: (reason) => controller.abort(reason ?? 'dispatch: background subagent task killed'),
              done: settleStart(ctx.subagents.start('profile', { ...request, signal: controller.signal }), controller.signal, meta, pruneResultOutput)
            };
          }
        });
        return { kind: 'background', jobId, ...meta };
      }
      // Foreground: collect, always release the handle (E: dispose even when
      // run.result rejects), then fail loud on a non-completed stop reason.
      const run = await ctx.subagents.start('profile', request);
      let result;
      try {
        result = await run.result;
      } finally {
        await run.dispose().catch(() => {});
      }
      // F2: a non-'completed' stop reason is a failure; attach the child's
      // partial output text (withPartialText style).
      const failure = stopReasonError(result);
      if (failure !== undefined) throw new Error(withPartialText(failure, result.output));
      return { output: textFrom(pruneResultOutput(result.output)), ...meta };
    }
  });
  // R1（共享规则）lock: the closed oneOf result schema must carry an identical
  // shared meta key set across all three branches. Fires only at apply time; a
  // future meta-field add that forgets one 分支 throws here (once), so the
  // model-side schema never silently rejects a分支.
  assertResultSchemaConsistency(dispatchTool.output.schema);
  // Register the tool only while enabled; unregister it the moment the switch
  // turns off so it disappears from the model's tool list without a restart.
  let disposeTool;
  function syncTool() {
    if (enabled && disposeTool === undefined) {
      disposeTool = ctx.tools.register(dispatchTool);
    } else if (!enabled && disposeTool !== undefined) {
      const dispose = disposeTool;
      disposeTool = undefined;
      dispose();
    }
  }
  syncTool();
  ctx.effect(() => () => {
    if (disposeTool !== undefined) {
      const dispose = disposeTool;
      disposeTool = undefined;
      dispose();
    }
  });
}
