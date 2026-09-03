// lib/core/profiles-query.mjs — profiles_query 工具（派发档案按需下钻）：入参全可选
// （id / tier / provider+model 成对 / 无参全量），未知键由宿主 DSL 默认拒绝（键集闭合
// 断言在 test/profiles-query.test.mjs）。数据源分布：profileDirectoryRows（档案）/
// catalog-cache 快照（官方模型 + efforts，TTL 60s）/ summaries.json（统计，
// mtime+指纹，fail-soft）。官方目录没有的 model 只标「未在册」（advisory，不判失效）；
// 「未授权」联动官方模型选择投影（model-policy）：本会话投影配置了 allowedModels 且档案绑定路由不在
// 其中时追加标注。本工具不复制任何策略逻辑——授权性以官方为准（工具描述首行已指向
// list_subagent_models）。

import { defineTool } from './shims.mjs';
import { profileDirectoryRows, profileStatsFromSummaries } from './profile-directory.mjs';
import { readModelSelectionPolicy } from './model-policy.mjs';
import { readSummaries } from './evolution-advice.mjs';

// 入参 schema：全可选；provider+model 成对约束在 execute 内校验（schema 层无法表达
// 成对）。键集闭合 = 白名单 4 键（与 percall-spec 同口径：多出的键没有接受路径）。
export const PROFILES_QUERY_PARAMETERS = {
  id: { type: 'string', description: '按 id 查单个派发档案明细（其余入参被忽略）' },
  tier: { type: 'string', enum: ['cheap', 'balanced', 'premium'], description: '按成本/深度档位过滤档案' },
  provider: { type: 'string', description: '与 model 成对使用：先查该模型的官方 reasoning efforts，再列出绑定该模型的档案' },
  model: { type: 'string', description: '与 provider 成对使用：官方模型目录中的模型 id' },
};

// 输出 schema：模型可见面只有 text 一行（render 把 text 包成内容块）。
export const PROFILES_QUERY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: '模型可见的查询结果文本' },
  },
};

// 列表行描述截断长度（单档案明细不截断）。
const LIST_DESC_CHARS = 80;

// 档案绑定的 provider/model 路由（两者齐备才绑定）；未绑定返回 null。
export function boundRouteOf(row) {
  const provider = row !== null && typeof row === 'object' && typeof row.provider === 'string' && row.provider !== '' ? row.provider : undefined;
  const model = row !== null && typeof row === 'object' && typeof row.model === 'string' && row.model !== '' ? row.model : undefined;
  return provider !== undefined && model !== undefined ? { provider, model } : null;
}

// 官方状态标注：在册（catalog models 含 provider+model）/ 未在册 / 未绑定。未在册只
// 标不判失效（advisory）。
export function catalogStatusOf(row, models) {
  const route = boundRouteOf(row);
  if (route === null) return '未绑定';
  const listed = Array.isArray(models) && models.some((m) => m !== null && typeof m === 'object' && m.provider === route.provider && m.id === route.model);
  return listed ? '在册' : '未在册';
}

// 未授权标注：投影配置且绑定路由不在 allowedModels → '未授权'；投影未配置或未绑定
// → undefined（不加注）。授权性判定只读官方投影，不复制策略逻辑。
export function unauthorizedMarkOf(row, policy) {
  const route = boundRouteOf(row);
  if (route === null || policy === undefined || policy === null || policy.configured !== true) return undefined;
  const allowed = Array.isArray(policy.allowedModels) && policy.allowedModels.some((r) => r !== null && typeof r === 'object' && r.provider === route.provider && r.model === route.model);
  return allowed ? undefined : '未授权';
}

