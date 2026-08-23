// lib/profile-provider.mjs — the `profile` subagent provider
// (setup/start/prepareContinuable), moved verbatim from index.mjs's
// `ctx.subagents.registerProvider({...})` block (Task 7c). Local lib + shims
// references only; no @deepseek-ai dependency (shims is the only entry).
//
// Injection: every apply-closure / ctx dependency is an explicit parameter —
//   subagents   the registry this provider is registered into
//               (subagents.registerProvider is called by the factory),
//   store       the profile store (getAllowFailOpen for the cost guard),
//   getEnabled  reads the apply-closure `enabled` flag (start fails loud when
//               off),
//   logger      ctx.logger (decision-level child log).
// The factory returns whatever registerProvider returns (the caller keeps the
// original `if (typeof disposeProvider === 'function') ctx.effect(...)` shape).

import { randomUUID } from 'node:crypto';
import {
  appendDelegatedPolicyOverrides,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  createUserMessage,
  readResult,
  resolveChildAgentOptions,
  resolveChildDepth,
} from './shims.mjs';
import { GUIDANCE_PREFIX } from './pure.mjs';
import { computeEffectiveAllow } from './intersection.mjs';
import { resolveWhitelist } from './whitelist.mjs';
import { assertCostGuard } from './cost-guard.mjs';
import { DELEGATION_CONTEXT, buildDispatchMeta } from './delegation.mjs';

export function createProfileProvider({ subagents, store, getEnabled, logger }) {
  return subagents.registerProvider({
    name: 'profile',
    capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    async start(request) {
      if (!getEnabled()) {
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
      await assertCostGuard(parent, profile, store.getAllowFailOpen(), logger);
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
          logger.info('[dsh-subagent-profile] child:', JSON.stringify({ childId, preset: profile.preset ?? 'inherit', swapPreset, stopReason: settled.stopReason }));
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
}
