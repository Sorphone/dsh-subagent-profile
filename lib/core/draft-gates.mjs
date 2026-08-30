// lib/core/draft-gates.mjs — auto-profile S1 draft 落库前的闸评估。
// 与派发守卫闸同源（形状/白名单/目录），但不落库、不 throw——只产出结构化 checks
// 供 /draft/preview 与应用复用。依赖注入：ctx / catalog 由调用方传入；store 只读
// profiles Map 判断 id 冲突。

import { sanitizeProfile } from './pure.mjs';
import { resolveWhitelist } from './whitelist.mjs';

// 评估一个 draft：sanitize（形状/硬上限）→ id 冲突 → 白名单 → 目录。checks 每项
// 为 { name, verdict: 'pass'|'fail', reason? }；ok = 全部 pass。任一闸 fail 时 clean
// 仍返回（sanitize 归一后的形态），调用方可用其展示「将被写入的生效值」。
export async function assessDraftProfile({ ctx, store, catalog, getEscapeSet, draft }) {
  if (draft === null || typeof draft !== 'object') {
    return { ok: false, checks: [{ name: 'draft', verdict: 'fail', reason: 'draft 不存在' }], clean: null };
  }
  const config = draft.config !== null && typeof draft.config === 'object' ? draft.config : {};
  const profile = { ...config, name: draft.name, description: draft.description };
  const { clean, warnings } = sanitizeProfile(profile, { strict: true });
  const checks = [];
  checks.push(warnings.length > 0
    ? { name: 'sanitize', verdict: 'fail', reason: warnings.map((w) => w.field + '：' + w.reason).join('；') }
    : { name: 'sanitize', verdict: 'pass' });
  if (typeof clean.id !== 'string' || clean.id === '') {
    checks.push({ name: 'id', verdict: 'fail', reason: 'draft 缺少 profile id' });
  } else if (store.profiles.has(clean.id)) {
    checks.push({ name: 'id', verdict: 'fail', reason: 'profile ' + clean.id + ' 已存在（请先删除或改名）' });
  } else {
    checks.push({ name: 'id', verdict: 'pass' });
  }
  const whitelist = new Set(await resolveWhitelist(ctx.get('agentPresets'), getEscapeSet()));
  if (typeof clean.preset === 'string' && clean.preset !== '' && clean.preset !== 'inherit' && !whitelist.has(clean.preset)) {
    checks.push({ name: 'whitelist', verdict: 'fail', reason: '目标预设 ' + clean.preset + ' 不在 system-trust 白名单（可开启逃生舱并添加该预设后重试）' });
  } else {
    checks.push({ name: 'whitelist', verdict: 'pass' });
  }
  const snapshot = await catalog.getSnapshot();
  if (typeof clean.model === 'string' && clean.model !== '' && !snapshot.models.some((m) => m && m.id === clean.model)) {
    checks.push({ name: 'catalog', verdict: 'fail', reason: '模型 ' + clean.model + ' 不在当前模型目录' });
  } else if (typeof clean.provider === 'string' && clean.provider !== '' && !snapshot.models.some((m) => m && m.provider === clean.provider)) {
    checks.push({ name: 'catalog', verdict: 'fail', reason: '提供方 ' + clean.provider + ' 不在当前模型目录' });
  } else {
    checks.push({ name: 'catalog', verdict: 'pass' });
  }
  return { ok: checks.every((c) => c.verdict === 'pass'), checks, clean };
}
