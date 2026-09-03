// lib/core/model-policy.mjs — 官方子代理模型选择投影（subagentModelSelectionPolicy）
// 的读取与生效路由断言。与官方工具链同源同 key（key 字符串照抄官方投影定义），
// 无 @deepseek-ai 依赖，可被 bare-import 单测直接 import。
//
// 读取语义（与官方一致）：
//   * sessionProjections 服务缺失 / stateOf 不可用 / 投影值 undefined 或 null
//     （key 已注册但本会话未固化策略，官方视同未配置）→ { configured:false }，
//     跳过、不抛错——插件行为与 0.4.0 完全一致。
//   * 投影值为数组 → 形状校验（照官方 assertAllowedModelRoutes：数组、每项
//     provider/model 为非空字符串、无重复路由、至少一条）→ 畸形 fail-loud，
//     官方格式变更不得静默失效。
//
// 生效路由判定：判定输入是 per-call > profile > parent 解析链完成后的最终
// provider/model（含继承带出的模型），与 allowedModels 精确成对匹配。

const PROJECTION_SERVICE = 'sessionProjections';
const POLICY_KEY = 'subagentModelSelectionPolicy';

// 三层中文错误文案（定稿）：第一层说清越界事实与白名单，第二层说明与官方通道
// 同策略，第三层给出行动路径。缺省侧（parent 未暴露路由）以 '(parent)' 占位。
export function officialModelRejectMessage(provider, model, allowedModels) {
  const shown = (value) => (typeof value === 'string' && value.length > 0 ? value : '(parent)');
  const allowed = allowedModels.map((route) => `${route.provider}/${route.model}`).join('、');
  return [
    `dispatch: 模型 ${shown(provider)}/${shown(model)} 不在本会话允许的子代理模型白名单内（允许：${allowed}）。`,
    '官方在其工具链执行同一策略，本插件同步执行，以保证两通道一致。',
    '请改用允许的模型/方案，或在官方设置更新模型选择（本会话策略已固定，新会话生效）。',
  ].join('\n');
}

// 形状校验：照官方 assertAllowedModelRoutes 语义（非空 provider/model 字符串、
// 无重复路由），另按官方 stateSchema 的 min(1) 拒绝空数组。畸形即 fail-loud。
function validateRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('dispatch: 官方子代理模型选择投影形状不符（须为非空路由数组）');
  }
  const seen = new Set();
  for (const candidate of routes) {
    if (
      candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.provider !== 'string' || candidate.provider.length === 0
      || typeof candidate.model !== 'string' || candidate.model.length === 0
    ) {
      throw new Error('dispatch: 官方子代理模型选择投影形状不符（每项须为 provider/model 非空字符串）');
    }
    const key = `${candidate.provider}\0${candidate.model}`;
    if (seen.has(key)) {
      throw new Error(`dispatch: 官方子代理模型选择投影形状不符（路由 "${candidate.provider}/${candidate.model}" 重复）`);
    }
    seen.add(key);
  }
}

// 读取官方模型选择投影。任何读取失败路径（ctx / 服务 / stateOf 缺失）与未固化
// 状态（undefined / null）统一回退 { configured:false }（跳过语义）；投影存在则
// 校验形状后返回路由表副本（返回值不得被调用方改写共享）。
export function readModelSelectionPolicy(ctx, session) {
  const projections = typeof ctx?.get === 'function' ? ctx.get(PROJECTION_SERVICE) : undefined;
  const raw = projections !== null && typeof projections?.stateOf === 'function'
    ? projections.stateOf(session, POLICY_KEY)
    : undefined;
  if (raw === undefined || raw === null) return { configured: false, enabled: false, allowedModels: [] };
  validateRoutes(raw);
  return {
    configured: true,
    enabled: true,
    allowedModels: raw.map((route) => ({ provider: route.provider, model: route.model })),
  };
}

// 生效路由断言：policy 未配置恒通过；否则 provider/model 与 allowedModels 精确
// 成对匹配，不匹配 throw 三层中文错误（留痕与审计由调用方闸层负责）。
export function assertOfficialModelRoute(policy, provider, model) {
  if (policy === undefined || policy.configured !== true) return;
  const allowed = policy.allowedModels.some((route) => route.provider === provider && route.model === model);
  if (!allowed) throw new Error(officialModelRejectMessage(provider, model, policy.allowedModels));
}

// 官方模型选择可见性行（dispatch:profiles 静态段 note 追加）：投影存在（已启用）
// 时列出官方允许清单；投影缺失（未启用）给「无官方发现工具」与 profiles_query
// 授权路由引导。读取异常（形状校验 throw）fail-soft：debug 日志后按未启用展示，
// 绝不影响 profiles 目录段本身。
export function officialModelSelectionLine(ctx, context, logger) {
  try {
    const session = context?.agent?.session;
    const policy = readModelSelectionPolicy(ctx, session);
    if (policy.configured === true) {
      const allowed = policy.allowedModels.map((route) => `${route.provider}/${route.model}`).join('、');
      return `官方子代理模型选择：已启用（允许：${allowed}）`;
    }
  } catch (error) {
    if (logger !== undefined && typeof logger.debug === 'function') {
      logger.debug('[dsh-subagent-profile] 官方模型选择投影读取失败，按未启用提示：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  return '官方子代理模型选择：未启用（无官方发现工具；授权路由请用 profiles_query 查看在册状态）';
}

// dispatch:profiles 段包装：目录文本非空时追加官方模型选择可见性行。静态段辅助
// 驻留 lib/core，index.mjs 装配不承载新增文案（行门）。
export function appendOfficialVisibilityLine(baseText, ctx, context, logger) {
  if (typeof baseText !== 'string' || baseText === '') return '';
  return baseText + '\n' + officialModelSelectionLine(ctx, context, logger);
}
