# dsh-subagent-profile

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">子 Agent 派发插件 —— 派发可控 · 成本有数 · 决策留痕</b><br /><br />
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" />
  <img alt="npm" src="https://img.shields.io/npm/v/dsh-subagent-profile.svg" />
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.1.0--rc.6%20~%200.2.0-blue.svg" />
</div>

<div align="center"><a href="README.md">English</a> · 中文</div>

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）。

> DeepSeek Harness 子 Agent 派发插件：按任务为子代理选模型、推理强度与工具范围，常用组合存成命名方案随时复用；内置安全检查、成本估算与节省分析、完整决策台账。

## 为什么需要这个插件

| | 内置 `subagent` | `dsh-subagent-profile` |
|---|---|---|
| 按子任务选模型/预设 | ❌ 每个子任务同一个「大脑」 | ✅ 按任务逐个指定 |
| 可复用的命名方案 | ❌ | ✅ 方案（profile） |
| 工具范围收敛 | ❌ | ✅ 白名单 ∩ 父会话，`run_code` 恒移除 |
| 派发前安全检查 | ❌ | ✅ 白名单/成本/交集/审批/预算，全程记录 |
| 成本可见 | ❌ | ✅ 每次派发的成本估算 + 节省对照 |
| 派发决策台账 | ❌ | ✅ 请求vs生效、检查结果、执行、结算全留痕 |
| 界面管理 | ❌ | ✅ 设置页 + 会话内台账标签页 |

## 安装

```bash
dsh plugin --profile web add dsh-subagent-profile        # 发布包
dsh plugin --profile web add ./dsh-subagent-profile      # 本地源码
```

重启 `dsh web`。这是一个标准的 **bundle 插件**：提供 `dispatch` 工具、方案提供者、`subagent-profiles` 服务、`/subagent-profiles/*` 回环管理路由、设置页（「子 Agent 方案」）、会话内派发决策台账标签页，以及 web 界面中的 `dispatch` 工具卡片。启动时还会**自动安装一个 agent 预设**——**`orchestrator`**（「编排者模式」）——在新会话的预设选择器里选用。同步是幂等的且每次启动重跑，升级插件即更新预设。

## 使用

### 1. 配置子 Agent 方案

方案在设置页管理——每个方案打包预设 + 模型 + 推理强度 + 工具范围（可选人设），可单独启用、禁用、编辑、重置。内置两个：

| 方案 | 用途 |
|---|---|
| `swap-standard` | 让子代理切换到完整标准编码工具集 |
| `researcher` | 关闭深度推理，仅搜索工具 |

方案数据存于 `~/.dsh/subagent-profiles.json`，设置页修改即时生效。

![内置方案列表——可编辑、可删除、可单独开关](docs/screenshots/settings-page1.png)

![配置方案——完整设置页与新增方案表单](docs/screenshots/settings-page2.png)

### 2. 按子任务派发——`dispatch` 工具

```js
dispatch(
  profile: "researcher",        // 预设 + 模型 + 推理强度 + 工具范围
  prompt: "调研 DSH 插件生态并对比直接竞品",
  run_in_background: true
)
```

![dispatch 工具卡片——每次结果都显示实际生效的配置](docs/screenshots/dispatch-card.png)

### 3. 在派发决策台账中复盘

每个会话都有「派发决策台账」标签，记录每次派发决策：父会话看到了什么、请求了什么，实际生效了什么（请求被忽略处高亮），哪些工具被移除及原因，执行过程如何（含停滞与主 Agent 干预），以及成本多少。安全检查失败时给出修复方向。

## 安全模型

委派永远不会让子代理获得比你更大的权限——这是默认行为，无需配置：

- **工具只减不增。** 子代理的工具集 = 方案工具 ∩ 父会话工具，且 `run_code` 恒移除。
- **审批永不豁免。** 委派不豁免宿主的审批要求；需要审批的操作自动拒绝。
- **成本有上限。** 模型、推理强度、token、递归深度全部有界；越界值大声失败而非静默降级。
- **逃生舱，显式开启。** 非官方预设可逐个放行（默认关闭，每次放行留审计）。

