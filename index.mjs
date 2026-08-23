// index.mjs — dsh-subagent-profile 宿主侧正式插件 bundle（只做装配）。
// 源自原型动态插件 `code.host` 主体；宿主导入面（registerTool/defineTool/
// handle）收敛在 lib/core/shims.mjs，装配块按模块拆分驻留 lib/core/（catalog /
// presets-sync / profiles-store / cost-guard / whitelist / intersection /
// delegation / pure / shims / http-routes / profile-provider / dispatch-tool /
// dispatch-guard）。
// apply 的装配辅助函数（syncBundledPresetsToHome / provideProfileService /
// registerSystemPromptSections / registerSettingsRoutes）保持 section 文本与
// 门控逐字不变；`enabled` 始终经 getter 注入，门控读取当前值。

import { readdirSync, renameSync, rmSync } from 'node:fs';
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
import { createBackgroundLedger } from './lib/core/background-ledger.mjs';
import { createDraftsStore } from './lib/core/drafts-store.mjs';
import { sanitizeProfile } from './lib/core/pure.mjs';
import { createEscapeStore, recordEscapeAllowProvider } from './lib/core/escape.mjs';
import { resolveWhitelist, FALLBACK_WHITELIST } from './lib/core/whitelist.mjs';
import { profileDirectoryRows, profileStatsFromSummaries, applyProfileStats } from './lib/core/profile-directory.mjs';
import { buildAdviceText, refreshSummaries, readSummaries } from './lib/core/evolution-summary.mjs';

export const name = 'dsh-subagent-profile';
export const inject = ['subagents', 'tools', 'agents'];

// 自装 bundled 的 "orchestrator" agent 预设到 DSH agent-presets 根，让该模式
// 无需手动复制就出现在新建会话选择器里（与官方 dsh-liangshen 自安装相同）。
// 幂等：字节一致的树跳过；bundle 变更重写预设——即预期的升级路径。fail-soft：
// 写入被拒时 dispatch 工具与设置页照常工作。
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

// 卸载清理：把本插件持久化的 3 个数据文件 + 自装的 orchestrator 预设目录改名备份
// （只动本插件拥有的 orchestrator 目录，不碰 .agent-presets 下其它插件/用户的目录）。
// 改为「改名到 <name>.removed-<ts>」而非 rmSync 删除：ctx.effect 的清理器在禁用/热
// 重载/进程退出时都可能触发，硬删除会静默丢失用户 profiles/state/失败台账（S1）。
// 备份保留可恢复副本；规范路径被清空，重装/重启后经 syncBundledPresetsToHome 重新
// 同步预设、数据文件按需重新生成。fail-soft：改名失败不抛（卸载不应因清理失败而阻断）。
function removeOwnedData(home) {
  const stamp = Date.now();
  for (const file of ['subagent-profiles.json', 'subagent-profiles.state.json', 'subagent-profiles.failed-traces.json']) {
    try { renameSync(join(home, file), join(home, `${file}.removed-${stamp}`)); } catch { /* 源不存在（正常首启）等：best effort */ }
  }
  try { renameSync(join(home, '.agent-presets', 'orchestrator'), join(home, '.agent-presets', `orchestrator.removed-${stamp}`)); } catch { /* best effort */ }
}

// 启动清理 S1 改名备份残留：.removed-<ts> 备份在下次正常启动后已无保留价值（数据
// 文件按需重新生成），启动时清掉防积累（热重载/禁用反复触发 effect 会持续产生新
// 备份）。只清本插件前缀（subagent-profiles.* 与 orchestrator.removed-*），不碰其它
// 文件；卸载后用户手动改回原名的场景不受影响（改回后无 .removed 残留）。fail-soft。
function cleanRemovedBackups(home) {
  for (const dir of [home, join(home, '.agent-presets')]) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      try {
        if (name.startsWith('subagent-profiles.') && name.includes('.removed-')) {
          rmSync(join(dir, name), { force: true });
        } else if (name.startsWith('orchestrator.removed-')) {
          rmSync(join(dir, name), { recursive: true, force: true });
        }
      } catch { /* best effort */ }
    }
  }
}

