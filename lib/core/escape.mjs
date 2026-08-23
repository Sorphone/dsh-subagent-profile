// lib/core/escape.mjs — 逃生舱放行集（evolution-escape.json）管理 + 放行审计快照。
// 逃生舱默认关（开关态在 state.json，由 profiles-store 持久化）；放行集文件只
// 存「被显式 opt-in 的非 system-trust 预设 id」——文件损坏/缺失/形状不符一律
// fail-soft 空集（绝不阻断启动，也绝不把坏数据当放行成员）。
//
// 放行集独立追踪、独立落盘于 subagent-evolution/ 域（与派发台账同根），不被 preset
// 同步裁剪。写路径原子写（tmp+rename），失败仅 warn + 通知治理审计钩子（不抛）。
// 逃生舱语义：成员只在「其余三道闸全过」时放行；非成员即便开关开也恒拒——这里只
// 提供名单，不参与任何闸判定。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ESCAPE_VERSION = 1;

// 文件形状判定：只接受 {version:1, presets:[string...]}。版本/形状不符一律判空集
// （fail-soft），并把坏文件当「未配置」而非「配置了危险成员」。
function classifyEscapeFile(parsed) {
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version === 1 && Array.isArray(parsed.presets)) {
    return parsed.presets.filter((id) => typeof id === 'string' && id !== '');
  }
  return undefined;
}

// 读放行集文件 → 内存 Set。缺失/损坏/形状不符均回退空集并 warn，绝不 throw。
function loadEscapeSet(file, logger) {
  const presets = new Set();
  if (!existsSync(file)) return presets;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const entries = classifyEscapeFile(parsed);
    if (entries === undefined) {
      logger.warn('[dsh-subagent-profile] escape set: 放行集文件形状不符，按空集处理');
      return presets;
    }
    for (const id of entries) presets.add(id);
  } catch {
    logger.warn('[dsh-subagent-profile] escape set: 放行集文件损坏，按空集处理');
  }
  return presets;
}

// 原子写放行集文件（tmp+rename）；失败 fail-soft：清理 tmp + warn + 通知治理审计
// 钩子（写失败计一次治理丢失），返回 {persisted}。内存 Set 仍驱动本进程。
function persistEscapeSet(file, presets, logger, onGovernanceFailure) {
  const payload = { version: ESCAPE_VERSION, presets: [...presets] };
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
    return { persisted: true };
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    logger.warn('[dsh-subagent-profile] escape set: 放行集写入失败:', error instanceof Error ? error.message : String(error));
    if (typeof onGovernanceFailure === 'function') onGovernanceFailure();
    return { persisted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// 放行集工厂：per-apply 单例（与 profiles store 同口径）。返回 { list, add,
// remove }；add/remove 都原子落盘并回传 {persisted}。list 返回数组副本（供设置页
// 只读列表与 resolveWhitelist 叠加）。成员判定由调用方对 list() 结果做 includes。
export function createEscapeStore({ dshHome, logger, onGovernanceFailure = () => {} }) {
  const file = join(dshHome, 'subagent-evolution', 'evolution-escape.json');
  const presets = loadEscapeSet(file, logger);
  return {
    list: () => [...presets],
    add(id) {
      if (typeof id !== 'string' || id === '') return { persisted: false, error: '放行集成员必须是非空字符串' };
      presets.add(id);
      return persistEscapeSet(file, presets, logger, onGovernanceFailure);
    },
    remove(id) {
      presets.delete(id);
      return persistEscapeSet(file, presets, logger, onGovernanceFailure);
    },
  };
}

// 放行审计快照：从 decisionTrace.gates 抽取「白名单 + 其余三道闸」的 verdict。
// cost 保留硬上限/llm 能力检查的 field→verdict，whitelist/intersection/approval
// 只留 verdict 字符串。只读、不 throw——trace 缺 gates 或某闸缺失时对应键缺席
// （审计记录仍恒可写）。
export function escapeGatesSnapshot(trace) {
  const gates = Array.isArray(trace?.gates) ? trace.gates : [];
  const snapshot = {};
  for (const gate of gates) {
    if (!gate || typeof gate !== 'object') continue;
    if (gate.name === 'cost') {
      snapshot.cost = {
        verdict: gate.verdict,
        checks: (Array.isArray(gate.output?.checks) ? gate.output.checks : [])
          .map((check) => ({ field: check?.field, verdict: check?.verdict })),
      };
    } else if (gate.name === 'whitelist' || gate.name === 'intersection' || gate.name === 'approval') {
      snapshot[gate.name] = gate.verdict;
    }
  }
  return snapshot;
}

// 逃生舱放行审计：非 system 预设经逃生舱通过闸链时写一条高可见治理审计事件（含
// preset、来源会话、白名单+三道闸快照）。调用点在闸链末尾（三道闸 + 预算闸之后、
// 分派之前）。getEscapeSet 在开关关时返回空数组 → includes 恒 false → 零审计；成员
// 判定即「开关开且 preset 在放行集」。写失败绝不静默（recordGovernanceAudit 内部
// warn + 治理丢失计数）。deps 由调用方注入（含 getEscapeSet / evoLedger）。
export function recordEscapeAllow(deps, parent, merged, trace) {
  if (typeof merged.preset !== 'string' || merged.preset === 'inherit') return;
  if (!deps.getEscapeSet().includes(merged.preset)) return;
  deps.evoLedger.recordGovernanceAudit({
    kind: 'escape-allow',
    preset: merged.preset,
    session_id: parent.session?.header?.id ?? null,
    gates_snapshot: escapeGatesSnapshot(trace),
  });
}

// provider 渠道放行审计：profile provider 的 preflight 白名单放行 escape 成员时
// （非 dispatch 工具的宿主原生 subagent 渠道），同样写高可见审计——「每个放行都
// 留痕」是绝对语义。快照为 provider 渠道口径：whitelist/cost 在 preflight 已过、
// intersection 在子会话 setup 时执行（deferred）、审批不豁免（never）。
export function recordEscapeAllowProvider(evoLedger, parent, preset) {
  evoLedger.recordGovernanceAudit({
    kind: 'escape-allow-provider',
    preset,
    session_id: parent?.session?.header?.id ?? null,
    gates_snapshot: { whitelist: 'pass', cost: 'pass', intersection: 'deferred', approval: 'never' },
  });
}
