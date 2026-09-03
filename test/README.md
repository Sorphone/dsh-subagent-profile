# test/ — host-side automated tests

Host-side automated tests built on the built-in `node:test` runner (zero new dependency, no npm
test package). `characterization.test.mjs` snapshots the observable `apply(ctx)` behavior;
`pure.test.mjs` unit-tests the import-free pure functions.

## Two tiers: bare vs junction

The only `@deepseek-ai` import point is `lib/core/shims.mjs`, which is itself imported by
`lib/core/dispatch-tool.mjs` → `index.mjs`. A bare CI environment (no `@deepseek-ai` installable)
can therefore only run tests whose **entire import chain** stays within node builtins + local
`lib/core` modules. The tiers:

| Tier | Files | Tests | Why |
|---|---|---|---|
| **bare** (`npm run test:bare`) | `pure` / `input-schema` / `catalog-integrity` | 27 | Static imports only from `lib/core/pure.mjs` / `catalog.mjs` — import-free, no junction. Runs in bare CI. |
| **junction** (local only) | all `test/*.test.mjs` except the bare three (`pure` / `input-schema` / `catalog-integrity`) | 615 | Dynamically `await import('../index.mjs')` or `../lib/core/shims.mjs` → loads `@deepseek-ai`. Needs a junction host with `@deepseek-ai` installed; `npm test` / `node --test "test/**/*.test.mjs"` runs the full 642 locally. |

Note that a module being import-free does **not** make its test bare: `cost-guard` / `persist` /
`recycle` unit-test import-free modules but still dynamically import `index.mjs` in their bodies,
so they stay junction. The tier is decided by the **test's actual import chain**, not the module's.

## Running

```bash
node --test "test/**/*.test.mjs"
```

> Node 24 no longer accepts the bare directory argument `node --test test/` (parses it as a single
> module and fails with `MODULE_NOT_FOUND`); use the glob form above (matching only `*.test.mjs`).
> `npm test` also works from the repo root.

## Gate judgment (门控判定，门控拆分后口径)

`systemPrompt.section` 门控已按 section 拆成两个 gate（禁止「成对放宽」共享 gate）：

- `dispatch:profiles` → **profileSectionGate（能力判据）**：`enabled` + schemas(agent) 含
  `dispatch` 即注入（任何可派发会话可见，非 orchestrator 预设亦可）；schemas 明确不含
  dispatch → 必空（否决）。schemas 数据缺失（context/agent 缺省）→ 视为一次注入机会并记
  debug 日志（确认语义：schemas 可用才注入）。
- `orchestrator:mode` / `dispatch:budget` → **orchestrationGate
  （模式判据，与 0.4.0 一致）**：`enabled` + schemas 否决 + `composedPreset(agentCtx) ===
  'orchestrator-v2'`；无 agentPresets 保守不注入。编排语料不得注入非编排会话。
- `evolution:advice` → **模型侧恒空（下架）**：section 注册结构保留（名/order 不变），
  text 恒 ''、不再过开关/编排者门控；人类面板（建议卡/提醒中心/审计行）数据链不受影响，
  trace 的 `advice_present` 埋点恒 false。恒空断言见 `evolution-advice.test.mjs`。

断言位置：`gating.test.mjs`（门控行为）+ `characterization.test.mjs`（systemPrompt 快照）。

## Snapshot maintenance

`characterization.test.mjs` is a snapshot of `apply()`; on a host upgrade or an intentional change,
re-verify the fake ctx surfaces and the assertions against the new service signatures, and state the
reason in the commit message.