// efforts 条件式文案：绑定 → 该模型官方 reasoning efforts（目录无数据 → 占位）；
// 未绑定 → 继承父模型、档位以父为准。
export function effortsTextOf(row, effortsByModel) {
  const route = boundRouteOf(row);
  if (route === null) return '继承父模型，档位以父为准';
  const efforts = effortsByModel !== null && typeof effortsByModel === 'object' ? effortsByModel[route.model] : undefined;
  if (!Array.isArray(efforts) || efforts.length === 0) return '（目录无该模型明细）';
  return efforts.map((effort) => (effort !== null && typeof effort === 'object' && typeof effort.id === 'string' ? effort.id : String(effort))).join('/');
}

// 单档案明细（两行：主行 + efforts 行）。stats 为 profileStatsFromSummaries 的
// Map；truncate=true 时描述截断 80 字符 + …（列表口径，单档案明细不截断）。
export function profileDetailLines(row, { stats, models, effortsByModel, policy, truncate = false } = {}) {
  const desc = row !== null && typeof row === 'object' && typeof row.description === 'string' && row.description !== '' ? row.description : '(无描述)';
  const shown = truncate && desc.length > LIST_DESC_CHARS ? `${desc.slice(0, LIST_DESC_CHARS)}…` : desc;
  const route = boundRouteOf(row);
  const binding = route === null ? '继承父' : `${route.provider}/${route.model}`;
  const tier = row !== null && typeof row === 'object' && typeof row.tokenTier === 'string' && row.tokenTier !== '' ? row.tokenTier : '未标注';
  const stat = stats instanceof Map ? stats.get(row?.id) : (stats !== null && typeof stats === 'object' ? stats[row?.id] : undefined);
  const cost = stat !== null && typeof stat === 'object' && typeof stat.avgCost === 'number' ? `平均 ¥${stat.avgCost}` : undefined;
  const rate = stat !== null && typeof stat === 'object' && typeof stat.successRate === 'number'
    ? `成功率 ${stat.successRate}${typeof stat.n === 'number' ? ` (N=${stat.n})` : ''}`
    : undefined;
  const status = catalogStatusOf(row, models);
  const unauthorized = unauthorizedMarkOf(row, policy);
  const meta = [binding, `tier ${tier}`, cost, rate, `官方状态:${status}${unauthorized !== undefined ? `·${unauthorized}` : ''}`].filter((part) => part !== undefined).join(' · ');
  return [`${row?.id}: ${shown} — ${meta}`, `· efforts: ${effortsTextOf(row, effortsByModel)}`];
}

// 单次查询组装（纯函数）：id 单档案 > tier 过滤 > provider+model 成对 > 无参全量。
// provider/model 只传其一 → fail-loud（成对约束）。
export function buildProfilesQueryText({ args, rows, stats, models, effortsByModel, policy }) {
  const hasProvider = typeof args?.provider === 'string' && args.provider !== '';
  const hasModel = typeof args?.model === 'string' && args.model !== '';
  if (hasProvider !== hasModel) throw new Error('profiles_query: provider 与 model 须成对提供');
  const details = (row, truncate = false) => profileDetailLines(row, { stats, models, effortsByModel, policy, truncate });
  if (typeof args?.id === 'string' && args.id !== '') {
    const row = rows.find((r) => r !== null && typeof r === 'object' && r.id === args.id);
    if (row === undefined) return { text: `未找到 profile "${args.id}"。可用 id：${rows.map((r) => r?.id).join('、') || '（暂无）'}` };
    return { text: details(row).join('\n') };
  }
  if (typeof args?.tier === 'string' && args.tier !== '') {
    const tierRows = rows.filter((r) => r !== null && typeof r === 'object' && r.tokenTier === args.tier);
    if (tierRows.length === 0) return { text: `无 tier=${args.tier} 的方案` };
    const lines = tierRows.flatMap((row) => details(row, true));
    return { text: `tier=${args.tier} 的方案（${tierRows.length}）：\n${lines.join('\n')}` };
  }
  if (hasModel) {
    const listed = Array.isArray(models) && models.some((m) => m !== null && typeof m === 'object' && m.provider === args.provider && m.id === args.model);
    const rawEfforts = effortsByModel !== null && typeof effortsByModel === 'object' ? effortsByModel[args.model] : undefined;
    const modelEfforts = Array.isArray(rawEfforts) && rawEfforts.length > 0
      ? rawEfforts.map((effort) => (effort !== null && typeof effort === 'object' && typeof effort.id === 'string' ? effort.id : String(effort))).join('/')
      : undefined;
    const header = `模型 ${args.provider}/${args.model} 官方 reasoning efforts：${modelEfforts ?? '（目录无该模型明细）'}`;
    const bound = rows.filter((r) => {
      const route = boundRouteOf(r);
      return route !== null && route.provider === args.provider && route.model === args.model;
    });
    if (bound.length === 0) return { text: `${header}\n无绑定该模型的方案${listed ? '' : '（该模型不在官方目录，未在册）'}` };
    const lines = bound.flatMap((row) => details(row, true));
    return { text: `${header}\n${lines.join('\n')}` };
  }
  if (rows.length === 0) return { text: '暂无可用派发档案（可在设置页「子 Agent 方案」创建）' };
  const lines = rows.flatMap((row) => details(row, true));
  return { text: `派发档案目录（${rows.length}）：\n${lines.join('\n')}` };
}