## 可观测性与通知

- **实时状态。** 后台派发的阶段徽标实时更新（发起/检查/创建/执行中/结算），宿主任务事件驱动，轮询兜底。
- **提醒中心。** 紧急事件（逃生舱放行、审计降级、预算异常）触发常驻红角标；通知中心里每条提醒都带完整上下文——主会话、子会话、任务摘要、结果状态——并可一键跳转对应会话。正常编排事件（如父会话未采纳某次派发结果）只记审计台账，不打断你。
- **派发优化建议。** 基于历史派发统计，插件可向主 Agent 注入只读优化提示（如「该方案近期成功率偏低，可考虑换方案」）——只提示，不自动改任何配置。
- **子会话页头徽标。** 子会话页头显示紧凑摘要标签（如 `继承父会话 · 前台`），悬停查看全部字段（模型/推理强度/预设/模式/来源）。

## 数据文件

- `~/.dsh/subagent-profiles.json` —— 方案注册表（设置页编辑）。
- `~/.dsh/subagent-profiles.state.json` —— 插件开关状态（默认启用）。
- `~/.dsh/subagent-profiles.failed-traces.json` —— 失败台账（派发失败轨迹）。
- `~/.dsh/subagent-evolution/` —— 派发决策台账与统计：
  - `dispatch.jsonl` —— 每次派发的决策记录（不含 prompt 原文）。
  - `summaries.json` —— 按方案聚合的统计（带版本号，损坏自动重建）。
  - `adopted-state.json` —— 子结果采纳判定状态（跨重启）。
  - `reminders.json` —— 提醒存储（一条提醒 = 一条审计记录）。
- `~/.dsh/.agent-presets/orchestrator/` —— 自动安装的 `orchestrator` 预设（每次启动从内置 `presets/orchestrator/` 同步）。

尊重 `DSH_HOME` 环境变量（默认 `~/.dsh`）。卸载插件会移除上述数据文件与自动安装的 `orchestrator` 预设目录（其他插件的预设不动）；重装或重启会重新同步预设并重建数据文件。

## 已知限制

- **后台派发**需要 `@deepseek-ai/dsh-jobs` 与 `@deepseek-ai/dsh-tool-jobs` 已加载；否则报「dispatch: 后台派发不可用：缺少 jobs 服务」。
- **持久（continuable）模式**走 DSH 标准组合路径，`preset` 换用与 `reasoningEffort` 会被忽略（子代理继承父预设与默认推理强度）。
- **子代理的最终工具集由谁决定，取决于模式**：
  - 持久（continuable）模式：由本插件预先收敛——子代理 `allow` =（父工具集 − `run_code` − `deny`）∩ `allow`。前提假设：持久模式沿用父会话预设，故子工具集与父会话基本一致；一旦 dsh 的行为变化导致两者不同（如未来支持预设换用后组合出不同工具集），工具收敛会**直接报错拒绝**（保守安全，绝不静默放行），待 dsh 官方提供相应接口后替换为真正的父 ∩ 子交集。
  - 一次性模式：由 dsh 决定，插件读不到最终受限结果；卡片显示「工具由系统最终授予」。
- **成本是估算**：按每次派发的均价计算（每个模型实测一次）；按 token 的精细计价在路线图中。界面明确标注「估算」，样本不足时显示说明。

## 仓库结构

