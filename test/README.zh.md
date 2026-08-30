# test/ — 插件宿主侧自动化测试

本目录用内置 `node:test` 做插件**宿主侧**自动化测试（零新增依赖，不引入 npm 测试包），锁应用行为
与纯函数：`characterization.test.mjs` 为 `apply(ctx)` 行为快照，`pure.test.mjs` 为纯函数单测。

## 两档测试：bare 与 junction

仓库唯一的 `@deepseek-ai` import 点在 `lib/core/shims.mjs`，它又被 `lib/core/dispatch-tool.mjs`
→ `index.mjs` 引用。裸 CI 环境（装不到 `@deepseek-ai`）只能跑**整条 import 链**都不出 node 内置
与本地 `lib/core` 的测试。分档如下：

| 档位 | 文件 | 用例数 | 理由 |
|---|---|---|---|
| **bare**（`npm run test:bare`） | `pure` / `input-schema` / `catalog-integrity` | 26 | 仅静态 import `lib/core/pure.mjs` / `catalog.mjs`——import-free、无 junction，裸 CI 可跑。 |
| **junction**（仅本机） | 除 bare 三文件（`pure` / `input-schema` / `catalog-integrity`）外的全部 `test/*.test.mjs` | 380 | 体内动态 `await import('../index.mjs')` 或 `../lib/core/shims.mjs` → 加载 `@deepseek-ai`，需要装有 `@deepseek-ai` 的 junction 宿主；本机 `npm test` / `node --test "test/**/*.test.mjs"` 全量 407 用例。 |

注意：模块 import-free ≠ 测试 bare。`cost-guard` / `persist` / `recycle` 单测的模块本身
import-free，但测试体内仍动态 import `index.mjs`，所以仍是 junction。分档以**测试文件的实际
import 链**为准，而非被测模块。

## 运行

```bash
node --test "test/**/*.test.mjs"
```

> Node 24 不再支持裸目录参数 `node --test test/`（按单模块解析，报 `MODULE_NOT_FOUND`），须用上方
> glob 写法（仅匹配 `*.test.mjs`）；仓库根亦可 `npm test`。

## 快照维护

`characterization.test.mjs` 为 `apply()` 可观察行为的快照；宿主升级或有意改动时，须按新服务签名
重核 `test/harness/ctx.mjs` 的假上下文与断言，并在提交信息中说明快照更新的原因。