// 查询主体：catalog 快照（含官方 efforts）→ summaries 统计（fail-soft）→ 官方
// 模型选择投影（未授权标注）→ 纯函数组装文本。
async function runProfilesQuery(args, exec, deps) {
  const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined;
  const snapshot = await deps.catalog.getSnapshot(typeof agent?.ctx?.get === 'function' ? agent.ctx.get('llm') : undefined);
  const models = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.models) ? snapshot.models : [];
  const effortsByModel = snapshot !== null && typeof snapshot === 'object' && snapshot.efforts !== null && typeof snapshot.efforts === 'object' ? snapshot.efforts : {};
  let summaries = null;
  try { summaries = readSummaries(deps.summariesFile, deps.logger, { onLoss: deps.onLoss }); } catch { /* 统计只增强，查询不因统计失败而失败 */ }
  const stats = profileStatsFromSummaries(deps.store, summaries);
  const policy = readModelSelectionPolicy(agent?.ctx, agent?.session);
  return buildProfilesQueryText({ args, rows: profileDirectoryRows(deps.store), stats, models, effortsByModel, policy });
}

// 工厂返回 { syncTool, dispose }：与 dispatch 同款 syncTool 机制（随 enabled 开关
// 注册/注销，工具列表自动可见，不依赖静态段）。
export function createProfilesQueryTool({ register, store, catalog, summariesFile, onLoss, logger, getEnabled }) {
  const deps = { store, catalog, summariesFile, onLoss, logger, getEnabled };
  const tool = defineTool({
    name: 'profiles_query',
    description: '按方案查询派发档案与明细（值不值：描述/档位/统计）；授权路由（能不能用）请用官方 list_subagent_models。入参全可选：id 查单个档案；tier 按档位过滤；provider+model 成对查询（先查官方 efforts 再列绑定方案）；无参返回全量目录。',
    parameters: PROFILES_QUERY_PARAMETERS,
    output: {
      schema: PROFILES_QUERY_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => runProfilesQuery(args, exec, deps),
  });
  let disposeTool;
  function syncTool() {
    if (getEnabled() && disposeTool === undefined) {
      disposeTool = register(tool);
    } else if (!getEnabled() && disposeTool !== undefined) {
      const dispose = disposeTool;
      disposeTool = undefined;
      if (typeof dispose === 'function') dispose();
    }
  }
  syncTool();
  return {
    syncTool,
    dispose() {
      if (disposeTool !== undefined) {
        const dispose = disposeTool;
        disposeTool = undefined;
        if (typeof dispose === 'function') dispose();
      }
    }
  };
}
