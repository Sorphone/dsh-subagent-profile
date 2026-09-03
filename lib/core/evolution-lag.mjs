// lib/core/evolution-lag.mjs — 防振荡域（滞后计数 + 回滚冷却 + 观察期联动判据）。
// 滞后 N：同 (profile_key, axis, direction) 连续 N 次同方向建议才放行候选生成
// （N=2 初值，待实测后校准）；与建议链 10min cooldown 并存——cooldown 优先抑制，
// 被抑制的建议不计入连续次数。回滚后冷却：rolled_back 资产进同键冷却，冷却期内
// 不再产生同方向候选（闭环有界：同键 apply→rollback 往返最多 1 次进入冷却）。
// 观察期联动：观察期内（proposed + 金丝雀未终）同键禁止换代与重生成候选；无
// canary 字段的旧资产不阻断（保持既有「重新生成候选」通道）。
// 本域纯函数 + 注入保存：streak 缓存驻内存，落盘由装配层注入 save（fail-soft）。

// 滞后 N：连续同方向建议次数门槛（初值，待实测后校准）。
export const LAG_N = 2;
// 回滚后同键冷却时长（与建议链 cooldown 同值）。
export const ROLLBACK_COOLDOWN_MS = 10 * 60 * 1000;

// 建议方向 → 资产方向（down/up 与候选资产同口径）。
export function directionOf(item) {
  return item !== null && typeof item === 'object' && item.suggestion === '升' ? 'up' : 'down';
}

// 建议方向 → 资产轴（capability/budget）。
export function axisOf(item) {
  return item !== null && typeof item === 'object' && item.suggestion === '升' ? 'budget' : 'capability';
}

// 观察期是否进行中：proposed + 金丝雀未终且未因人工编辑失效。verdict 为 applied /
// aborted-human-edit 或资产 invalid 时视为已终；regress 等待人工回滚期间仍阻断
// （换代会销毁回滚建议依据，须先回滚或人工编辑）。
export function observationPeriodActive(asset) {
  if (asset === null || typeof asset !== 'object' || asset.state !== 'proposed' || asset.invalid === true) return false;
  const canary = asset.canary;
  if (canary === null || typeof canary !== 'object') return false;
  return canary.verdict !== 'applied' && canary.verdict !== 'aborted-human-edit';
}

// 资产列表（完整资产）中是否存在同键观察期资产。
export function observationPeriodBlocked(assetList, profileKey) {
  return assetList.some((a) => a !== null && typeof a === 'object' && a.profile_key === profileKey && observationPeriodActive(a));
}

// 决议后冷却是否生效：同键同方向 rolled_back 资产（回滚决议）或带 cooldown_until
// 的 applied 资产（显式保留决议）在冷却期内抑制候选生成——两种决议都是闭环终点，
// 冷却口径一致（有界性：同键 apply→rollback 往返最多 1 次进入冷却）。
export function rollbackCooldownBlocks(assetList, profileKey, direction, now, cooldownMs = ROLLBACK_COOLDOWN_MS) {
  return assetList.some((a) => a !== null && typeof a === 'object' && a.profile_key === profileKey && a.direction === direction
    && ((a.state === 'rolled_back' && Number.isFinite(a.rollback_at) && now - a.rollback_at < cooldownMs)
      || (a.state === 'applied' && Number.isFinite(a.cooldown_until) && now < a.cooldown_until)));
}

// streak 键：身份键 + 轴 + 方向（连续同方向计数按此聚合）。
function streakKeyOf(profileKey, axis, direction) {
  return `${profileKey}\u0000${axis}\u0000${direction}`;
}

// 连续同方向建议计数：缓存未命中时读 summaries 里上次落盘的 streak（重启续数），
// 方向翻转重置为 1；计数封顶 LAG_N（防无限增长）。save 注入为批量落盘（fail-soft）。
export function bumpStreak(streaks, item, summaries, now) {
  const profileKey = item.profileKey;
  const axis = axisOf(item);
  const direction = directionOf(item);
  const key = streakKeyOf(profileKey, axis, direction);
  let prev = streaks.cache.get(key);
  if (prev === undefined) {
    const l1 = summaries !== null && typeof summaries === 'object' && summaries.l1 !== null && typeof summaries.l1 === 'object' ? summaries.l1 : {};
    const seeded = l1[profileKey]?.streak;
    prev = seeded !== null && typeof seeded === 'object' && seeded.axis === axis && seeded.direction === direction ? seeded : null;
  }
  const count = prev !== null && typeof prev === 'object' && Number.isFinite(prev.count) ? Math.min(LAG_N, prev.count + 1) : 1;
  const next = { profileKey, axis, direction, count, last_ts: now };
  streaks.cache.set(key, next);
  try { streaks.save([next]); } catch { /* 落盘失败不阻断生成（fail-soft） */ }
  return count;
}

// streak 缓存工厂：save 注入落盘（装配层写回 summaries.json）；缓存驻内存供
// 同进程连续轮次复用。
export function createLagStreaks({ save = () => {} } = {}) {
  return { cache: new Map(), save };
}