// 卸载接线：注销 dispatch 工具（若仍注册）+ 清空失败台账 + 级联取消在途派发 +
// 清空守卫记账 + 删本插件数据文件与自装预设目录。另挂钩宿主 agent/disposed
// （Agent 注册 fiber 卸载时发射）：父会话逻辑结束时按父释放并发/token 记账，
// 防配额随会话累积驻留。
function registerTeardown(ctx, dispatch, ledger, guard, home, backgroundLedger) {
  ctx.effect(() => dispatch.dispose);
  ctx.effect(() => ledger.clear);
  ctx.effect(() => backgroundLedger.clear);
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

// subagent-profiles service：包在 store 的 per-apply profiles Map 之上，对外只暴露
// 枚举/扩展注册表的窄接口，不触碰内部结构。
function provideProfileService(ctx, store) {
  ctx.provide('subagent-profiles', {
    register(profile) {
      if (!profile || typeof profile.id !== 'string' || profile.id.length === 0) {
        throw new Error('subagent-profiles: profile id 必须为非空字符串');
      }
      if (store.profiles.has(profile.id)) {
        throw new Error(`subagent-profiles: profile "${profile.id}" 已注册（id 需唯一）`);
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
function profileSectionText(store, gate, context, summaries) {
  if (!gate(context)) return '';
  const rows = applyProfileStats(profileDirectoryRows(store), profileStatsFromSummaries(store, summaries));
  if (rows.length === 0) return '';
  const lines = rows.map((p) => {
    const desc = p.description.length > 0 ? `"${p.description}"` : '(无描述)';
    const meta = [];
    if (p.preset !== undefined) meta.push(`preset: ${p.preset}`);
    else if (p.model !== undefined) meta.push(`model: ${p.model}`);
    if (p.tokenTier !== undefined) meta.push(`tier: ${p.tokenTier}`);
    if (p.avgCost !== undefined) meta.push(`平均 ${p.avgCost} 元/次`);
    if (p.successRate !== undefined) meta.push(`成功率 ${p.successRate}${p.n !== undefined ? ` (N=${p.n})` : ''}`);
    return `- ${p.id}: ${desc}${meta.length > 0 ? ` (${meta.join(' · ')})` : ''}`;
  });
  const note = '- 选择方案时先匹配任务复杂度与方案描述的能力边界，成本只在能力都胜任的方案之间比较——复杂任务不得为省 token 改用能力不足的便宜方案。\n- 别把 1-2 步即可自查/可搜完的小事委派出去 —— 几分钟内能自查完的直接做。';
  return `Available dispatch profiles (dispatch.profile):\n${lines.join('\n')}\n${note}`;
}

// orchestrator:mode section 文本（逐字保留；与 profiles 同门控）。
const ORCHESTRATOR_MODE_TEXT = '本机已安装 dsh-subagent-profile 插件的「编排者模式」agent preset：新建会话的预设选择器中可选「编排者模式」。该模式把 Agent 定位为主协调者——拆解任务后按场景用 dispatch（内置 swap-standard=标准编码、researcher=调研检索，可在「子 Agent 方案」设置页自定义）与 subagent/subagent_fork/workflow 委派给子 Agent，再整合结果。preset 文件由插件维护于 ~/.dsh/.agent-presets，安装/升级时自动同步；用户提到「编排者模式 / orchestrator / 主协调模式」时即指本预设，请据此协作。';

// 建议注入候选池：system-trust 白名单（agentPresets 可选；解析失败回退内置
// 回退名单——fail-loud 检查在建议生成路径进行，不在此处）。刻意不叠加逃生舱放行
// 集：只读建议不享受逃生舱（逃生舱仅放行「其余三道闸全过」的显式派发，不扩建议池）。
async function resolveAdviceWhitelist(ctx) {
  try {
    return new Set(await resolveWhitelist(ctx.get('agentPresets')));
  } catch {
    return new Set(FALLBACK_WHITELIST);
  }
}

// 目录 section：渲染可用方案（systemPrompt 的 section text 接受函数，官方
// tool-subagent 即此用法）。门控注意：`enabled` 必须经 getter 实时读取，
// 使 /set-enabled 切换立即生效、无需重启。
function registerSystemPromptSections(ctx, store, getEnabled, getEvolutionAdvice, adviceEnv) {
  const pluginSystemPrompt = ctx.get('systemPrompt');
  if (pluginSystemPrompt === undefined) return;
  const gate = (context) => sectionGatePasses(ctx, getEnabled, context);
  pluginSystemPrompt.section({
    name: 'dispatch:profiles',
    order: 116.5,
    text: (context) => {
      let summaries = null;
      try { summaries = readSummaries(adviceEnv.summariesFile, adviceEnv.logger); } catch { /* 统计只增强，不影响目录注入 */ }
      return profileSectionText(store, gate, context, summaries);
    },
  });
  // 宣告自装的 orchestrator 预设，让当前 agent 知道该模式存在、可引导用户使用。
  // 门控与 profiles 段相同——只有可派发的 agent 才看得到。
  pluginSystemPrompt.section({
    name: 'orchestrator:mode',
    order: 117,
    text: (context) => (gate(context) ? ORCHESTRATOR_MODE_TEXT : ''),
  });
  // 只读建议段：门控 = orchestrator（sectionGatePasses）+ evolutionAdvice 开关。
  // 只进父 Agent（复用同一门控）、默认关、只含确定性聚合数字与建议文案，不含派生原文。
  // 生成异常 try/catch 兜底：fail-loud 检查（非 system 候选）落 warn 日志但绝不
  // 阻断每次提示装配——损坏/手改的 summaries 不得让 orchestrator 会话无法启动。
  pluginSystemPrompt.section({
    name: 'evolution:advice',
    order: 116.8,
    text: (context) => {
      if (!getEvolutionAdvice() || !gate(context)) return '';
      try {
        return buildAdviceText(adviceEnv);
      } catch (error) {
        adviceEnv.logger.warn(`[dsh-subagent-profile] evolution:advice 生成失败，本次不注入：${error instanceof Error ? error.message : String(error)}`);
        return '';
      }
    },
  });
}

// Client 设置 UI 的 HTTP loopback 路由（webServer.register ↔ client fetch，纯 JSON）。
// 路由本体在 lib/core/http-routes.mjs（上文已 import）；这里只注入 per-apply 依赖。
// webServer 可选——无头部署保留 dispatch 工具、只丢设置页。webServer 的激活
// （listen）是异步的，可能晚于本插件 inject 依赖解析完成，故在等它的 inject
// 子 scope 内注册（apply 时 ctx.get 会读到 undefined）。
function registerSettingsRoutes(ctx, store, getEnabled, setEnabled, syncTool, catalog, ledger, backgroundLedger, draftsStore, applyDraft, getAudit, getEvolutionAdvice, setEvolutionAdvice, getEscapeEnabled, setEscapeEnabled, escape, refreshAdvice, summariesFile) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(createHttpRoutes({
      webServer: scope.webServer,
      store,
      getEnabled,
      setEnabled,
      syncTool,
      catalog,
      ledger,
      backgroundLedger,
      draftsStore,
      applyDraft,
      getAudit,
      getEvolutionAdvice,
      setEvolutionAdvice,
      getEscapeEnabled,
      setEscapeEnabled,
      escape,
      refreshAdvice,
      summariesFile,
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

// 逃生舱装配：放行集 store + 开关态（state.json 持久化）+ 访问器。开关态经对象字段
// 可变（/set-escape 改写），getEscapeSet 开关关时恒空数组（零叠加、零放行审计）。
function setupEscape(ctx, store, evoLedger, home) {
  const escape = createEscapeStore({ dshHome: home, logger: ctx.logger, onGovernanceFailure: () => evoLedger.markGovernanceFailure() });
  const state = { escapeEnabled: store.loadEscapeEnabled() };
  return {
    escape,
    getEscapeSet: () => (state.escapeEnabled ? escape.list() : []),
    getEscapeEnabled: () => state.escapeEnabled,
    setEscapeEnabled: (next) => { state.escapeEnabled = next; },
    recordEscapeAllowProvider: (parent, preset) => recordEscapeAllowProvider(evoLedger, parent, preset),
  };
}

// `dispatch` 工具装配（defineTool + execute + syncTool）。须在 HTTP inject 之前
// 构造，使 createHttpRoutes 能拿 dispatch.syncTool 供 /set-enabled 注册/注销。
function createDispatch(ctx, store, catalog, ledger, guard, evoLedger, backgroundLedger, getEscapeSet, getEnabled, getEvolutionAdvice) {
  return createDispatchTool({
    register: (tool) => ctx.tools.register(tool),
    store,
    getEnabled,
    getService: (name) => ctx.get(name),
    logger: ctx.logger,
    subagents: ctx.subagents,
    catalog,
    ledger,
    guard,
    evoLedger,
    backgroundLedger,
    getEscapeSet,
    getEvolutionAdvice,
  });
}

// auto-profile S1 落库前的三道闸（Task 43，host 侧可验证部分）：
// ① 白名单闸（非 system-trust 预设需逃生舱放行）；② 目录/硬上限闸（sanitize + catalog）；
// ③ 工具交集闸：插件侧无法复算父∩子，故仅校验 toolFilter 形状，真实交集仍由派发时宿主收窄。
async function applyDraftProfile({ ctx, store, catalog, getEscapeSet, evoLedger, draft }) {
  if (draft === null || typeof draft !== 'object') throw new Error('draft 不存在');
  const config = draft.config !== null && typeof draft.config === 'object' ? draft.config : {};
  const profile = { ...config, name: draft.name, description: draft.description };
  const { clean, warnings } = sanitizeProfile(profile, { strict: true });
  if (warnings.length > 0) throw new Error(warnings.map((w) => w.field + '：' + w.reason).join('；'));
  if (typeof clean.id !== 'string' || clean.id === '') throw new Error('draft 缺少 profile id');
  if (store.profiles.has(clean.id)) throw new Error('profile ' + clean.id + ' 已存在（请先删除或改名）');
  const whitelist = new Set(await resolveWhitelist(ctx.get('agentPresets'), getEscapeSet()));
  if (typeof clean.preset === 'string' && clean.preset !== '' && clean.preset !== 'inherit' && !whitelist.has(clean.preset)) {
    throw new Error('目标预设 ' + clean.preset + ' 不在 system-trust 白名单（可开启逃生舱并添加该预设后重试）');
  }
  const snapshot = await catalog.getSnapshot();
  if (typeof clean.model === 'string' && clean.model !== '' && !snapshot.models.some((m) => m && m.id === clean.model)) {
    throw new Error('模型 ' + clean.model + ' 不在当前模型目录');
  }
  if (typeof clean.provider === 'string' && clean.provider !== '' && !snapshot.models.some((m) => m && m.provider === clean.provider)) {
    throw new Error('提供方 ' + clean.provider + ' 不在当前模型目录');
  }
  store.profiles.set(clean.id, { ...clean, persisted: true });
  const persisted = store.persistProfiles();
  evoLedger.recordGovernanceAudit({ kind: 'draft-apply', profileId: clean.id, source: typeof draft.source === 'string' ? draft.source : 'human' });
  return { id: clean.id, persisted: persisted.persisted };
}

export async function apply(ctx) {
  const home = dshHome();
  // 启动清理：上个生命周期留下的 .removed-* 备份残留（S1 改名的副产物）。
  cleanRemovedBackups(home);
  // 派发台账 + 审计分级须在 store 之前构造：store 的治理审计钩子指向其 markGovernanceFailure。
  const evoLedger = createEvolutionLedger({ dshHome: home, pluginVersion: readPluginVersion(), warn: (message) => ctx.logger.warn(`[dsh-subagent-profile] ${message}`) });
  const store = createProfileStore({ dshHome: home, logger: ctx.logger, onGovernanceFailure: () => evoLedger.markGovernanceFailure() });
  const escapeCtl = setupEscape(ctx, store, evoLedger, home);
  let enabled = store.loadEnabled();
  let evolutionAdvice = store.loadEvolutionAdvice();
  store.loadProfiles();
  // 自装 bundled 的 orchestrator 预设（幂等、fail-soft）。
  syncBundledPresetsToHome(ctx);
  const catalog = createSharedCatalog(ctx);
  const ledger = createFailureLedger({ warn: (message) => ctx.logger.warn(`[dsh-subagent-profile] ${message}`), stateFile: join(home, 'subagent-profiles.failed-traces.json') });
  const guard = createDispatchGuard({ warn: (message) => ctx.logger.warn(`[dsh-subagent-profile] ${message}`) });
  const backgroundLedger = createBackgroundLedger({ warn: (message) => ctx.logger.warn(`[dsh-subagent-profile] ${message}`) });
  const draftsStore = createDraftsStore({ dshHome: home, onGovernanceFailure: () => evoLedger.markGovernanceFailure() });
  const dispatch = createDispatch(ctx, store, catalog, ledger, guard, evoLedger, backgroundLedger, escapeCtl.getEscapeSet, () => enabled, () => evolutionAdvice);
  provideProfileService(ctx, store);
  const adviceWhitelist = await resolveAdviceWhitelist(ctx);
  const adviceEnv = { summariesFile: join(home, 'subagent-evolution', 'summaries.json'), dispatchFile: join(home, 'subagent-evolution', 'dispatch.jsonl'), whitelist: adviceWhitelist, logger: ctx.logger };
  // 生产聚合触发点（T1 修复）：/options/refresh 手动刷新时重算 summaries.json，让
  // evolution:advice 有初始生成路径（原先 computeSummaries/writeSummaries 只被测试调用）。
  const refreshAdvice = () => refreshSummaries({
    dispatchFile: join(home, 'subagent-evolution', 'dispatch.jsonl'),
    summariesFile: join(home, 'subagent-evolution', 'summaries.json'),
    logger: ctx.logger,
  });
  registerSystemPromptSections(ctx, store, () => enabled, () => evolutionAdvice, adviceEnv);
  const disposeProvider = createProfileProvider({ subagents: ctx.subagents, store, getEnabled: () => enabled, logger: ctx.logger, catalog, getEscapeSet: escapeCtl.getEscapeSet, recordEscapeAllowProvider: escapeCtl.recordEscapeAllowProvider });
  if (typeof disposeProvider === 'function') ctx.effect(() => disposeProvider);
  const applyDraft = (draft) => applyDraftProfile({ ctx, store, catalog, getEscapeSet: escapeCtl.getEscapeSet, evoLedger, draft });
  // Client 设置 UI 的 HTTP loopback 路由 —— lib/core/http-routes.mjs。
  registerSettingsRoutes(ctx, store, () => enabled, (next) => { enabled = next; }, dispatch.syncTool, catalog, ledger, backgroundLedger, draftsStore, applyDraft, () => evoLedger.auditState(), () => evolutionAdvice, (next) => { evolutionAdvice = next; }, escapeCtl.getEscapeEnabled, escapeCtl.setEscapeEnabled, escapeCtl.escape, refreshAdvice, join(home, 'subagent-evolution', 'summaries.json'));
  registerTeardown(ctx, dispatch, ledger, guard, home, backgroundLedger, draftsStore);
}
