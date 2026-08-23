# 待实测参数回填记录（R2 · §13 唯一清单）

> 本文件是 `V2-SPEC.md` §13「待实测回填」清单的**唯一落地记录**（对齐合并注记 3 的口径）。
> 每条含：参数 → 当前实现值 → 实测数据/方法 → 回填日期 → 口径与局限。
> 关联代码注释位置一并给出，改动参数时须同步更新本文件。

---

## 已回填（实测或实现值已确定）

### 1. persona 降幅基线（§8.1，目标 −30% 方向性初值）

- **实测**：v0.1.0 orchestrator persona **698 字符** → v0.2.0 精简后 **455 字符**，降幅 **34.8%**。
- **方法**（2026-08-24）：`git show v0.1.0:presets/orchestrator/agent.cordis.yml` 与 `v0.2.0` 同路径文件，提取 `text: |-` 块 persona 文本，比较 trim 后字符数。
- **口径与局限**：字符数估算口径；spec 要求的严格口径（`estimateToolsTokens` / `childTotalTokens` 前后差分）需基线会话，留 V2.1。
- **结论**：达成 −30% 方向性目标。

### 2. task.structure 指纹（§10.1）

- **实现值**：`L{prompt_len}_{sha256(prompt)前8位}_NL{换行数}`（`lib/core/evolution-ledger.mjs`）。
- **已确认**（2026-08-24）：确定性、min-PII（不落 prompt 原文）。台账实测记录形如 `L39_f93794e3_NL0`。

### 3. elapsed_ms 来源（§10.1 outcome / §9.5）

- **实现值**：dispatch `execute` 入口 `Date.now()` 起，到结算时点之差（`lib/core/dispatch-tool.mjs` 的 `t0`；前台/后台/continuable 分支各自结算处计算）。
- **已确认**（2026-08-24）。

### 4. 并发上限 / 每父累计 token（§7.6）

- **实现值**：同深扇出并发 **≤ 8**；每父累计 token **200,000**（`lib/core/dispatch-guard.mjs` 工厂默认参数，spec 建议值 ≤8 落地）。
- **状态**：初值待实测校准——需积累派发并行度与单次 token 分布数据后复核。台账当前样本不足（3 条）。

### 5. 决策轨迹截断护栏（§14 · 账本 M1）

- **实现值**：`decisionTrace` 预算 **3072 字节**（`assertTraceSize`，`lib/core/decision-trace.mjs`）；逐次调用明细 `maxCalls=6`（超预算截到前 4 条，`lib/core/delegation.mjs` `collectChildCalls`）。
- **已确认**（2026-08-24）：设计文档 2.2KB 估算 → 3KB 护栏，留 1KB 余量。

---

## 已接线但口径打折（记录在案）

### 6. 结果回收剪枝阈值（§8.2，建议初值 head 2048 / tail 1024 / minKeep 128）

- **现状**：`PRUNE_HEAD_CHARS/PRUNE_TAIL_CHARS/PRUNE_MIN_KEEP` 已定义（`lib/core/pure.mjs`），但 `pruneBlocks` 复用宿主 `toolResultPruner.pruneContent`（只接收 blocks，读取**会话级**配置：`thresholdChars 8192 / headChars 4096 / tailChars 1024`，见 `presets/orchestrator/agent.cordis.yml`）。子级更保守口径**未接线**。
- **状态**：待实测子输出长度分布后，决定是否自实现子级剪枝（或给宿主 pruner 传参）。台账当前 3 条 `output_len ∈ {2, 4, 12}`，样本不足。

### 7. parent_adopted 判定窗口 N/T 与 0.3 惩罚（§10.2）

- **现状**：`weightedSuccess` 公式（0.3 惩罚仅作用于 confirmed false、unknown 计 0）与判定窗口函数已实现（`lib/core/evolution-summary.mjs`），但**生产 join 未接线**（评审项 F3）：`parentAdoptedConfirmedFalse` 恒 0，`weighted_success` 当前等于 `win_rate`。
- **状态**：0.3 惩罚当前不生效。判定窗口初值建议 **T = 10 min / N = 3 轮**，待 join 数据源接线后实测校准（接线方案见 0.3.3 评审遗留，暂缓）。

---

## 待数据积累后回填

### 8. 置信度阈值 / cooldown 时长（§10.3）

- **实现值**：`min_n_required = 3`；置信度按样本量分档 `low/medium/high`（`lib/core/evolution-summary.mjs`）；cooldown `until_ts` 写回 summaries（原子写）。
- **待积累**：台账样本量达到分档判据后回填实际阈值。

### 9. 建议产出阈值（§10.3 加权成功分门槛）

- **实现值**：`buildAdviceText` 内参数化（表现不佳才建议）。
- **待积累**：同上。
