// lib/core/evolution-generate.mjs — 候选生成路径（从 evolution-engine 拆出守行门）：
// 一条建议 → ≤3 条互斥候选，逐候选过三道闸（闸由装配层注入）后落资产域。更新策略
// 与有效期用户可配：自动换新在「候选到期且数据显著变化」时把旧候选转 expired（留
// 审计）再产新一代；手动维护不自动换代、不自动过期，只经「重新生成候选」刷新
// （留审计）。纯函数 + 注入 deps，零 IO、零 LLM。

import { sanitizeProfile } from './pure.mjs';
import { profileKeyOf } from './evolution-summary.mjs';
import { buildEvolutionCandidates, profileFingerprint, sourceConfigFromKey } from './evolution-draft.mjs';
import { candidateExpired, candidateExpiryOf, dataFingerprintOf, dataSignificantlyChanged, expireAuditEntry, refreshAuditEntry } from './evolution-renewal.mjs';

// 候选总量护栏：evolution 资产数达到 20 条即跳过生成并 warn（阈值待实测后校准）。
const ASSET_CAP = 20;

// 存量 profile 的 L1 身份键（与聚合层同口径：persona/toolFilter 只认存在性）。
function keyCfg(profile) {
  const cfg = {};
  if (typeof profile.preset === 'string' && profile.preset !== '' && profile.preset !== 'inherit') cfg.preset = profile.preset;
  if (typeof profile.provider === 'string' && profile.provider !== '') cfg.provider = profile.provider;
  if (typeof profile.model === 'string' && profile.model !== '') cfg.model = profile.model;
  if (typeof profile.persona === 'string' && profile.persona.length > 0) cfg.persona_present = true;
  if (profile.toolFilter !== undefined && profile.toolFilter !== null) cfg.toolFilter_present = true;
  return cfg;
}

// 注册表中与该 L1 身份键匹配的方案（净化后快照）——指纹输入，编辑任一方案
// 都会使候选过期。
export function matchingRegistryProfiles(store, profileKey) {
  const profiles = store.profiles instanceof Map ? [...store.profiles.values()] : [];
  return profiles
    .filter((p) => p !== null && typeof p === 'object' && profileKeyOf(keyCfg(p)) === profileKey)
    .map((p) => sanitizeProfile(p, { strict: false }).clean);
}

// 单条候选 → 资产对象。baseline_snapshot 留档金丝雀基线（from + 生成时刻的加权分/
// 样本数）；data_fingerprint 留档换代判定输入；expiry 按用户设置（手动维护或不自动
// 过期档为 null，否则 = 生成时刻 + 有效期小时数）。
export function buildAsset(deps, item, draft, now, summaries) {
  const l1Entry = summaries !== null && typeof summaries === 'object' && summaries.l1 !== null && typeof summaries.l1 === 'object'
    ? summaries.l1[item.profileKey]
    : undefined;
  const l2 = summaries !== null && typeof summaries === 'object' ? summaries.l2 : undefined;
  if (draft === null || typeof draft !== 'object') return null;
  const from = sourceConfigFromKey(item.profileKey, l2);
  const registry = matchingRegistryProfiles(deps.store, item.profileKey);
  const fingerprint = profileFingerprint({ profileKey: item.profileKey, from, registryEntries: registry });
  const axis = item.suggestion === '降' ? 'capability' : 'budget';
  const direction = item.suggestion === '降' ? 'down' : 'up';
  return {
    v: 1,
    id: draft.config.id,
    source: 'evolution',
    provenance: { pluginVersion: deps.pluginVersion, generatedAt: now, basis: draft.basis },
    state: 'draft',
    version: 1,
    expiry: candidateExpiryOf(deps.getCandidateMode(), deps.getCandidateTtlH(), now),
    from,
    to: draft.config,
    axis,
    direction,
    baseline_snapshot: {
      from,
      score: l1Entry?.score ?? null,
      n: l1Entry?.confidence?.n ?? 0,
      confidence: item.confidence ?? '',
      generatedAt: now,
    },
    data_fingerprint: dataFingerprintOf(item, summaries),
    profile_key: item.profileKey,
    profile_fingerprint: fingerprint,
    config: draft.config,
    name: draft.name,
    description: draft.description,
    createdAt: now,
    updatedAt: now,
  };
}

// 单条建议 → ≤3 条候选，逐候选过三道闸（复用装配层注入的闸评估）后落盘；单条
// 候选闸不过或落盘失败只跳过该候选（fail-soft），不影响其余候选与建议展示。
async function generateCandidatesFor(deps, { item, snapshot, taken, now, summaries }) {
  const l1Entry = summaries !== null && typeof summaries === 'object' && summaries.l1 !== null && typeof summaries.l1 === 'object'
    ? summaries.l1[item.profileKey]
    : undefined;
  const l2 = summaries !== null && typeof summaries === 'object' ? summaries.l2 : undefined;
  const drafts = buildEvolutionCandidates({
    advice: item,
    l1Entry,
    l2,
    snapshot,
    whitelist: deps.whitelist,
    takenIds: taken,
    now,
  });
  const generated = [];
  const skipped = [];
  for (const draft of drafts) {
    const gates = await deps.assessGates(draft.config);
    if (!gates.ok) {
      skipped.push({ profileKey: item.profileKey, candidateId: draft.config.id, reason: gates.reason });
      continue;
    }
    const asset = buildAsset(deps, item, draft, now, summaries);
    if (asset === null) continue;
    const persisted = deps.assets.add(asset);
    if (persisted.persisted) {
      taken.add(asset.id);
      generated.push(asset.id);
    } else {
      skipped.push({ profileKey: item.profileKey, candidateId: draft.config.id, reason: 'persist-failed' });
    }
  }
  return { generated, skipped };
}

