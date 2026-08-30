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
| **bare** (`npm run test:bare`) | `pure` / `input-schema` / `catalog-integrity` | 26 | Static imports only from `lib/core/pure.mjs` / `catalog.mjs` — import-free, no junction. Runs in bare CI. |
| **junction** (local only) | all `test/*.test.mjs` except the bare three (`pure` / `input-schema` / `catalog-integrity`) | 380 | Dynamically `await import('../index.mjs')` or `../lib/core/shims.mjs` → loads `@deepseek-ai`. Needs a junction host with `@deepseek-ai` installed; `npm test` / `node --test "test/**/*.test.mjs"` runs the full 407 locally. |

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

## Snapshot maintenance

`characterization.test.mjs` is a snapshot of `apply()`; on a host upgrade or an intentional change,
re-verify the fake ctx surfaces and the assertions against the new service signatures, and state the
reason in the commit message.