```
dsh-subagent-profile/
├── index.mjs                     # 宿主侧：插件本体（dispatch 工具、方案提供者、服务、HTTP 路由）
├── lib/
│   ├── client.js                 # 浏览器侧：设置页 + 台账 + dispatch 工具卡片
│   └── core/                     # 宿主侧模块（轻量分层）
│       ├── pure.mjs              # 零依赖纯函数（清洗/剪枝/护栏数学——单测覆盖）
│       ├── shims.mjs             # 唯一的 @deepseek-ai 导入门面（护栏大声失败，辅助软降级）
│       ├── catalog.mjs           # 工具名 → 中文/分类表（零依赖）
│       ├── catalog-cache.mjs     # 进程共享目录快照（模型/预设/工具，TTL 缓存）
│       ├── cost-guard.mjs        # 运行时能力检查（提供方/模型/推理强度）
│       ├── cost-evidence.mjs     # 省 token 反事实对照证据
│       ├── prices.mjs            # 每次派发单价表（当前为均价占位）
│       ├── decision-trace.mjs    # 决策轨迹（检查/生效/结算）+ 失败台账
│       ├── delegation.mjs        # 后台一次性结算 + 子用量采集
│       ├── dispatch-gates.mjs    # 派发前安全检查（白名单/成本/交集/预算）
│       ├── dispatch-guard.mjs    # 并发 + 每父会话 token 预算护栏
│       ├── dispatch-schema.mjs   # dispatch 工具输入/输出 schema 声明
│       ├── dispatch-tool.mjs     # dispatch 工具工厂（defineTool + execute + syncTool）
│       ├── draft-gates.mjs       # 草稿方案三道闸
│       ├── drafts-store.mjs      # 草稿方案持久化
│       ├── escape.mjs            # 逃生舱放行存储
│       ├── evolution-ledger.mjs  # 派发决策台账（jsonl）+ 治理审计
│       ├── evolution-summary.mjs # 聚合统计（按方案，能力/预算双轴）
│       ├── evolution-advice.mjs  # 只读派发建议生成
│       ├── adoption-tracker.mjs  # 子结果采纳判定跟踪（跨重启）
│       ├── adoption-reminder.mjs # 采纳判定提醒生成
│       ├── reminder-store.mjs    # 提醒存储 + 审计耦合记录
│       ├── background-ledger.mjs # 后台任务台账（内存态，重启即失）
│       ├── http-routes.mjs       # 设置回环 HTTP 路由
│       ├── intersection.mjs      # 工具交集纯核心
│       ├── presets-sync.mjs      # 内置预设自动安装（哈希门控同步）
│       ├── profile-provider.mjs  # `profile` 子代理提供者
│       ├── profile-directory.mjs # 只读方案目录（供模型参考）
│       ├── profiles-store.mjs    # 方案注册表存储 + 开关持久化
│       └── whitelist.mjs         # system-trust 预设白名单
├── presets/orchestrator/         # 内置「orchestrator」预设（自动安装，每次启动同步）
├── cordis.patch.yml              # bundle patch：把插件行插入宿主组合
├── .gitea/workflows/ci.yml       # bare-CI（Gitea Actions；需服务器上的 Act runner）
├── package.json                  # 元数据、files 白名单、exports（test / test:bare / preflight 脚本）
├── scripts/
│   ├── preflight.mjs             # 预检：预设树一致 + 无硬编码版本徽章（零依赖）
│   └── leak-scan.mjs             # 公开发布门：扫描全历史与工作区的敏感模式
├── docs/
│   └── screenshots/              # README 截图
├── test/                         # 宿主侧测试（node:test，零额外依赖；438 用例）
│   ├── README.md / README.zh.md  # 测试目录指南（中英）——两层拆分说明
│   ├── harness/ctx.mjs           # 假 Cordis ctx + ~/.dsh 隔离
│   ├── pure / input-schema / catalog-integrity.test.mjs   # bare 层（免导入，bare CI 可跑）
│   └── *.test.mjs                # junction 层（仅本地）：characterization / facade / gating / persist / recycle /
│                                 #   cost-guard / continuable-guard / decision-trace / dispatch-guard / escape-hatch /
│                                 #   evolution-* / csrf / label-preset-sync / percall-spec / trust-label / audit-meta / …
├── README.md / README.zh.md      # 本文档（英/中）
└── LICENSE
```

## 贡献

发现 bug 或有想法？[提交 issue](https://github.com/muzyLink/dsh-subagent-profile/issues) 或 PR——欢迎一切贡献。

如果这个插件对你有用，请在 GitHub 上给个 ⭐——它帮助更多人发现它。

## 致谢

内置的 `orchestrator` 预设灵感来自 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) 的 [dsh-liangshen](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-liangshen)（梁神模式），Apache-2.0 许可。感谢作者。

## 许可

[MIT](LICENSE) — Copyright (c) 2026 muzyLink