// auto 模式的待处置门槛：null = 可生成；{skip} = 幂等跳过；{expire} = 需先转
// expired 再换代。观察期（proposed）恒阻断；手动维护不自动换代。
function pendingGate(deps, item, now, summaries, mode) {
  const unresolved = deps.assets.findUnresolved(item.profileKey);
  if (unresolved.length === 0) return null;
  if (mode === 'manual' || unresolved.some((entry) => entry.state === 'proposed')) return { skip: 'pending' };
  const expired = unresolved.filter((entry) => candidateExpired(entry, now));
  if (expired.length < unresolved.length) return { skip: 'pending' };
  const next = dataFingerprintOf(item, summaries);
  const changed = expired.some((entry) => {
    const asset = deps.assets.get(entry.id);
    return dataSignificantlyChanged(asset !== undefined ? (asset.data_fingerprint ?? {}) : {}, next);
  });
  return changed ? { expire: expired } : { skip: 'no-significant-change' };
}

// 生成候选（建议 → 资产域）：建议链开关门（evolutionAdvice）→ 总量护栏 → 逐条建议：
//   auto：无未处置候选才生成；未到期幂等跳过；全部到期且数据显著变化 → 旧候选转
//   expired（留审计）再产新一代；到期但数据没显著变化 → 保留旧候选跳过。
//   manual：有任何未处置候选即幂等跳过（不自动换代、不自动过期）。
//   forceProfileKey：只对该键绕过上述待处置门槛（「重新生成候选」内部复用）。
export async function generateCandidates(deps, { advice, summaries, forceProfileKey = null } = {}) {
  if (!deps.getAdviceEnabled()) return { generated: [], skipped: [], reason: 'advice-disabled' };
  const snapshot = await deps.catalog.getSnapshot();
  const now = Date.now();
  const mode = deps.getCandidateMode();
  const evolutionCount = deps.assets.countBySource('evolution');
  if (evolutionCount >= ASSET_CAP) {
    deps.logger.warn('[dsh-subagent-profile] 候选总量护栏：evolution 资产已达 20 条上限，跳过生成（阈值待实测后校准）');
    return { generated: [], skipped: [] };
  }
  const taken = new Set([...deps.store.profiles.keys(), ...deps.assets.ids()]);
  const generated = [];
  const skipped = [];
  for (const item of Array.isArray(advice) ? advice : []) {
    if (evolutionCount + generated.length >= ASSET_CAP) break;
    const forced = forceProfileKey !== null && item.profileKey === forceProfileKey;
    if (!forced) {
      const gate = pendingGate(deps, item, now, summaries, mode);
      if (gate === null) { /* 无未处置候选，正常生成 */ }
      else if (gate.skip !== undefined) { skipped.push({ profileKey: item.profileKey, reason: gate.skip }); continue; }
      else {
        for (const entry of gate.expire) {
          const transitioned = deps.assets.transition(entry.id, 'expired', { expire_reason: 'expiry-and-data-change' });
          if (transitioned.persisted) {
            const asset = deps.assets.get(entry.id);
            if (asset !== undefined) deps.evoLedger.recordGovernanceAudit(expireAuditEntry(asset, '候选到期且数据显著变化，已换新'));
          }
        }
      }
    }
    const perItem = await generateCandidatesFor(deps, { item, snapshot, taken, now, summaries });
    generated.push(...perItem.generated);
    skipped.push(...perItem.skipped);
  }
  return { generated, skipped };
}

// 重新生成候选（人工触发）：该身份键所有未处置候选先转 expired，再产新一代；
// 审计 suggestion-refresh 一条（人工触发即确认）。无当前建议时只清理不产新候选。
export async function regenerateCandidates(deps, { profileKey, advice, summaries }) {
  const unresolved = deps.assets.findUnresolved(profileKey);
  const expired = [];
  for (const entry of unresolved) {
    const transitioned = deps.assets.transition(entry.id, 'expired', { expire_reason: 'manual-regenerate' });
    if (transitioned.persisted) expired.push(entry.id);
  }
  const result = await generateCandidates(deps, { advice, summaries, forceProfileKey: profileKey });
  const generatedIds = Array.isArray(result.generated) ? result.generated : [];
  const item = (Array.isArray(advice) ? advice : []).find((a) => a !== null && typeof a === 'object' && a.profileKey === profileKey);
  const l2 = summaries !== null && typeof summaries === 'object' ? summaries.l2 : undefined;
  const first = generatedIds.length > 0 ? deps.assets.get(generatedIds[0]) : undefined;
  deps.evoLedger.recordGovernanceAudit(refreshAuditEntry({
    profileKey,
    from: sourceConfigFromKey(profileKey, l2),
    to: first !== undefined ? first.to : null,
    axis: item?.suggestion === '升' ? 'budget' : 'capability',
    direction: item?.suggestion === '升' ? 'up' : 'down',
  }));
  return { expired, generated: generatedIds, skipped: Array.isArray(result.skipped) ? result.skipped : [] };
}
