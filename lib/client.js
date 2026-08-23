/**
 * dsh-subagent-profile — 浏览器侧：只读 `dispatch` 工具调用卡片 +
 * 管理方案注册表的设置页。
 *
 * 手写 `__ModuleLoader__` 工厂（无构建步骤），参照 @dsh-external/dsh-persona-ref：
 * React 来自共享模块宿主，所有数据操作走宿主侧（index.mjs）提供的 loopback
 * `/subagent-profiles/*` HTTP 路由，slot 经共享 `slots` 服务注册。卡片挂在
 * keyed `tool.call.toolview` 座（key `dispatch`）；设置页挂在 `settings.section` 列表。
 *
 * 设置页视觉语言对齐官方「模型」设置节（dsh-client-ui-settings-models）：同一套
 * 设计 token，标题 + 引言，每行一张带边框卡片（名称/描述/元信息分层布局），
 * 虚线「+ 新增」按钮展开内联表单卡片。下拉选项（preset / provider / model /
 * reasoning effort）由宿主 `/options/summary`（模型 + 预设，设置页打开时）、
 * `/options/efforts`（按模型，选择模型后懒加载）与 `/options/tools`（工具目录，
 * 限制面板打开时懒加载）路由提供，数据来自实时 presets roster 与 llm 目录。
 *
 * 结构：纯数据（CSS/ZH 文案表）与纯函数（api/解析/文案映射等）驻留模块作用域
 * （load 调用之前的顶层声明）；依赖 React 的组件经参数注入的 maker 函数装配
 * （makeChip / makeDispatchToolview / makeProfilesSection），factory 只做组装。
 */

// ── 纯数据：样式（tokens 对齐 shipped「模型」设置节）────────────────────────

const CSS = [
  '.sap-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}',
  '.sap-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}',
  '.sap-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}',
  '.sap-notice{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}',
  '.sap-savedNotice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}',
  '.sap-rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}',
  '.sap-rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:10px;padding:12px 14px;display:flex}',
  '.sap-rowHead{align-items:center;gap:10px;display:flex}',
  '.sap-rowIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}',
  '.sap-rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}',
  '.sap-rowId{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:monospace}',
  '.sap-rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}',
  '.sap-rowActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}',
  '.sap-desc{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}',
  '.sap-warn{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}',
  '.sap-versionWarn{background:var(--dsw-alias-state-warn-tertiary);border:1px solid var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);border-radius:8px;flex-direction:column;gap:4px;padding:10px 12px;font-size:12px;line-height:18px;margin:0;display:flex}',
  '.sap-chips{flex-wrap:wrap;gap:6px;display:flex}',
  '.sap-chip{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;flex:none;align-items:center;gap:5px;padding:2px 8px;font-size:12px;line-height:18px;display:inline-flex}',
  '.sap-chipLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
  '.sap-chipValue{color:var(--dsw-alias-label-primary)}',
  '.sap-chipValueDim{color:var(--dsw-alias-label-tertiary)}',
  '.sap-chipWarn{background:var(--dsw-alias-state-warn-tertiary);border-color:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font-weight:500}',
  '.sap-chipSuccess{color:var(--dsw-alias-state-success-primary);font-weight:500}',
  '.sap-chipDisabled{color:var(--dsw-alias-state-warn-label);font-weight:500}',
  '.sap-metaValueDefault{color:var(--dsw-alias-label-tertiary)}',
  '.sap-addBlock{margin-top:4px}',
  '.sap-addActions{flex-wrap:wrap;gap:10px;display:flex}',
  '.sap-addButton{box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;flex:1 1 0;gap:6px;min-width:180px;height:44px;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;background:0 0;cursor:pointer;justify-content:center;align-items:center;display:inline-flex}',
  '.sap-addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.sap-addCard{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}',
  '.sap-editorHeader{align-items:baseline;gap:8px;display:flex}',
  '.sap-editorTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}',
  '.sap-field{flex-direction:column;gap:6px;display:flex}',
  '.sap-fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}',
  '.sap-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}',
  '.sap-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}',
  '.sap-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
  '.sap-select{appearance:auto}',
  '.sap-customized{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}',
  '.sap-customizedSummary{cursor:pointer;width:fit-content;color:var(--dsw-alias-label-secondary);border-radius:6px;align-items:center;gap:6px;margin-left:-4px;padding:2px 4px;font-size:12px;font-weight:500;line-height:18px;list-style:none;display:flex}',
  '.sap-customizedSummary::-webkit-details-marker{display:none}',
  '.sap-customizedSummary:before{content:"";border-bottom:1.5px solid;border-right:1.5px solid;width:5px;height:5px;transition:transform .12s;transform:rotate(-45deg)translate(-1px,-1px)}',
  '.sap-customized[open]>.sap-customizedSummary:before{transform:rotate(45deg)translate(-1px,-1px)}',
  '.sap-customizedSummary:hover{color:var(--dsw-alias-label-primary)}',
  '.sap-customizedBody{flex-direction:column;gap:12px;padding-top:12px;display:flex}',
  '.sap-editorActions{justify-content:flex-end;gap:8px;display:flex}',
  '.sap-primaryButton,.sap-secondaryButton{box-sizing:border-box;height:36px;font:inherit;cursor:pointer;border:none;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
  '.sap-primaryButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
  '.sap-primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
  '.sap-secondaryButton{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}',
  '.sap-secondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.sap-dangerButton{box-sizing:border-box;height:28px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:14px;justify-content:center;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}',
  '.sap-dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
  '.sap-primaryButton:disabled,.sap-secondaryButton:disabled,.sap-dangerButton:disabled,.sap-addButton:disabled{opacity:.4;cursor:default}',
  '.sap-titleRow{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.sap-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none}',
  '.sap-switch input{appearance:none;width:36px;height:20px;border-radius:10px;background:var(--dsw-alias-border-l2);position:relative;cursor:pointer;margin:0;transition:background .2s;flex:none}',
  '.sap-switch input::before{content:"";position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;top:2px;left:2px;transition:left .2s;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
  '.sap-switch input:checked{background:var(--dsw-alias-brand-primary)}',
  '.sap-switch input:checked::before{left:18px}',
  '.sap-toolview{flex-direction:column;align-items:flex-start;gap:6px;padding:4px 8px;display:flex}',
  '.sap-toolMeta{flex-wrap:wrap;gap:4px 14px;display:flex}',
  '.sap-toolMetaItem{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.sap-toolText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
  '.sap-toolSummary{align-items:center;gap:6px;flex-wrap:wrap;display:flex}',
  '.sap-detailToggle{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);background:0 0;border-radius:10px;font:inherit;font-size:11px;line-height:16px;height:20px;padding:0 8px;cursor:pointer;flex:none;align-items:center;display:inline-flex}',
  '.sap-detailToggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.sap-toolDetail{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);display:flex}',
  '.sap-toolModes{flex-wrap:wrap;gap:4px 16px;display:flex}',
  '.sap-toolGroups{flex-direction:column;gap:8px;display:flex}',
  '.sap-toolLayerCard{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px}',
  '.sap-toolLayerBody{flex-direction:column;gap:6px;padding-top:6px;display:flex}',
  '.sap-toolGroup{flex-direction:column;gap:4px;display:flex}',
  '.sap-toolGroupTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:4px}',
  '.sap-toolActions{flex-wrap:wrap;gap:6px;display:flex}',
  '.sap-toolList{flex-wrap:wrap;gap:2px 16px;display:flex}',
  '.sap-toolItem{align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:20px;user-select:none;display:inline-flex}',
  '.sap-toolItem input{margin:0;accent-color:var(--dsw-alias-brand-primary)}',
  '.sap-ledger{flex-direction:column;gap:12px;display:flex}',
  '.sap-ledgerSummary{position:sticky;top:0;z-index:1;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;flex-direction:column;gap:6px;padding:12px 14px;display:flex}',
  '.sap-ledgerSummaryTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;font-weight:500;line-height:22px}',
  '.sap-ledgerSummaryLine{flex-wrap:wrap;gap:2px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:flex}',
  '.sap-ledgerStatSeg{color:var(--dsw-alias-label-secondary)}',
  '.sap-ledgerStat{color:var(--dsw-alias-label-primary);font-weight:600}',
  '.sap-ledgerSep{color:var(--dsw-alias-label-tertiary)}',
  '.sap-ledgerRows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}',
  '.sap-ledgerRow{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;display:flex}',
  '.sap-ledgerRowHead{box-sizing:border-box;width:100%;border:0;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;align-items:center;gap:10px;padding:10px 14px;font:inherit;text-align:left;flex-wrap:wrap;display:flex}',
  '.sap-ledgerRowHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.sap-ledgerTime{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:monospace;flex:none}',
  '.sap-ledgerMeta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0;word-break:break-word}',
  '.sap-ledgerToggle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;transition:transform .12s;margin-left:auto;flex:none;display:inline-flex}',
  '.sap-ledgerRowOpen .sap-ledgerToggle{transform:rotate(90deg)}',
  '.sap-ledgerExpand{flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding:10px 14px 12px;display:flex}',
  '.sap-ledgerSection{flex-direction:column;gap:6px;display:flex}',
  '.sap-ledgerSectionTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}',
  '.sap-ledgerTimeline{flex-direction:column;gap:8px;display:flex}',
  '.sap-ledgerStep{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:6px;padding:8px 10px;display:flex}',
  '.sap-ledgerStepHead{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
  '.sap-ledgerStepBody{flex-direction:column;gap:4px;display:flex}',
  '.sap-ledgerGate{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:6px;padding:8px 10px;display:flex}',
  '.sap-ledgerGateFail{background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-secondary)}',
  '.sap-ledgerGateHead{justify-content:space-between;align-items:center;gap:8px;display:flex}',
  '.sap-ledgerGateName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
  '.sap-ledgerGateVerdict{font-size:12px;font-weight:500;line-height:18px;flex:none}',
  '.sap-ledgerGateVerdictPass{color:var(--dsw-alias-state-success-primary)}',
  '.sap-ledgerGateVerdictFail{color:var(--dsw-alias-state-error-primary)}',
  '.sap-ledgerGateBody{flex-direction:column;gap:4px;display:flex}',
  '.sap-ledgerSubBlock{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;flex-direction:column;gap:6px;padding:8px 10px;display:flex}',
  '.sap-ledgerSubBlockTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;align-items:center;gap:6px;display:flex}',
  '.sap-ledgerSubBlockBody{flex-direction:column;gap:4px;display:flex}',
  '.sap-ledgerGateNested{flex-direction:column;gap:2px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;margin-left:2px;display:flex}',
  '.sap-ledgerGateKV{flex-wrap:wrap;align-items:baseline;gap:2px 8px;display:flex}',
  '.sap-ledgerGateKey{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:none}',
  '.sap-ledgerGateValue{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-family:monospace;word-break:break-all}',
  '.sap-ledgerReject{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
  '.sap-ledgerRejectFix{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
  '.sap-ledgerUsage{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
  '.sap-ledgerManual{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;align-items:baseline;gap:6px;display:flex}',
  '.sap-ledgerManualId{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-family:monospace;word-break:break-all}',
  '.sap-ledgerEmpty{flex-direction:column;gap:4px;padding:8px 2px;display:flex}',
  '.sap-ledgerEmptyTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;font-weight:500;line-height:22px}',
  '.sap-ledgerLoadOlder{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);background:0 0;border-radius:10px;font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 12px;cursor:pointer;align-self:flex-start;align-items:center;display:inline-flex}',
  '.sap-ledgerLoadOlder:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.sap-ledgerLoadOlder:disabled{opacity:.4;cursor:default}',
  '.sap-ledgerLegacy{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
  '.sap-ledgerCallsTable{border-collapse:collapse;width:100%;font-size:11px;line-height:16px}',
  '.sap-ledgerCallsTable th{color:var(--dsw-alias-label-secondary);font-weight:500;text-align:right;padding:2px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.sap-ledgerCallsTable td{color:var(--dsw-alias-label-primary);font-family:monospace;text-align:right;padding:2px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.sap-ledgerCallsIndex{color:var(--dsw-alias-label-tertiary);text-align:left!important;font-family:inherit!important}',
  '.sap-ledgerCallsTotal{font-weight:600;border-bottom:none}',
  '.sap-ledgerCallsNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
  '.sap-ledgerGateGroup{flex-direction:column;gap:2px;display:flex}',
  '.sap-ledgerRawJson{box-sizing:border-box;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:11px;line-height:16px;padding:0 4px;margin-left:auto;flex:none}',
  '.sap-ledgerRawJson:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.sap-ledgerJsonBody{flex-direction:column;gap:6px;display:flex}',
  '.sap-ledgerJsonBlock{flex-direction:column;gap:2px;display:flex}',
  '.sap-ledgerScope{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}',
  '.sap-ledgerWindowNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
  '.sap-escapeAdd{align-items:center;gap:8px;display:flex}',
  '.sap-chipRemove{box-sizing:border-box;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:4px;padding:0 4px;font-size:11px;line-height:16px}',
  '.sap-chipRemove:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}',
].join('\n')

// ── 纯数据：dispatch 卡片面向用户固定文案 ──────────────────────────────────

// 面向用户的固定文案。注意：此表仅集中 dispatch 卡片文案；设置页文案仍为
// 散落硬编码，属待迁移债（迁移时一次性并入此表）。
const ZH = {
  inlineProfile: '内联',
  inherit: '继承父',
  effortDefault: '默认（继承父）',
  chipProfile: '方案',
  chipPreset: '预设',
  chipProvider: '提供方',
  chipModel: '模型',
  chipEffort: '推理强度',
  chipTier: '档位',
  chipEnabled: '已启用',
  chipDisabled: '已禁用',
  ignoredMark: '已忽略',
  toolLabel: '派发子 Agent',
  detailOpen: '详情',
  detailClose: '收起',
  cont: 'continuable 子 Agent',
  canContinue: '可续跑',
  toolBackground: '后台任务',
  toolForeground: '前台',
  toolRunning: '运行中',
  tierZh: { cheap: '省 token（cheap）', balanced: '均衡（balanced）', premium: '高成本（premium）' },
  stopReasonZh: { completed: '完成', 'max-tokens': '超出预算', aborted: '已中止', refusal: '已拒绝', error: '出错' },
  cacheHit: '缓存命中',
  usageInput: '输入',
  usageOutput: '输出',
  usageCacheRead: '缓存读',
  usageCacheWrite: '缓存写',
  usageReasoning: '推理',
  persistFail: '已保存但未持久化',
  persistFailHint: '（磁盘写入未成功，重启 dsh web 后该改动可能丢失）',
  // 审计分级（设置页红字 + 丢失计数）
  auditDegraded: '审计记录写入异常（degraded）：请检查磁盘',
  auditLost: '审计丢失计数',
  // 派发账本（conversation.view 会话标签页）文案
  ledgerTab: '派发账本',
  ledgerSummary: '本会话派发',
  ledgerDispatch: '派发',
  ledgerTimes: '次',
  ledgerSuccess: '成功',
  ledgerReject: '拒绝',
  ledgerPass: '通过',
  ledgerTotalTokens: '总 token',
  ledgerTotalElapsed: '总耗时',
  ledgerElapsed: '耗时',
  ledgerStopReason: '结束原因',
  ledgerGateRejectDist: '各闸拒绝分布',
  ledgerByProfile: '按方案',
  ledgerByModel: '按模型',
  ledgerByTier: '按档位',
  ledgerEmpty: '本会话暂无派发记录',
  ledgerEmptyHint: '在此会话中派发一次子 Agent 后，即可查看完整的派发决策轨迹。',
  ledgerLoadOlder: '加载更早',
  ledgerLoadingOlder: '加载中…',
  ledgerLegacy: '该记录产生于决策轨迹上线前，仅有结果摘要',
  ledgerGateInput: '输入',
  ledgerGateOutput: '输出',
  ledgerRejectFix: '修复方向',
  ledgerJumpChild: '打开子会话',
  ledgerChildManual: '子会话 ID',
  ledgerJobManual: '后台任务 ID',
  ledgerStarted: '发起',
  ledgerParentContext: '父会话上下文',
  ledgerRequested: '请求值',
  ledgerEffectiveStep: '生效值',
  ledgerDecisionTimeline: '决策时间线',
  ledgerSettledStep: '结算',
  ledgerRawJson: '原始 JSON',
  ledgerFieldView: '字段视图',
  ledgerCallDetail: '逐次调用明细',
  ledgerCallsTotal: '合计',
  ledgerCallsTruncated: '仅显示前 {shown} 条，共 {total} 次调用',
  ledgerCallsIndex: '序号',
  ledgerExecutionStep: '执行信息',
  ledgerScopeNote: '本页仅展示本会话的派发决策轨迹；跨会话进化台账（dispatch.jsonl）与审计记录见设置页。',
  ledgerWindowNote: '已加载最近 {n} 条，尚有更早记录',
  ledgerCostLine: '估算成本 ≈{actual} 元（若继承父 ≈{counter} 元 · 省 ≈{saving} 元 · 约 {ratio}×）',
  ledgerInheritCost: '继承父模型派发 {count} 次（{ratio}%）——未指定模型，无降本机会',
  costNoPrice: '无单价/无用量，成本不显示',
  costInheritModel: '未指定模型（继承父）',
  whyUsable: '护栏',
  toolAllowlist: '工具',
  toolHostNarrow: '工具集由宿主收窄（插件侧未收录）',
  approvalNever: '审批 = never',
  gateFixUnknown: '未能识别的闸拒绝，请核对请求参数',
  ignoredChipTitle: '请求值 "{value}" 已忽略',
  ignoredChipTitleEmpty: '请求值已忽略',
  // 逃生舱（非 system-trust 预设放行）
  escapeTitle: '逃生舱（非 system-trust 预设放行）',
  escapeWarn: '逃生舱已开启：允许派发非 system-trust 预设。风险自负——其余三道安全闸仍全量生效，每个放行都会留审计记录。',
  escapeEmpty: '暂无放行预设',
  escapeAdd: '添加',
  escapeRemove: '移除',
  escapeInputPlaceholder: '非 system-trust 预设 id',
  escapeAddEmpty: '逃生舱预设 id 不能为空',
  // 只读建议注入（evolution:advice）
  adviceTitle: '只读建议注入（evolution:advice）',
  adviceDesc: '开启后编排者会话注入派发统计与确定性建议（仅父 Agent、只读、默认关）'
}

// ── 纯数据：设置页常量 ─────────────────────────────────────────────────────

const EMPTY_FORM = { id: '', description: '', preset: '', provider: '', model: '', reasoningEffort: '', toolMode: 'none', toolList: [] }
const EFFORT_ZH = { off: '关闭', high: '高', max: '最大' }
const TOOL_MODES = [
  ['none', '不限制（继承父的全部工具，自动剔除 run_code）'],
  ['allow', '白名单（只允许勾选的工具）'],
  ['deny', '黑名单（排除勾选的工具）'],
]
const CORE_ORDER = ['文件', '终端', '网络', '任务', '子 Agent', '工作流', '交互', '图片', 'Cordis', '计划']
const LAYER_TITLES = { core: '核心预设', plugin: '第三方插件', custom: '自建预设' }
// 派发账本：闸名中文标签（展示层同时保留英文技术标识）。
const GATE_LABELS = { whitelist: '白名单', cost: '成本', intersection: '交集', approval: '审批', budget: '预算', other: '其它' }
// 派发账本：失败闸的修复方向提示（指向设置页对应字段）。
const GATE_FIX_HINTS = {
  whitelist: '目标预设不在 system-trust 候选内，可在设置页改用受信任的预设',
  cost: '参数超出模型目录或成本上限，可在设置页调整提供方/模型/推理强度',
  intersection: '工具交集为空，可在设置页调整该方案的 toolFilter',
  approval: '审批策略冲突，请核对审批配置',
  budget: '并发派发数或本会话累计 token 已达上限，请等待在途任务完成或开启新会话'
}
// 派发账本：决策轨迹字段键名 → 中文标签（字段级渲染去「JSON 墙」用）。
// 未知键回退原样（不崩溃）；同义键（执行/结算/派发摘要字段）一并收录。
const GATE_KEY_LABELS = {
  requestedPreset: '目标预设', systemTrustCandidates: '候选白名单', allowed: '放行', resolvedPreset: '解析后预设',
  checks: '检查项', field: '字段', checkedAgainst: '对照项', verdict: '结论', detail: '详情', policy: '策略', applied: '应用值',
  effectiveAllowCount: '生效工具数', parentSessionId: '父会话', childSessionId: '子会话', jobId: '任务ID', reason: '原因', limit: '上限',
  skipped: '跳过', allowFailOpen: '兼容模式', mode: '模式', maxTokens: 'token 上限', maxDepth: '深度上限',
  requestedToolFilter: '请求工具过滤', parentToolCount: '父工具数', providers: '提供方', modelEfforts: '模型支持档位',
  effectiveToolNames: '生效工具', preset: '目标预设', profile: '方案', provider: '提供方', model: '模型',
  reasoningEffort: '推理强度', tokenTier: '档位', persona_present: '是否设置人格', toolFilter_present: '是否设置工具过滤',
  prompt_excerpt: '任务摘要', prompt_truncated: '任务已截断', envelope: '信封模式', parentPreset: '父预设', parentProvider: '父提供方',
  parentModel: '父模型', outcome: '结果', status: '状态', stop_reason: '结束原因', elapsed_ms: '耗时',
  output_len: '输出长度', tool_count: '工具调用数'
}
const smallBtn = { height: '24px', padding: '0 8px', fontSize: '12px', borderRadius: '12px' }

// 审计分级的默认态（summary 缺 audit 字段 / 值非法时回退）：health ok、零丢失。
const AUDIT_DEFAULTS = { lostTelemetry: 0, lostGovernance: 0, health: 'ok' }

// 从 /options/summary 响应抽取 audit 分级；缺失/非法字段 fallback 到默认态。
function readAuditFromData(data) {
  const a = data !== null && typeof data === 'object' && data.audit !== null && typeof data.audit === 'object' ? data.audit : {}
  return {
    lostTelemetry: typeof a.lostTelemetry === 'number' ? a.lostTelemetry : 0,
    lostGovernance: typeof a.lostGovernance === 'number' ? a.lostGovernance : 0,
    health: a.health === 'degraded' ? 'degraded' : 'ok'
  }
}

// /options/summary 响应 → 设置页状态（enabled/options/audit/逃生舱开关与放行集）。
// set 为各 setter 的注入对象；escapePresets 非数组回退空数组，escapeEnabled 仅 true 才开。
function applySummaryData(data, set) {
  set.enabled(data.enabled !== false)
  set.options({
    models: Array.isArray(data.models) ? data.models : [],
    efforts: {},
    presets: Array.isArray(data.presets) ? data.presets : []
  })
  set.audit(readAuditFromData(data))
  set.escapeEnabled(data.escapeEnabled === true)
  set.escapePresets(Array.isArray(data.escapePresets) ? data.escapePresets : [])
  set.evolutionAdvice(data.evolutionAdvice === true)
}

// ── 纯函数：api / 样式注入 / 文案映射 ──────────────────────────────────────

// loopback HTTP，host 侧服务 /subagent-profiles/*。
async function api(path, payload) {
  const init = payload === undefined
    ? undefined
    : {
        method: 'POST',
        // 写请求带 CSRF 三件套里的 Content-Type + 自定义头（Origin 由浏览器自动带）。
        // 缺自定义头会被 host 侧写路由 CSRF 守卫 403 拒绝。
        headers: { 'Content-Type': 'application/json', 'X-DSH-Plugin': 'dsh-subagent-profile' },
        body: JSON.stringify(payload),
      }
  const res = await fetch(`/subagent-profiles${path}`, init)
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error(`宿主返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!data.ok) throw new Error(data.error || '请求失败')
  return data
}

function ensureStyles() {
  const tagId = 'dsh-subagent-profile/ProfilesSection.css'
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-subagent-profile'
  style.dataset.pluginCss = tagId
  style.textContent = CSS
  document.head.appendChild(style)
}

const effortZh = (id) => {
  if (id === undefined || id === null || id === '') return ZH.inherit
  if (id === '(default)') return ZH.effortDefault
  if (id === '(parent)' || id === 'undefined') return ZH.inherit
  return EFFORT_ZH[id] ? `${EFFORT_ZH[id]}（${id}）` : id
}
const presetZh = (v) => (v === 'inherit' ? ZH.inherit : (typeof v === 'string' && v !== '' ? v : ZH.inherit))
const profileZh = (v) => (v === undefined || v === '' || v === '(inline)' ? ZH.inlineProfile : v)
// profile id → 中文显示名：注册表有 name 时「标准编码（swap-standard）」中英双表达，
// 无 name（自定义方案可能只填了 description）时回退纯 id。技术标识 id 恒保留。
function profileDisplay(profileId, profileNames) {
  if (profileId === undefined || profileId === '' || profileId === '(inline)') return ZH.inlineProfile
  const name = profileNames !== undefined && profileNames !== null ? profileNames[profileId] : undefined
  return typeof name === 'string' && name !== '' ? `${name}（${profileId}）` : profileId
}
const rawOrInherit = (v) => (v === '(parent)' ? ZH.inherit : (typeof v === 'string' && v !== '' ? v : ZH.inherit))

// ── 省 token 证据（client 侧反事实对照，Task 38d）─────────────────────────
// 与 host 侧 lib/core/cost-evidence.mjs 同源同价（估算、非精确计费）；只读展示。
const CLIENT_MODEL_AVG_COST = { 'deepseek-v4-flash': 0.0039, 'deepseek-v4-pro': 0.0104 }
const clientPriceKey = (model) => {
  if (typeof model !== 'string' || model === '') return undefined
  const m = model.trim().toLowerCase()
  if (CLIENT_MODEL_AVG_COST[m] !== undefined) return m
  if (m.includes('flash')) return 'deepseek-v4-flash'
  if (m.includes('pro')) return 'deepseek-v4-pro'
  return undefined
}
const clientAvgCost = (model) => {
  const key = clientPriceKey(model)
  return key === undefined ? undefined : CLIENT_MODEL_AVG_COST[key]
}
// 单条派发的估算成本（元）。trace 已归一；请求值 requested.model 才是「显式选了什么」，
// effective.model 会把继承父模型名写进去，不能用于判定继承。
function traceCostInfo(trace) {
  if (!trace) return null
  const requestedModel = trace.requested && typeof trace.requested.model === 'string' ? trace.requested.model : ''
  const parentModel = trace.parentContext && typeof trace.parentContext.parentModel === 'string' ? trace.parentContext.parentModel : ''
  if (requestedModel === '') {
    const actual = clientAvgCost(parentModel)
    if (actual === undefined) return null
    return { inherit: true, actual, counterfactual: actual, saving: 0, ratio: null }
  }
  const actual = clientAvgCost(requestedModel)
  const counterfactual = clientAvgCost(parentModel)
  if (actual === undefined || counterfactual === undefined) return null
  const saving = Number((counterfactual - actual).toFixed(6))
  return { inherit: false, actual, counterfactual, saving, ratio: actual > 0 ? Number((counterfactual / actual).toFixed(2)) : null }
}
function recordCostInfo(record) {
  return traceCostInfo(record && record.trace)
}
function costText(info) {
  if (!info) return ''
  if (info.inherit) return ' · ≈' + info.actual + ' 元（' + ZH.costInheritModel + '）'
  return ' · ≈' + info.actual + ' 元（继承父 ≈' + info.counterfactual + ' 元 · 省 ' + info.saving + ' 元）'
}

// 模型选择审计自动标注（Task 37d）：三类确定性标注。返回 [{key,label,title}]，
// 供 ② 决策段与行摘要 chip 使用；所有判定只读 trace 记录面，不做模型偏好推断。
function auditModelChoice(trace) {
  if (!trace) return []
  const requested = trace.requested || {}
  const effective = trace.effective || {}
  const out = []
  const profile = typeof requested.profile === 'string' && requested.profile !== '' && requested.profile !== '(inline)' ? requested.profile : ''
  const snapshot = Array.isArray(requested.profiles_snapshot) ? requested.profiles_snapshot : []
  if (profile !== '' && snapshot.length > 0 && !snapshot.some((e) => e && e.id === profile)) {
    out.push({ key: 'outside-snapshot', label: '快照外选择', title: '请求的方案不在记录面目录快照内（可能被截断或已变更）' })
  }
  const requestedModel = typeof requested.model === 'string' && requested.model !== '' ? requested.model : ''
  const effectiveModel = typeof effective.model === 'string' && effective.model !== '' ? effective.model : ''
  if (requestedModel !== '' && effectiveModel !== '' && requestedModel !== effectiveModel) {
    out.push({ key: 'rewritten', label: '请求被改写', title: '请求模型与生效模型不一致（命中即 bug 信号）' })
  }
  const info = traceCostInfo(trace)
  if (info && !info.inherit && info.actual !== undefined) {
    const cheaper = snapshot.find((e) => e && typeof e.avgCost === 'number' && Number.isFinite(e.avgCost) && e.avgCost < info.actual * 0.7)
    if (cheaper !== undefined) {
      out.push({ key: 'cheaper-available', label: '更便宜候选可用', title: '目录内存在成本低 30% 以上的候选方案（仅供参考）' })
    }
  }
  return out
}
// Task 44：护栏结果一行（与 decisionTrace.gates 同源，只宣告可验证护栏结果）。
function gateVerdict(trace, name) {
  if (!trace || !Array.isArray(trace.gates)) return ''
  const gate = trace.gates.find((g) => g && g.name === name)
  return gate ? gate.verdict : ''
}
function whyUsableText(trace) {
  if (!trace) return ''
  const parts = []
  for (const name of ['whitelist', 'cost', 'intersection']) {
    const verdict = gateVerdict(trace, name)
    if (verdict === 'pass') parts.push(gateLabelZh(name) + ' ✅')
    else if (verdict === 'fail') parts.push(gateLabelZh(name) + ' ❌')
  }
  parts.push(ZH.approvalNever)
  return parts.length > 0 ? parts.join(' · ') : ''
}
// 工具集摘要：continuable 有预加工闭集可显示；非 continuable 诚实降级不虚报数字。
function toolAllowlistText(request, trace) {
  const effective = trace && trace.effective
  const count = effective && Number.isFinite(effective.effectiveToolCount) ? effective.effectiveToolCount : null
  if (request && request.continuable) {
    const allow = request.toolFilter && Array.isArray(request.toolFilter.allow) ? request.toolFilter.allow : null
    if (allow !== null) return '父 → 子 ' + allow.length + ' 工具（剔 run_code）'
    return ''
  }
  if (count !== null) return '父 → 子 ' + count + ' 工具'
  return ZH.toolHostNarrow
}

const effortLabel = (effort) => {
  const id = effort && effort.id
  return EFFORT_ZH[id] ? `${EFFORT_ZH[id]}（${id}）` : (effort && effort.name) || id
}

// 不同 provider 列表，由模型列表派生。
function deriveProviders(models) {
  const providers = []
  const seenProvider = new Set()
  for (const model of models) {
    if (seenProvider.has(model.provider)) continue
    seenProvider.add(model.provider)
    providers.push({ id: model.provider, name: model.providerName || model.provider })
  }
  return providers
}

// ── 纯函数：dispatch 块解析 ────────────────────────────────────────────────

// 请求值：argsRaw（运行中 / 已结算两种 block 形态都有）。
function readDispatchRequest(block) {
  const out = { profile: '', preset: '', provider: '', model: '', reasoningEffort: '', continuable: false, runInBackground: false }
  if (!block || typeof block !== 'object') return out
  const done = 'kind' in block
  const argsRaw = (done ? (block.call && block.call.argsRaw) : block.argsRaw) ?? ''
  if (typeof argsRaw !== 'string' || argsRaw === '') return out
  try {
    const parsed = JSON.parse(argsRaw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['profile', 'preset', 'provider', 'model', 'reasoningEffort']) {
        if (typeof parsed[key] === 'string' && parsed[key] !== '') out[key] = parsed[key]
      }
      out.continuable = parsed.continuable === true
      out.runInBackground = parsed.run_in_background === true
    }
  } catch {
    // unparsable argsRaw：保持默认（继承/内联口径）。
  }
  return out
}

// 结果 meta（生效值）：宿主 render 行（"[dispatch] …"）是持久回放的唯一
// 生效值来源——结构化 value 只存在于执行局部（dsh-tools 约定）。output.presentationMeta
// 现投影 decisionTrace（block.meta 承载决策轨迹，非生效值），生效值仍需从 render 行解析。
// 解析成功返回 {kind, id, fields, ignored}；任何一步不符预期返回 null，调用方回退请求值。
const DISPATCH_RESULT_KEYS = ['profile', 'preset', 'provider', 'model', 'reasoningEffort', 'tokenTier', 'childTotalTokens', 'childUsage', 'elapsedMs', 'stopReason']
function parseDispatchText(text) {
  if (typeof text !== 'string') return null
  const firstLine = text.split('\n')[0] ?? ''
  if (!firstLine.startsWith('[dispatch] ')) return null
  let rest = firstLine.slice('[dispatch] '.length)
  let kind = 'foreground'
  let id = ''
  if (rest.startsWith('background job ')) {
    kind = 'background'
    rest = rest.slice('background job '.length)
  } else if (rest.startsWith('started subagent ')) {
    kind = 'continuable'
    rest = rest.slice('started subagent '.length)
  }
  if (kind !== 'foreground') {
    const sep = rest.indexOf(' · ')
    id = sep >= 0 ? rest.slice(0, sep) : rest
    rest = sep >= 0 ? rest.slice(sep + 3) : ''
  }
  const fields = {}
  let ignored = []
  let known = 0
  for (const seg of rest.split(' · ')) {
    const eq = seg.indexOf('=')
    if (eq <= 0) continue
    const key = seg.slice(0, eq)
    if (!DISPATCH_RESULT_KEYS.includes(key)) continue
    let value = seg.slice(eq + 1)
    const m = /^(.+)\(ignored:\s*([^)]*)\)$/.exec(value)
    if (m !== null) {
      value = m[1]
      ignored = m[2].split(',').map((s) => s.trim()).filter((s) => s !== '')
    }
    if (value === 'undefined') value = ''   // 旧版把该字段渲染为字面 undefined，此处归一为空
    fields[key] = value
    known += 1
  }
  if (known <= 0) return null
  return { kind, id, fields, ignored }
}

function readDispatchResult(block) {
  if (!block || typeof block !== 'object' || !('kind' in block)) return null
  const content = block.content
  if (!Array.isArray(content)) return null
  for (const item of content) {
    if (item && typeof item === 'object' && typeof item.text === 'string') {
      const parsed = parseDispatchText(item.text)
      if (parsed !== null) return parsed
    }
  }
  return null
}

// childTotalTokens 文本后缀：宿主 render 行里的 `childTotalTokens=<number>` 经
// parseDispatchText 解析为字符串，此处归一为「≈N tokens」。仅前台/后台 completed
// 结算携带；无值返回空串（不显示）。渲染位置紧邻后续的耗时显示。
function tokensSuffix(result, block) {
  let raw = null
  if (result && result.fields && result.fields.childTotalTokens !== undefined && result.fields.childTotalTokens !== '') {
    raw = result.fields.childTotalTokens
  } else if (block && block.meta && typeof block.meta === 'object' && block.meta.childTotalTokens !== undefined) {
    raw = block.meta.childTotalTokens
  }
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw !== '' ? Number(raw) : NaN)
  return Number.isFinite(n) ? ` · ≈${n} tokens` : ''
}

// 耗时 + 结束原因后缀：宿主 render 行里的 `elapsedMs=<n>` / `stopReason=<enum>`
// 经 parseDispatchText 解析为字符串，此处归一为「耗时=<n>ms · stopReason=<中文映射>」。
// 仅前台 completed 结算携带；后台结算经 job 结果呈现（不进 dispatch 卡片），
// continuable 不结算、不携带。任一字段缺失即省略该段。
function observabilitySuffix(result, block) {
  let elapsedRaw = null
  let stopRaw = null
  if (result && result.fields) {
    if (result.fields.elapsedMs !== undefined && result.fields.elapsedMs !== '') elapsedRaw = result.fields.elapsedMs
    if (result.fields.stopReason !== undefined && result.fields.stopReason !== '') stopRaw = result.fields.stopReason
  } else if (block && block.meta && typeof block.meta === 'object') {
    // 运行中（无结果）或旧版结果：回退调用块 meta（向前兼容，与 tokenTier 同口径）。
    if (block.meta.elapsedMs !== undefined) elapsedRaw = block.meta.elapsedMs
    if (block.meta.stopReason !== undefined) stopRaw = block.meta.stopReason
  }
  const ms = typeof elapsedRaw === 'number' ? elapsedRaw : (typeof elapsedRaw === 'string' && elapsedRaw !== '' ? Number(elapsedRaw) : NaN)
  const stopZh = typeof stopRaw === 'string' ? (ZH.stopReasonZh[stopRaw] || stopRaw) : ''
  if (!Number.isFinite(ms) && stopZh === '') return ''
  let out = ''
  if (Number.isFinite(ms)) out += ` · 耗时=${ms}ms`
  if (stopZh !== '') out += ` · stopReason=${stopZh}`
  return out
}

// 把 childUsage 的（render 行 JSON 字符串或 block.meta 对象）归一为五段对象；
// 非 object / 非 number 段忽略，无任何有效段返回 null。可选字段（缓存读/写/推理）
// 缺值省略键，与 host 侧 collectChildUsage 输出对齐。
function parseChildUsage(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  let usage = raw
  if (typeof raw === 'string') {
    try { usage = JSON.parse(raw) } catch { return null }
  }
  if (typeof usage !== 'object' || Array.isArray(usage)) return null
  const out = {}
  let any = false
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = value
      any = true
    }
  }
  return any ? out : null
}

// 读取真实计费五段分解：result.fields.childUsage（render 行 JSON 串）优先，回退
// block.meta.childUsage（对象，向前兼容旧结果/未来 presentationMeta 投射）。
function usageFrom(result, block) {
  if (result && result.fields && result.fields.childUsage !== undefined && result.fields.childUsage !== '') {
    const parsed = parseChildUsage(result.fields.childUsage)
    if (parsed !== null) return parsed
  }
  if (block && block.meta && typeof block.meta === 'object' && block.meta.childUsage !== undefined) {
    return parseChildUsage(block.meta.childUsage)
  }
  return null
}

// 缓存命中后缀：childUsage.cacheReadTokens 存在且 >0 时追加「 · 缓存命中 M」到
// ≈N tokens 之后（前导分隔符与 tokensSuffix/observabilitySuffix 同口径，即使
// tokens 段缺失也不会粘在一起）；无分解或缓存读为 0/缺失时返回空串。
function cacheHitSuffix(usage) {
  if (usage === null) return ''
  const cacheRead = usage.cacheReadTokens
  return typeof cacheRead === 'number' && cacheRead > 0 ? ` · ${ZH.cacheHit} ${cacheRead}` : ''
}

// 五段分解行文案（纯函数，供卡片详情区渲染）；无任何有效段返回空串。
function usageBreakdownText(usage) {
  if (usage === null || typeof usage !== 'object') return ''
  const parts = []
  const push = (label, value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) parts.push(`${label} ${value}`)
  }
  push(ZH.usageInput, usage.inputTokens)
  push(ZH.usageOutput, usage.outputTokens)
  push(ZH.usageCacheRead, usage.cacheReadTokens)
  push(ZH.usageCacheWrite, usage.cacheWriteTokens)
  push(ZH.usageReasoning, usage.reasoningTokens)
  return parts.join(' · ')
}

// ── 纯函数：派发账本数据层（快照遍历 / 轨迹归一 / 汇总统计 / 失败合并）────────

// 把 string|number 归一为有限数，不可得返回 null（汇总与行级数字的统一口径）。
function toFiniteNumber(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  return Number.isFinite(n) ? n : null
}

// 非数组对象守卫：对象原样返回，其它（null/数组/原始值）返回空对象。
function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

// 从 result 内容块取首行文本（只取第一块非空文本，无文本返回空串）。
function firstContentLine(content) {
  if (!Array.isArray(content)) return ''
  for (const item of content) {
    if (item && typeof item === 'object' && typeof item.text === 'string' && item.text !== '') {
      return item.text.split('\n')[0] ?? ''
    }
  }
  return ''
}

// argsRaw 摘要：dispatch 参数为单行 JSON，取首行即完整摘要；空/坏返回空串。
function summarizeArgsRaw(argsRaw) {
  if (typeof argsRaw !== 'string' || argsRaw === '') return ''
  return argsRaw.split('\n')[0] ?? ''
}

// gate 条目归一：只保留渲染需要的五字段，name/verdict/reason 逐字段 typeof 守卫、
// 缺失补空串；input/output 缺省为空对象；非对象条目整条丢弃。
function normalizeGateEntries(gates) {
  if (!Array.isArray(gates)) return []
  const out = []
  for (const gate of gates) {
    if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) continue
    out.push({
      name: typeof gate.name === 'string' ? gate.name : '',
      input: asObject(gate.input),
      output: asObject(gate.output),
      verdict: typeof gate.verdict === 'string' ? gate.verdict : '',
      reason: typeof gate.reason === 'string' ? gate.reason : ''
    })
  }
  return out
}

// decisionTrace 归一：坏数据/缺字段 fail-soft（逐段 typeof 守卫，不 throw）。
// 非对象或无任何可识别 shape（version/startedAt/gates 三者皆缺）返回 null；
// 各段缺失补空对象，settled 缺省为 null（区分「未结算」与「结算但为空」）。
function normalizeDecisionTrace(raw) {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.version !== 'number' && typeof raw.startedAt !== 'number' && !Array.isArray(raw.gates)) return null
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : null,
    parentContext: asObject(raw.parentContext),
    requested: asObject(raw.requested),
    gates: normalizeGateEntries(raw.gates),
    effective: asObject(raw.effective),
    execution: asObject(raw.execution),
    settled: raw.settled && typeof raw.settled === 'object' && !Array.isArray(raw.settled) ? raw.settled : null
  }
}

// 从 tool-result 节点读决策轨迹：宿主 presentationMeta 把 decisionTrace 直接投影为
// 节点 meta（meta 即 trace 本身）；同时兼容未来包一层 .decisionTrace 的形态，
// 两种都尝试、绝不 throw。
function readNodeTrace(node) {
  const meta = node && typeof node === 'object' ? node.meta : null
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  const direct = normalizeDecisionTrace(meta)
  if (direct !== null) return direct
  if (meta.decisionTrace && typeof meta.decisionTrace === 'object' && !Array.isArray(meta.decisionTrace)) {
    return normalizeDecisionTrace(meta.decisionTrace)
  }
  return null
}

// 快照遍历：过滤 chat.legacy.nodes 中 kind==='tool-result' 且 call.name==='dispatch'
// 的节点，产出账本记录。记录携带 callId/time/isError/trace（已归一，null 即旧记录
// 降级 legacy）/request/result/argsSummary/contentFirstLine。输入为空或非数组返回
// 空数组；逐节点守卫、坏节点跳过。
function collectDispatchRecords(nodes) {
  if (!Array.isArray(nodes)) return []
  const records = []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    if (node.kind !== 'tool-result') continue
    if (!node.call || typeof node.call !== 'object' || node.call.name !== 'dispatch') continue
    const trace = readNodeTrace(node)
    records.push({
      callId: typeof node.callId === 'string' ? node.callId : '',
      time: typeof node.time === 'number' ? node.time : (typeof node.callTime === 'number' ? node.callTime : null),
      isError: node.isError === true,
      legacy: trace === null,
      trace,
      request: readDispatchRequest(node),
      result: readDispatchResult(node),
      argsSummary: summarizeArgsRaw(node.call.argsRaw),
      contentFirstLine: firstContentLine(node.content)
    })
  }
  return records
}

// 从单条记录提取结算数字：trace.settled 优先，缺失回退 result.fields（旧记录口径）。
// 返回 { tokens, cacheRead, elapsedMs }；不可得字段为 null/0。
function recordNumbers(record) {
  let tokens = null
  let elapsedMs = null
  let cacheRead = 0
  const trace = record && record.trace
  const result = record && record.result
  const settled = trace && trace.settled
  if (settled) {
    tokens = toFiniteNumber(settled.childTotalTokens)
    elapsedMs = toFiniteNumber(settled.elapsedMs)
    if (settled.childUsage && typeof settled.childUsage.cacheReadTokens === 'number') cacheRead = settled.childUsage.cacheReadTokens
  }
  if (result && result.fields) {
    if (tokens === null) tokens = toFiniteNumber(result.fields.childTotalTokens)
    if (elapsedMs === null) elapsedMs = toFiniteNumber(result.fields.elapsedMs)
    if (cacheRead === 0) {
      const usage = parseChildUsage(result.fields.childUsage)
      if (usage && typeof usage.cacheReadTokens === 'number') cacheRead = usage.cacheReadTokens
    }
  }
  return { tokens, cacheRead, elapsedMs }
}

// 判定记录是否被拒绝：trace 任一闸 verdict==='fail' 视为闸拒绝；无 trace 且 isError
// 视为拒绝（旧错误块无法区分闸拒绝与运行时错误，统一计拒绝）。
function recordIsRejected(record) {
  if (!record) return false
  const gates = record.trace && Array.isArray(record.trace.gates) ? record.trace.gates : []
  if (gates.some((gate) => gate.verdict === 'fail')) return true
  return record.isError === true
}

// 累加记录各失败闸到闸拒绝分布；未知闸名归入 other（counts 已含五键）。
function countGateRejects(record, counts) {
  if (!record || !record.trace || !Array.isArray(record.trace.gates)) return
  for (const gate of record.trace.gates) {
    if (gate.verdict !== 'fail') continue
    const key = Object.prototype.hasOwnProperty.call(counts, gate.name) ? gate.name : 'other'
    counts[key] += 1
  }
}

// 记录归属方案：effective.profile → requested.profile → request.profile 依次回退；
// 缺失返回空串（不参与 byProfile 计数）。
function recordProfile(record) {
  if (!record) return ''
  const trace = record.trace
  if (trace && trace.effective && typeof trace.effective.profile === 'string' && trace.effective.profile !== '') return trace.effective.profile
  if (trace && trace.requested && typeof trace.requested.profile === 'string' && trace.requested.profile !== '') return trace.requested.profile
  if (record.request && typeof record.request.profile === 'string') return record.request.profile
  return ''
}

// 累加单条记录的反事实成本到汇总（Task 38d）。
function accumulateRecordCost(summary, record) {
  const cost = recordCostInfo(record)
  if (cost === null) return
  summary.pricedCount += 1
  summary.estimatedCost += cost.actual
  summary.estimatedInheritCost += cost.counterfactual
  summary.estimatedSaving += cost.saving
  if (cost.inherit) summary.inheritCount += 1
}

// 成本汇总定稿：四舍五入到可展示精度，继承占比按百分数取整。
function finalizeLedgerCost(summary) {
  summary.estimatedCost = Number(summary.estimatedCost.toFixed(4))
  summary.estimatedInheritCost = Number(summary.estimatedInheritCost.toFixed(4))
  summary.estimatedSaving = Number(summary.estimatedSaving.toFixed(4))
  summary.inheritRatio = summary.pricedCount > 0 ? Number(((summary.inheritCount / summary.pricedCount) * 100).toFixed(0)) : 0
}

// 会话汇总：与账本汇总带对齐。records 为合并后的完整记录列表（含失败记录）。
// 旧记录贡献可得字段（次数/耗时/token），不可得记 0/省略；闸拒绝按 trace.gates
// 的 fail verdict 分布。byProfile/byModel/byTier 均按次数降序。
function computeLedgerSummary(records) {
  const list = Array.isArray(records) ? records : []; const summary = {
    dispatchCount: list.length,
    successCount: 0,
    rejectCount: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    totalElapsedMs: 0,
    estimatedCost: 0,
    estimatedInheritCost: 0,
    estimatedSaving: 0,
    inheritCount: 0,
    inheritRatio: 0,
    pricedCount: 0,
    gateRejectCounts: { whitelist: 0, cost: 0, intersection: 0, approval: 0, other: 0 },
    byProfile: [],
    byModel: [],
    byTier: []
  }
  const profileMap = new Map(), modelMap = new Map(), tierMap = new Map()
  for (const record of list) {
    if (recordIsRejected(record)) summary.rejectCount += 1
    else summary.successCount += 1
    const { tokens, cacheRead, elapsedMs } = recordNumbers(record)
    if (tokens !== null) summary.totalTokens += tokens
    summary.cacheHitTokens += cacheRead
    if (elapsedMs !== null) summary.totalElapsedMs += elapsedMs
    accumulateRecordCost(summary, record)
    countGateRejects(record, summary.gateRejectCounts)
    const profile = recordProfile(record)
    if (profile !== '') profileMap.set(profile, (profileMap.get(profile) || 0) + 1)
    // 模型：空/'(parent)'（继承父标记）并入继承桶（键为空串，展示层经 rawOrInherit 归一）。
    const model = recordModel(record)
    if (model === '' || model === '(parent)') modelMap.set('', (modelMap.get('') || 0) + 1)
    else modelMap.set(model, (modelMap.get(model) || 0) + 1)
    const tier = recordTier(record)
    if (tier !== '') tierMap.set(tier, (tierMap.get(tier) || 0) + 1)
  }
  summary.byProfile = [...profileMap.entries()]
    .map(([profile, count]) => ({ profile, count }))
    .sort((a, b) => b.count - a.count)
  summary.byModel = [...modelMap.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count)
  summary.byTier = [...tierMap.entries()]
    .map(([tier, count]) => ({ tier, count }))
    .sort((a, b) => b.count - a.count)
  finalizeLedgerCost(summary)
  return summary
}

// 拉取失败台账：经既有 api() 走 GET /ledger/failures?session=<id>，失败项同样经
// normalizeDecisionTrace 归一。host 侧经 stateFile（subagent-profiles.failed-traces.json）
// 落盘，重启后仍可读；host 不可达/路由缺失/坏数据一律 fail-soft 返回空数组。
async function fetchLedgerFailures(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return []
  try {
    const data = await api(`/ledger/failures?session=${encodeURIComponent(sessionId)}`)
    const list = Array.isArray(data.failures) ? data.failures : []
    const out = []
    for (const item of list) {
      const trace = normalizeDecisionTrace(item)
      if (trace !== null) out.push(trace)
    }
    return out
  } catch {
    return []
  }
}

// 由失败 trace 构造独立账本记录（快照内无对应错误块时）：request 从 requested/
// execution 还原，callId/argsSummary/contentFirstLine 为空，标记 failureOnly。
function failureRecord(failure) {
  const requested = asObject(failure && failure.requested)
  const execution = asObject(failure && failure.execution)
  const request = {
    profile: typeof requested.profile === 'string' ? requested.profile : '',
    preset: typeof requested.preset === 'string' ? requested.preset : '',
    provider: typeof requested.provider === 'string' ? requested.provider : '',
    model: typeof requested.model === 'string' ? requested.model : '',
    reasoningEffort: typeof requested.reasoningEffort === 'string' ? requested.reasoningEffort : '',
    continuable: execution.kind === 'continuable' || execution.mode === 'continuable',
    runInBackground: execution.kind === 'background'
  }
  return {
    callId: '',
    time: failure && typeof failure.startedAt === 'number' ? failure.startedAt : null,
    isError: true,
    legacy: false,
    trace: failure,
    request,
    result: null,
    argsSummary: '',
    contentFirstLine: '',
    failureOnly: true
  }
}

// 失败记录合并：把失败台账与快照错误块按 startedAt 就近匹配（±2s 窗口）。
// 匹配成功 → 失败 trace 回填进对应错误块记录（isError 且无 trace）；匹配失败 →
// 独立列为新记录（failureOnly 标记）。返回合并后的完整记录列表，不修改输入数组。
function mergeFailureRecords(settledRecords, failures) {
  const records = (Array.isArray(settledRecords) ? settledRecords : []).map((record) => ({ ...record }))
  const failureList = Array.isArray(failures) ? failures : []
  const unmatched = []
  for (const failure of failureList) {
    const ts = failure && typeof failure.startedAt === 'number' ? failure.startedAt : null
    let matched = false
    if (ts !== null) {
      for (const record of records) {
        if (record.isError !== true || record.trace !== null) continue
        if (typeof record.time !== 'number') continue
        if (Math.abs(record.time - ts) <= 2000) {
          record.trace = failure
          record.legacy = false
          matched = true
          break
        }
      }
    }
    if (!matched) unmatched.push(failure)
  }
  for (const failure of unmatched) records.push(failureRecord(failure))
  return records
}

// ── dispatch 工具卡（React 依赖经参数注入）─────────────────────────────────

// 生效值：结果解析成功用结果（优先），字段缺失回退请求值。
function resolveDispatchState(request, result, settled) {
  const eff = {
    profile: result ? (result.fields.profile || request.profile) : request.profile,
    preset: result ? (result.fields.preset || request.preset) : request.preset,
    provider: result ? (result.fields.provider || request.provider) : request.provider,
    model: result ? (result.fields.model || request.model) : request.model,
    reasoningEffort: result ? (result.fields.reasoningEffort || request.reasoningEffort) : request.reasoningEffort
  }
  // ignored 列表：已结算读结果；运行中（无结果）按已知降级规则预判——
  // continuable 恒忽略 preset 换用与 reasoningEffort（与结果同口径）。
  const ignored = result ? result.ignored.slice() : []
  if (!settled && request.continuable) {
    if (request.preset !== '' && request.preset !== 'inherit' && !ignored.includes('preset')) ignored.push('preset')
    if (request.reasoningEffort !== '' && !ignored.includes('reasoningEffort')) ignored.push('reasoningEffort')
  }
  // 请求≠生效：被忽略字段的生效值 = 确定性降级值。
  if (ignored.includes('preset')) eff.preset = 'inherit'
  if (ignored.includes('reasoningEffort')) eff.reasoningEffort = '(default)'

  let kindLabel
  const kindPrefix = request.continuable ? ZH.cont : (request.runInBackground ? ZH.toolBackground : ZH.toolForeground)
  // 运行/结算标签判据 = settled（`'kind' in block`）：已结算块即使 render 为
  // 旧格式不可解析（result===null）也绝不落入「运行中」分支。
  if (settled) {
    if (result) {
      if (result.kind === 'background') kindLabel = `${ZH.toolBackground} #${result.id}`
      else if (result.kind === 'continuable') kindLabel = `${ZH.cont} #${result.id}（${ZH.canContinue}）`
      else kindLabel = ZH.toolForeground
    } else {
      // 已结算但结果不可解析：kind 由请求值推导，不带「运行中」。
      kindLabel = kindPrefix
    }
  } else {
    kindLabel = `${kindPrefix}（${ZH.toolRunning}）`
  }
  return { eff, ignored, kindLabel }
}

function buildDispatchChips(el, chip, eff, result, block, ignored, request) {
  const chips = []
  chips.push(chip('profile', ZH.chipProfile, profileZh(eff.profile)))
  // preset 继承值（'inherit' 或未请求即空串，均渲染为「继承父」）与
  // provider·model / effort 一样弱显。
  chips.push(chip('preset', ZH.chipPreset, presetZh(eff.preset), { dim: eff.preset === 'inherit' || eff.preset === '' }))
  const p = rawOrInherit(eff.provider)
  const m = rawOrInherit(eff.model)
  chips.push(chip('providerModel', `${ZH.chipProvider}·${ZH.chipModel}`, p === ZH.inherit && m === ZH.inherit ? ZH.inherit : `${p} / ${m}`, { dim: p === ZH.inherit && m === ZH.inherit }))
  chips.push(chip('effort', ZH.chipEffort, effortZh(eff.reasoningEffort), { dim: eff.reasoningEffort === '' || eff.reasoningEffort === '(default)' }))
  // tokenTier：宿主 render 行已产出；result.fields 缺失时回退 block.meta（向前兼容旧结果）。
  let tier = ''
  if (result && result.fields && typeof result.fields.tokenTier === 'string' && result.fields.tokenTier !== '') {
    tier = result.fields.tokenTier
  } else if (block && block.meta && typeof block.meta === 'object' && typeof block.meta.tokenTier === 'string' && block.meta.tokenTier !== '') {
    tier = block.meta.tokenTier
  }
  if (tier !== '') chips.push(chip('tier', ZH.chipTier, ZH.tierZh[tier] || tier))
  // ignored 项：警示色、置于 chip 行末尾（非静默）。
  for (const key of ignored) {
    const reqVal = request[key] || ''
    chips.push(el('span', {
      key: `ignored-${key}`,
      className: 'sap-chip sap-chipWarn',
      title: reqVal !== '' ? `请求值 "${reqVal}" 已忽略` : '请求值已忽略'
    }, `⬆${key}(${ZH.ignoredMark})`))
  }
  return chips
}

/** 统一 chip 元素：label + value，dim=继承/默认值弱显。 */
function makeChip(el) {
  const chip = (key, label, value, opts) => {
    const valueCls = opts && opts.dim ? 'sap-chipValueDim' : 'sap-chipValue'
    return el('span', {
      key,
      className: 'sap-chip',
      ...(opts && typeof opts.title === 'string' && opts.title !== '' ? { title: opts.title } : {})
    },
      el('span', { className: 'sap-chipLabel' }, label),
      el('span', { className: valueCls }, value)
    )
  }
  return chip
}

function makeDispatchToolview(el, chip, useState) {
  function DispatchToolview(props) {
    const block = props && props.block
    const request = readDispatchRequest(block)
    const result = readDispatchResult(block)
    const settled = !!(block && typeof block === 'object' && 'kind' in block)
    const trace = block && block.meta ? normalizeDecisionTrace(block.meta) : null
    const { eff, ignored, kindLabel } = resolveDispatchState(request, result, settled)
    const chips = buildDispatchChips(el, chip, eff, result, block, ignored, request)
    const whyUsable = whyUsableText(trace)
    const toolText = toolAllowlistText(request, trace)
    const metaLine = (whyUsable !== '' || toolText !== '') ? el('div', { className: 'sap-toolMeta' },
      whyUsable !== '' ? el('span', { className: 'sap-toolMetaItem' }, `${ZH.whyUsable}：${whyUsable}`) : null,
      toolText !== '' ? el('span', { className: 'sap-toolMetaItem' }, `${ZH.toolAllowlist}：${toolText}`) : null
    ) : null
    const usage = usageFrom(result, block)
    const [open, setOpen] = useState(false)
    // 摘要行只承载动态结果（成本/耗时/结束原因/缓存命中）；静态配置（方案/预设/
    // 提供方/模型/推理强度/档位）全部在 chip 行——避免同一组信息重复两遍。
    const text = `${ZH.toolLabel}：${kindLabel}${tokensSuffix(result, block)}${cacheHitSuffix(usage)}${observabilitySuffix(result, block)}${costText(traceCostInfo(block && block.meta))}`
    // 详情折叠入口：仅当存在真实计费分解（childUsage）时渲染；无分解数据
    // （旧结果/无 usage 会话）不显示折叠区，向前兼容。
    const detailToggle = usage === null ? null : el('button', {
      type: 'button',
      className: 'sap-detailToggle',
      'aria-expanded': open,
      onClick: () => setOpen((prev) => !prev)
    }, open ? ZH.detailClose : ZH.detailOpen)
    // 无分解数据时保持原摘要行结构（零漂移）；有分解时才加折叠入口与详情行。
    const summary = usage === null
      ? el('div', { className: 'sap-toolText' }, text)
      : el('div', { className: 'sap-toolSummary' },
          el('div', { className: 'sap-toolText' }, text),
          detailToggle
        )
    const detailBody = open && usage !== null
      ? el('div', { className: 'sap-toolDetail' }, usageBreakdownText(usage))
      : null
    return el('div', { className: 'sap-toolview' },
      el('div', { className: 'sap-chips' }, chips),
      metaLine,
      summary,
      detailBody
    )
  }
  return DispatchToolview
}

// ── 设置页：事件处理工厂（state 统一经 s 注入）─────────────────────────────

// 写路径契约：HTTP 200 但 persisted:false 时 host 附 persistWarning
// 「已保存但未持久化」——这里改为 amber 警示（非绿色成功态）。
function makeApplyWrite(s) {
  const applyWrite = (data, successNotice) => {
    if (data && data.persisted === false) {
      s.setSavedNotice('')
      s.setPersistWarning(typeof data.persistWarning === 'string' && data.persistWarning !== '' ? data.persistWarning : ZH.persistFail)
      return
    }
    s.setPersistWarning('')
    if (typeof successNotice === 'string' && successNotice !== '') s.setSavedNotice(successNotice)
    else s.setSavedNotice('')
  }
  return applyWrite
}

function makeFormActions(s, loadEfforts, loadTools) {
  const setField = (key) => (event) => {
    const value = event && event.target ? event.target.value : ''
    s.setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'model') next.reasoningEffort = '' // 换模型时重置推理强度
      return next
    })
    if (key === 'model' && value !== '') {
      loadEfforts(value) // 选中模型 → 懒拉该模型 efforts
    }
  }
  const setToolMode = (mode) => () => {
    if (mode !== 'none') loadTools() // 工具限制面板启用 → 拉完整工具目录
    s.setForm((prev) => ({ ...prev, toolMode: mode }))
  }
  const toggleTool = (name) => () => {
    s.setForm((prev) => {
      const cur = Array.isArray(prev.toolList) ? prev.toolList : []
      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]
      return { ...prev, toolList: next }
    })
  }
  const selectLayer = (layer) => () => s.setForm((prev) => {
    const layerNames = s.tools.filter((t) => t.layer === layer).map((t) => t.name)
    return { ...prev, toolList: [...new Set([...(Array.isArray(prev.toolList) ? prev.toolList : []), ...layerNames])] }
  })
  const clearLayer = (layer) => () => s.setForm((prev) => {
    const layerSet = new Set(s.tools.filter((t) => t.layer === layer).map((t) => t.name))
    return { ...prev, toolList: (Array.isArray(prev.toolList) ? prev.toolList : []).filter((n) => !layerSet.has(n)) }
  })
  const invertLayer = (layer) => () => s.setForm((prev) => {
    const layerNames = s.tools.filter((t) => t.layer === layer).map((t) => t.name)
    const cur = Array.isArray(prev.toolList) ? prev.toolList : []
    const toAdd = layerNames.filter((n) => !cur.includes(n))
    const toRemove = new Set(layerNames.filter((n) => cur.includes(n)))
    return { ...prev, toolList: [...cur.filter((n) => !toRemove.has(n)), ...toAdd] }
  })
  return { setField, setToolMode, toggleTool, selectLayer, clearLayer, invertLayer }
}

function makeEditActions(s, loadEfforts, loadTools) {
  const openAdd = () => {
    s.setError('')
    s.setSavedNotice('')
    s.setPersistWarning('')
    s.setForm(EMPTY_FORM)
    s.setEditingId(null)
    s.setAdding(true)
  }
  const openEdit = (profile) => () => {
    s.setError(''); s.setSavedNotice(''); s.setPersistWarning('')
    const tf = profile.toolFilter && typeof profile.toolFilter === 'object' ? profile.toolFilter : {}
    const allowArr = Array.isArray(tf.allow) ? tf.allow.slice() : []
    const denyArr = Array.isArray(tf.deny) ? tf.deny.slice() : []
    const toolMode = allowArr.length > 0 ? 'allow' : (denyArr.length > 0 ? 'deny' : 'none')
    if (toolMode !== 'none') loadTools() // 编辑含 toolFilter 的 profile → 预拉工具目录
    if (typeof profile.model === 'string' && profile.model !== '') {
      loadEfforts(profile.model) // 编辑含 model 的 profile → 预拉该模型 efforts（下拉不空白）
    }
    s.setForm({
      id: profile.id,
      description: typeof profile.description === 'string' ? profile.description : '',
      preset: typeof profile.preset === 'string' ? profile.preset : '',
      provider: typeof profile.provider === 'string' ? profile.provider : '',
      model: typeof profile.model === 'string' ? profile.model : '',
      reasoningEffort: typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort : '',
      toolMode,
      toolList: toolMode === 'allow' ? allowArr : denyArr
    })
    s.setEditingId(profile.id)
    s.setAdding(true)
  }
  const closeAdd = () => {
    s.setAdding(false)
    s.setEditingId(null)
    s.setError('')
    s.setPersistWarning('')
    s.setForm(EMPTY_FORM)
  }
  return { openAdd, openEdit, closeAdd }
}

function makeSubmitActions(api, s, refresh, applyWrite) {
  const submit = () => {
    const payload = { id: typeof s.form.id === 'string' ? s.form.id.trim() : '' }
    // 字符串字段总是发送（含空串）：后端 merge 语义里空串 = 清除该字段，
    // 否则把字段清回“继承父/默认”会被静默忽略（保留旧值）。
    const add = (key, value) => { if (typeof value === 'string') payload[key] = value.trim() }
    add('description', s.form.description)
    add('preset', s.form.preset)
    add('provider', s.form.provider)
    add('model', s.form.model)
    add('reasoningEffort', s.form.reasoningEffort)
    const list = Array.isArray(s.form.toolList) ? s.form.toolList : []
    if (s.form.toolMode === 'allow' && list.length > 0) payload.toolFilter = { allow: list }
    else if (s.form.toolMode === 'deny' && list.length > 0) payload.toolFilter = { deny: list }
    else payload.toolFilter = {}   // 不限制：空对象 = 清除（后端会 delete）
    if (typeof payload.id !== 'string' || payload.id === '') { s.setError('profile id 不能为空'); return }
    // 编辑：保留原 name 和 enabled 状态
    const existing = s.profiles.find((p) => p.id === s.form.id)
    if (existing) {
      if (typeof existing.name === 'string' && existing.name !== '') payload.name = existing.name
      if (existing.enabled === false) payload.enabled = false
    }
    api('/add', payload)
      .then((data) => {
        s.setForm(EMPTY_FORM); s.setAdding(false); s.setEditingId(null); s.setError('')
        applyWrite(data, `已保存 ${payload.id}`)
        refresh()
      })
      .catch((err) => s.setError(String((err && err.message) || err)))
  }
  return { submit }
}

// 乐观开关：next=!get() 先落 UI，成功保留；失败回滚 + 经 setError 展示。
function makeToggle(api, path, payloadKey, get, set, setError) {
  return () => {
    const next = !get()
    set(next)
    setError('')
    api(path, { [payloadKey]: next })
      .catch((err) => {
        set(!next)
        setError(String((err && err.message) || err))
      })
  }
}

function makeRowActions(api, s, refresh, applyWrite) {
  const toggleEnabled = makeToggle(api, '/set-enabled', 'enabled', () => s.enabled, s.setEnabled, s.setError)
  const toggleEscape = makeToggle(api, '/set-escape', 'enabled', () => s.escapeEnabled, s.setEscapeEnabled, s.setError)
  const toggleAdvice = makeToggle(api, '/set-evolution-advice', 'advice', () => s.evolutionAdvice, s.setEvolutionAdvice, s.setError)
  const setProfileEnabled = (profile, next) => () => {
    s.setError('')
    api('/set-profile-enabled', { id: profile.id, enabled: next })
      .then((data) => { applyWrite(data, ''); refresh() })
      .catch((err) => s.setError(String((err && err.message) || err)))
  }
  const resetAll = () => {
    if (!window.confirm('将所有内置方案重置为默认配置？已删除的内置也会恢复。')) return
    s.setError('')
    api('/reset-all', {})
      .then((data) => { applyWrite(data, '已重置所有内置方案'); refresh() })
      .catch((err) => s.setError(String((err && err.message) || err)))
  }
  const remove = (profile) => () => {
    if (!window.confirm(`删除方案「${profile.name || profile.id}」？${profile.builtin === true ? '内置方案删除后可在上方「重置内置方案」恢复' : ''}`)) return
    api('/remove', { id: profile.id })
      .then((data) => {
        s.setError('')
        applyWrite(data, `已删除 ${profile.id}`)
        refresh()
      })
      .catch((err) => s.setError(String((err && err.message) || err)))
  }
  return { toggleEnabled, toggleEscape, toggleAdvice, setProfileEnabled, resetAll, remove }
}

// 逃生舱放行集增删：/escape-add 成功后用响应 presets 刷新本地列表并清空输入；
// /escape-remove 成功后同样用响应 presets 刷新。失败统一经 s.setError 展示。
function makeEscapeActions(api, s) {
  const escapeAdd = () => {
    const value = typeof s.escapeInput === 'string' ? s.escapeInput.trim() : ''
    if (value === '') { s.setError(ZH.escapeAddEmpty); return }
    s.setError('')
    api('/escape-add', { preset: value })
      .then((data) => {
        s.setEscapeInput('')
        if (Array.isArray(data.presets)) s.setEscapePresets(data.presets)
      })
      .catch((err) => s.setError(String((err && err.message) || err)))
  }
  const escapeRemove = (id) => () => {
    s.setError('')
    api('/escape-remove', { preset: id })
      .then((data) => {
        if (Array.isArray(data.presets)) s.setEscapePresets(data.presets)
      })
      .catch((err) => s.setError(String((err && err.message) || err)))
  }
  return { escapeAdd, escapeRemove }
}

// 选中模型 → 懒拉 /options/efforts（按模型 id 存入 options.efforts）。
function makeEffortsLoader(api, setOptions) {
  return (model) => {
    const q = `?model=${encodeURIComponent(model)}`
    api(`/options/efforts${q}`)
      .then((data) => {
        const list = Array.isArray(data.efforts) ? data.efforts : []
        setOptions((prev) => ({ ...prev, efforts: { ...prev.efforts, [model]: list } }))
      })
      .catch(() => {})
  }
}

// 工具限制面板启用 → 拉 /options/tools（完整工具目录）。
function makeToolsLoader(api, setTools) {
  return () => {
    api('/options/tools')
      .then((data) => setTools(Array.isArray(data.tools) ? data.tools : []))
      .catch(() => {})
  }
}

// 版本探测 → 拉 /options/versions；warnings 非空时设置页顶部常驻 amber 提示条。
function makeVersionsLoader(api, setVersionWarnings) {
  return () => {
    api('/options/versions')
      .then((data) => setVersionWarnings(Array.isArray(data.warnings) ? data.warnings : []))
      .catch(() => {})
  }
}

function makeProfilesActions(api, s, refresh, applyWrite, loadEfforts, loadTools) {
  return {
    ...makeFormActions(s, loadEfforts, loadTools),
    ...makeEditActions(s, loadEfforts, loadTools),
    ...makeSubmitActions(api, s, refresh, applyWrite),
    ...makeRowActions(api, s, refresh, applyWrite),
    ...makeEscapeActions(api, s),
  }
}

// ── 设置页：渲染 helpers ────────────────────────────────────────────────────

function buildSelectField(el, s, setField, label, key, optionsList, renderOption) {
  return el('div', { className: 'sap-field' },
    el('span', { className: 'sap-fieldLabel' }, label),
    el('select', { className: 'sap-input sap-select', value: s.form[key], onChange: setField(key) },
      el('option', { value: '' }, '继承父（不指定）'),
      optionsList.map(renderOption)
    )
  )
}

function renderTool(el, s, actions, t) {
  const checked = Array.isArray(s.form.toolList) && s.form.toolList.includes(t.name)
  return el('label', { key: t.name, className: 'sap-toolItem' },
    el('input', { type: 'checkbox', checked, onChange: actions.toggleTool(t.name) }),
    el('span', null, t.zh ? `${t.zh} ${t.name}` : t.name)
  )
}

function buildLayerGroups(tools, layer) {
  const layerTools = tools.filter((t) => t.layer === layer)
  const groups = new Map()
  for (const t of layerTools) {
    const g = typeof t.group === 'string' && t.group !== '' ? t.group : '其他'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(t)
  }
  const keys = layer === 'core'
    ? [...CORE_ORDER.filter((c) => groups.has(c)), ...new Set([...groups.keys()].filter((k) => !CORE_ORDER.includes(k)))]
    : [...groups.keys()]
  return keys.map((k) => [k, groups.get(k)])
}

function buildToolModePicker(el, s, actions) {
  return el('div', { className: 'sap-toolModes' },
    TOOL_MODES.map(([mode, label]) => el('label', { key: mode, className: 'sap-toolItem' },
      el('input', { type: 'radio', name: 'sap-toolMode', checked: s.form.toolMode === mode, onChange: actions.setToolMode(mode) }),
      el('span', null, label)
    ))
  )
}

function buildToolLayerCard(el, s, actions, layer, groups) {
  const layerTools = s.tools.filter((t) => t.layer === layer)
  const count = layerTools.length
  const selectedCount = layerTools.filter((t) => Array.isArray(s.form.toolList) && s.form.toolList.includes(t.name)).length
  const summaryText = selectedCount > 0
    ? `${LAYER_TITLES[layer]}（${count}）· 已选 ${selectedCount}`
    : `${LAYER_TITLES[layer]}（${count}）`
  return el('details', { key: layer, className: 'sap-toolLayerCard' },
    el('summary', { className: 'sap-customizedSummary' }, summaryText),
    el('div', { className: 'sap-toolLayerBody' },
      el('div', { className: 'sap-toolActions', style: { marginTop: '2px' } },
        el('button', { type: 'button', className: 'sap-secondaryButton', style: smallBtn, onClick: actions.selectLayer(layer) }, '全选'),
        el('button', { type: 'button', className: 'sap-secondaryButton', style: smallBtn, onClick: actions.clearLayer(layer) }, '清空'),
        el('button', { type: 'button', className: 'sap-secondaryButton', style: smallBtn, onClick: actions.invertLayer(layer) }, '反选')
      ),
      groups.map(([g, list]) => el('div', { key: g, className: 'sap-toolGroup' },
        el('div', { className: 'sap-toolGroupTitle' }, `${g}（${list.length}）`),
        el('div', { className: 'sap-toolList' }, list.map((t) => renderTool(el, s, actions, t)))
      ))
    )
  )
}

function buildToolLayers(el, s, actions) {
  return el('div', { className: 'sap-toolGroups' },
    ['core', 'plugin', 'custom']
      .filter((layer) => s.tools.some((t) => t.layer === layer))
      .map((layer) => buildToolLayerCard(el, s, actions, layer, buildLayerGroups(s.tools, layer)))
  )
}

function buildToolSection(el, s, actions) {
  return el('div', { className: 'sap-field' },
    el('span', { className: 'sap-fieldLabel' }, '工具限制'),
    buildToolModePicker(el, s, actions),
    s.form.toolMode === 'none'
      ? null
      : (s.tools.length === 0
          ? el('span', { className: 'sap-metaValueDefault' }, '（无可用工具列表）')
          : buildToolLayers(el, s, actions))
  )
}

function buildProfileRows(el, chip, s, actions) {
  return s.profiles.map((profile) => {
    const builtin = profile.builtin === true
    const isDisabled = profile.enabled === false
    const hasName = typeof profile.name === 'string' && profile.name !== '' && profile.name !== String(profile.id)
    const hasPreset = typeof profile.preset === 'string' && profile.preset !== ''
    const hasModel = typeof profile.model === 'string' && profile.model !== ''
    const hasEffort = typeof profile.reasoningEffort === 'string' && profile.reasoningEffort !== ''
    const chipItems = [
      chip('preset', ZH.chipPreset, presetZh(profile.preset), { dim: !hasPreset }),
      chip('model', ZH.chipModel, rawOrInherit(profile.model), { dim: !hasModel }),
      chip('effort', ZH.chipEffort, effortZh(profile.reasoningEffort), { dim: !hasEffort }),
      isDisabled
        ? el('span', { key: 'state', className: 'sap-chip sap-chipDisabled' }, ZH.chipDisabled)
        : el('span', { key: 'state', className: 'sap-chip sap-chipSuccess' }, ZH.chipEnabled)
    ]
    return el('li', { key: String(profile.id), className: 'sap-rowCard' },
      el('div', { className: 'sap-rowHead' },
        el('span', { className: 'sap-rowIdentity' },
          el('span', { className: 'sap-rowName' }, hasName ? profile.name : String(profile.id)),
          hasName ? el('span', { className: 'sap-rowId' }, String(profile.id)) : null,
          builtin ? el('span', { className: 'sap-rowTag' }, '内置') : null
        ),
        el('span', { className: 'sap-rowActions' },
          el('label', { className: 'sap-switch', title: '启用/禁用' },
            el('input', { type: 'checkbox', checked: !isDisabled, onChange: actions.setProfileEnabled(profile, isDisabled) }),
            el('span', null, isDisabled ? '已禁用' : '已启用')
          ),
          el('button', { className: 'sap-secondaryButton', style: { height: '28px', padding: '0 10px', fontSize: '12px', borderRadius: '14px' }, onClick: actions.openEdit(profile) }, '编辑'),
          el('button', { className: 'sap-dangerButton', onClick: actions.remove(profile) }, '删除')
        )
      ),
      el('div', { className: 'sap-chips' }, chipItems),
      typeof profile.description === 'string' && profile.description !== ''
        ? el('p', { className: 'sap-desc' }, profile.description)
        : null
    )
  })
}

function buildAddCard(el, s, actions, toolSection) {
  const providers = deriveProviders(s.options.models)
  const effortsForModel = s.form.model ? (s.options.efforts[s.form.model] ?? []) : []
  const renderEffortOption = (effort) => el('option', { key: effort.id, value: effort.id }, effortLabel(effort))
  return el('div', { className: 'sap-addCard' },
    el('div', { className: 'sap-editorHeader' },
      el('span', { className: 'sap-editorTitle' }, s.editingId !== null ? '编辑 profile' : '新增 profile')
    ),
    el('div', { className: 'sap-field' },
      el('span', { className: 'sap-fieldLabel' }, 'profile id（唯一标识，必填）'),
      el('input', { className: 'sap-input', value: s.form.id, placeholder: '小写字母/数字/连字符，如 my-focus', disabled: s.editingId !== null, onChange: actions.setField('id') })
    ),
    el('div', { className: 'sap-field' },
      el('span', { className: 'sap-fieldLabel' }, '描述（一句话定位）'),
      el('input', { className: 'sap-input', value: s.form.description, placeholder: '说明这个 profile 适合什么场景，帮助模型选择', onChange: actions.setField('description') })
    ),
    buildSelectField(el, s, actions.setField, '模型（子 agent 使用的模型）', 'model', s.options.models,
      (m) => el('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? `${m.name}（${m.providerName || m.provider}）` : m.id)),
    s.options.models.length === 0 ? el('p', { className: 'sap-metaValueDefault', style: { margin: '0' } }, '未检测到模型目录（headless 部署）——派发成本护栏将按「兼容模式」开关决定放行或拒绝') : null,
    el('details', { className: 'sap-customized' },
      el('summary', { className: 'sap-customizedSummary' }, '高级选项'),
      el('div', { className: 'sap-customizedBody' },
        el('p', { className: 'sap-metaValueDefault', style: { margin: '0' } }, 'continuable 模式忽略 preset 换用与推理强度（子 Agent 继承父预设），派发结果以「ignored」标注'),
        buildSelectField(el, s, actions.setField, '目标预设（切换子 agent 使用的 Agent 预设）', 'preset', s.options.presets,
          (p) => el('option', { key: p.id, value: p.id }, p.name && p.name !== p.id ? `${p.name}（${p.id}）` : p.id)),
        s.options.presets.length === 0 ? el('p', { className: 'sap-metaValueDefault', style: { margin: '0' } }, '未检测到 system-trust 预设名册（rosterless）——目标预设下拉不可用') : null,
        buildSelectField(el, s, actions.setField, '提供方（模型服务商）', 'provider', providers,
          (p) => el('option', { key: p.id, value: p.id }, p.name && p.name !== p.id ? `${p.name}（${p.id}）` : p.id)),
        s.form.model === ''
          ? el('div', { className: 'sap-field' },
              el('span', { className: 'sap-fieldLabel' }, '推理强度（思考深度）'),
              el('select', { className: 'sap-input sap-select', value: '', disabled: true },
                el('option', { value: '' }, '先选择模型')
              )
            )
          : buildSelectField(el, s, actions.setField, '推理强度（思考深度）', 'reasoningEffort', effortsForModel, renderEffortOption),
        toolSection
      )
    ),
    el('div', { className: 'sap-editorActions' },
      el('button', { className: 'sap-secondaryButton', onClick: actions.closeAdd }, '取消'),
      el('button', { className: 'sap-primaryButton', onClick: actions.submit }, '保存')
    )
  )
}

// 只读建议注入（evolution:advice）开关卡片：仅父 Agent、只读、默认关。
function buildAdviceSection(el, s, actions) {
  return el('div', { className: 'sap-rowCard' },
    el('div', { className: 'sap-rowHead' },
      el('span', { className: 'sap-rowIdentity' },
        el('span', { className: 'sap-rowName' }, ZH.adviceTitle)
      ),
      el('span', { className: 'sap-rowActions' },
        el('label', { className: 'sap-switch', title: ZH.adviceTitle },
          el('input', { type: 'checkbox', checked: s.evolutionAdvice, onChange: actions.toggleAdvice }),
          el('span', null, s.evolutionAdvice ? '已启用' : '已禁用')
        )
      )
    ),
    el('p', { className: 'sap-desc' }, ZH.adviceDesc)
  )
}

// 逃生舱卡片：开关 + （打开时）显式警告文案 + 放行集增删（输入框 + 添加按钮，
// 每项「移除」按钮）。增删走 /escape-add /escape-remove，成功后用响应 presets 刷新。
function buildEscapeSection(el, s, actions) {
  const list = Array.isArray(s.escapePresets) ? s.escapePresets : []
  return el('div', { className: 'sap-rowCard' },
    el('div', { className: 'sap-rowHead' },
      el('span', { className: 'sap-rowIdentity' },
        el('span', { className: 'sap-rowName' }, ZH.escapeTitle)
      ),
      el('span', { className: 'sap-rowActions' },
        el('label', { className: 'sap-switch', title: '逃生舱开关' },
          el('input', { type: 'checkbox', checked: s.escapeEnabled, onChange: actions.toggleEscape }),
          el('span', null, s.escapeEnabled ? '已启用' : '已禁用')
        )
      )
    ),
    s.escapeEnabled
      ? el('p', { className: 'sap-notice', role: 'alert' }, ZH.escapeWarn)
      : null,
    el('div', { className: 'sap-escapeAdd' },
      el('input', {
        className: 'sap-input',
        style: { flex: '1 1 0', minWidth: '160px' },
        value: s.escapeInput,
        placeholder: ZH.escapeInputPlaceholder,
        onChange: (event) => s.setEscapeInput(event && event.target ? event.target.value : '')
      }),
      el('button', { type: 'button', className: 'sap-secondaryButton', style: smallBtn, onClick: actions.escapeAdd }, ZH.escapeAdd)
    ),
    el('div', { className: 'sap-chips' },
      list.length === 0
        ? el('span', { className: 'sap-chipValueDim' }, ZH.escapeEmpty)
        : list.map((id) => el('span', { key: String(id), className: 'sap-chip sap-chipWarn' },
            String(id),
            el('button', { type: 'button', className: 'sap-chipRemove', title: ZH.escapeRemove, onClick: actions.escapeRemove(id) }, ZH.escapeRemove)
          ))
    )
  )
}

function buildSectionReturn(el, s, actions, rows, addCard) {
  return el('div', { className: 'sap-section' },
    el('div', { className: 'sap-titleRow' },
      el('h2', { className: 'sap-title' }, '子 Agent 方案'),
      el('label', { className: 'sap-switch' },
        el('input', { type: 'checkbox', checked: s.enabled, onChange: actions.toggleEnabled }),
        el('span', null, s.enabled ? '已启用' : '已禁用')
      )
    ),
    s.versionWarnings.length > 0
      ? el('div', { className: 'sap-versionWarn' }, s.versionWarnings.map((warning, index) => el('span', { key: index }, warning)))
      : null,
    s.audit.health === 'degraded'
      ? el('p', { className: 'sap-notice', role: 'alert' },
          `${ZH.auditDegraded}（${ZH.auditLost}：派发遥测 ${s.audit.lostTelemetry} · 治理 ${s.audit.lostGovernance}）`)
      : null,
    el('p', { className: 'sap-intro' }, '在此管理「派发子 Agent」工具可用的 profile。内置方案可编辑、可删除、可点下方按钮批量重置回默认；每个方案可单独启用/禁用。'),
    el('div', { className: 'sap-addActions', style: { margin: '4px 0' } },
      el('button', { type: 'button', className: 'sap-secondaryButton', style: { height: '28px', padding: '0 12px', fontSize: '12px', borderRadius: '14px' }, onClick: actions.resetAll }, '重置所有内置方案')
    ),
    buildAdviceSection(el, s, actions),
    buildEscapeSection(el, s, actions),
    !s.enabled ? el('p', { className: 'sap-notice' }, '插件已禁用：「派发子 Agent」工具已从模型工具列表中移除，打开开关即可恢复。') : null,
    s.error !== '' ? el('p', { className: 'sap-notice' }, s.error) : null,
    s.savedNotice !== '' ? el('p', { className: 'sap-savedNotice', role: 'status' }, s.savedNotice) : null,
    s.persistWarning !== '' ? el('p', { className: 'sap-warn', role: 'alert' }, `${s.persistWarning}${ZH.persistFailHint}`) : null,
    el('ul', { className: 'sap-rows' }, rows),
    el('div', { className: 'sap-addBlock' },
      s.adding ? addCard : el('div', { className: 'sap-addActions' },
        el('button', { className: 'sap-addButton', onClick: actions.openAdd }, '+ 新增 profile')
      )
    )
  )
}

function makeProfilesSection(el, api, chip, useState, useEffect, useCallback) {
  function ProfilesSection() {
    const [profiles, setProfiles] = useState([])
    const [options, setOptions] = useState({ models: [], efforts: {}, presets: [] })
    const [enabled, setEnabled] = useState(true)
    const [adding, setAdding] = useState(false)
    const [editingId, setEditingId] = useState(null)
    const [error, setError] = useState('')
    const [savedNotice, setSavedNotice] = useState('')
    const [persistWarning, setPersistWarning] = useState('')
    const [form, setForm] = useState(EMPTY_FORM)
    const [tools, setTools] = useState([])
    const [versionWarnings, setVersionWarnings] = useState([])
    const [audit, setAudit] = useState(AUDIT_DEFAULTS)
    const [escapeEnabled, setEscapeEnabled] = useState(false)
    const [escapePresets, setEscapePresets] = useState([])
    const [escapeInput, setEscapeInput] = useState('')
    const [evolutionAdvice, setEvolutionAdvice] = useState(false)
    const s = { profiles, options, enabled, adding, editingId, error, savedNotice, persistWarning, form, tools, versionWarnings, audit, escapeEnabled, escapePresets, escapeInput, evolutionAdvice, setProfiles, setOptions, setEnabled, setAdding, setEditingId, setError, setSavedNotice, setPersistWarning, setForm, setTools, setVersionWarnings, setAudit, setEscapeEnabled, setEscapePresets, setEscapeInput, setEvolutionAdvice }
    const refresh = useCallback(() => {
      api('/list')
        .then((data) => setProfiles(Array.isArray(data.profiles) ? data.profiles : []))
        .catch((err) => setError(String((err && err.message) || err)))
    }, [])
    const loadOptions = useCallback(() => {
      api('/options/summary')
        .then((data) => applySummaryData(data, { enabled: setEnabled, options: setOptions, audit: setAudit, escapeEnabled: setEscapeEnabled, escapePresets: setEscapePresets, evolutionAdvice: setEvolutionAdvice }))
        .catch(() => {})
    }, [])
    const loadEfforts = makeEffortsLoader(api, setOptions)
    const loadTools = makeToolsLoader(api, setTools)
    // 版本探测只挂载时拉一次：useCallback([]) 稳定引用，防 effect 依赖恒变导致设置页打开期间无限重取。
    const loadVersions = useCallback(() => makeVersionsLoader(api, setVersionWarnings)(), [])
    useEffect(() => {
      refresh()
      loadOptions()
      loadVersions()
    }, [refresh, loadOptions, loadVersions])
    const applyWrite = makeApplyWrite(s)
    const actions = makeProfilesActions(api, s, refresh, applyWrite, loadEfforts, loadTools)
    const rows = buildProfileRows(el, chip, s, actions)
    const toolSection = buildToolSection(el, s, actions)
    return buildSectionReturn(el, s, actions, rows, buildAddCard(el, s, actions, toolSection))
  }
  return ProfilesSection
}

// ── 派发账本：会话标签页（React 依赖经参数注入）────────────────────────────

// epoch ms → 本地 HH:MM:SS；非有限数返回空串。
function formatClockTime(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return ''
  const d = new Date(time)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 毫秒 → 人读耗时：<1s 显示 ms，<1m 显示 s（1 位小数），否则 m+s；无值/0 返回空串。
function formatDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return s > 0 ? `${m}m${s}s` : `${m}m`
}

// 闸输入/输出值 → 单行 JSON（等宽次级色展示）；不可序列化回退 String。
function formatGateValue(value) {
  if (value === undefined || value === null) return ''
  try {
    const s = JSON.stringify(value)
    return s === undefined ? '' : s
  } catch {
    return String(value)
  }
}

// 闸名中文标签（仅中文，供汇总带紧凑展示）；未知/空名原样返回。
function gateLabelZh(name) {
  return GATE_LABELS[name] || name
}

// 闸名标签（中文 + 英文技术标识，供时间线闸头展示）。
function gateLabel(name) {
  const zh = GATE_LABELS[name]
  return zh !== undefined ? `${zh}（${name}）` : name
}

// 失败闸修复方向；未知闸给通用提示。
function gateFixHint(name) {
  return GATE_FIX_HINTS[name] || ZH.gateFixUnknown
}

// 派发方式 → 摘要行 chip 文案。
function kindLabel(kind) {
  if (kind === 'background') return ZH.toolBackground
  if (kind === 'continuable') return ZH.cont
  if (kind === 'foreground') return ZH.toolForeground
  return kind
}

// 记录档位：effective.tokenTier 优先，回退 result.fields.tokenTier（旧记录）。
function recordTier(record) {
  const trace = record && record.trace
  const result = record && record.result
  const eff = trace && trace.effective
  if (eff && typeof eff.tokenTier === 'string' && eff.tokenTier !== '') return eff.tokenTier
  if (result && result.fields && typeof result.fields.tokenTier === 'string') return result.fields.tokenTier
  return ''
}

// 记录模型：effective.model 优先，回退 result.fields.model（旧记录口径，同档位读取）。
function recordModel(record) {
  const trace = record && record.trace
  const result = record && record.result
  const eff = trace && trace.effective
  if (eff && typeof eff.model === 'string' && eff.model !== '') return eff.model
  if (result && result.fields && typeof result.fields.model === 'string') return result.fields.model
  return ''
}

// 记录派发方式：execution.kind → request 标志 → result.kind 依次回退。
function recordKind(record) {
  const trace = record && record.trace
  const result = record && record.result
  const request = record && record.request
  const kind = trace && trace.execution && typeof trace.execution.kind === 'string' ? trace.execution.kind : ''
  if (kind !== '') return kind
  if (request && request.continuable) return 'continuable'
  if (request && request.runInBackground) return 'background'
  if (result && result.kind === 'background') return 'background'
  if (result && result.kind === 'continuable') return 'continuable'
  return 'foreground'
}

// 记录五段分解：trace.settled.childUsage 优先，回退 result.fields.childUsage。
function recordUsage(record) {
  const trace = record && record.trace
  const result = record && record.result
  if (trace && trace.settled) {
    const usage = parseChildUsage(trace.settled.childUsage)
    if (usage !== null) return usage
  }
  if (result && result.fields && result.fields.childUsage !== undefined && result.fields.childUsage !== '') {
    return parseChildUsage(result.fields.childUsage)
  }
  return null
}

// 逐次调用明细：读 trace.settled.calls（{calls:[{五段}], truncated, totalCalls}），
// 逐字段 typeof 守卫、坏条目跳过；无 calls 或全坏返回 null（整区不渲染）。calls 仅
// 账本展开区专用，不进 render 行 / 模型可见面。
function recordCalls(record) {
  const settled = record && record.trace && record.trace.settled
  const raw = settled && settled.calls
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Array.isArray(raw.calls) || raw.calls.length === 0) return null
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
  const calls = []
  for (const item of raw.calls) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const call = {}
    for (const key of keys) {
      const value = item[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) call[key] = value
    }
    calls.push(call)
  }
  if (calls.length === 0) return null
  const totalCalls = typeof raw.totalCalls === 'number' && Number.isFinite(raw.totalCalls) && raw.totalCalls >= 0
    ? raw.totalCalls
    : calls.length
  return { calls, truncated: raw.truncated === true, totalCalls }
}

// 记录结束原因：结算 stopReason 优先，回退 result.fields.stopReason；映射中文。
function recordStopZh(record) {
  const settled = record && record.trace && record.trace.settled
  const result = record && record.result
  const raw = settled && typeof settled.stopReason === 'string' ? settled.stopReason
    : (result && result.fields && typeof result.fields.stopReason === 'string' ? result.fields.stopReason : '')
  return raw === '' ? '' : (ZH.stopReasonZh[raw] || raw)
}

// 记录行稳定 key：callId 优先，其次时间戳，最后下标兜底。
function ledgerKey(record, index) {
  if (record.callId !== '') return record.callId
  if (record.time !== null) return `ledger-${record.time}-${index}`
  return `ledger-${index}`
}

// ── 账本渲染 helpers（纯元素组装）──────────────────────────────────────────

// 汇总带单条统计段：label 次级色 + 值加粗，段间「·」分隔。
function summarySegments(el, pairs) {
  const out = []
  pairs.forEach((pair, i) => {
    if (i > 0) out.push(el('span', { key: `sep${i}`, className: 'sap-ledgerSep' }, ' · '))
    out.push(el('span', { key: `seg${i}`, className: 'sap-ledgerStatSeg' }, pair[0], ' ', el('span', { className: 'sap-ledgerStat' }, pair[1])))
  })
  return out
}

// 汇总带：派发/成功/拒绝/token/耗时 + 闸拒绝分布 + 按方案（中文名双表达）+ 按模型/按档位。
function buildLedgerSummary(el, summary, profileNames) {
  const elapsed = formatDurationMs(summary.totalElapsedMs)
  const pairs = [
    [ZH.ledgerDispatch, `${summary.dispatchCount} ${ZH.ledgerTimes}`],
    [ZH.ledgerSuccess, String(summary.successCount)],
    [ZH.ledgerReject, String(summary.rejectCount)],
    [ZH.ledgerTotalTokens, `≈${summary.totalTokens}（${ZH.cacheHit} ${summary.cacheHitTokens}）`]
  ]
  if (elapsed !== '') pairs.push([ZH.ledgerTotalElapsed, elapsed])
  const gateEntries = ['whitelist', 'cost', 'intersection', 'approval', 'other']
    .filter((name) => summary.gateRejectCounts[name] > 0)
    .map((name) => `${gateLabelZh(name)} ${summary.gateRejectCounts[name]}`)
  const profileText = summary.byProfile.map((item) => `${profileDisplay(item.profile, profileNames)} ×${item.count}`).join(' · ')
  // 模型原文显示；继承桶（空串）与 'inherit'/'(parent)'/以 '(' 开头的标记一律归一为「继承父」。
  const modelText = summary.byModel.map((item) => {
    const display = item.model === 'inherit' || item.model.startsWith('(') ? ZH.inherit : rawOrInherit(item.model)
    return `${display} ×${item.count}`
  }).join(' · ')
  const tierText = summary.byTier.map((item) => `${ZH.tierZh[item.tier] || item.tier} ×${item.count}`).join(' · ')
  return el('div', { className: 'sap-ledgerSummary' },
    el('div', { className: 'sap-ledgerSummaryTitle' }, ZH.ledgerSummary),
    el('div', { className: 'sap-ledgerSummaryLine' }, summarySegments(el, pairs)),
    gateEntries.length > 0
      ? el('div', { className: 'sap-ledgerSummaryLine' }, `${ZH.ledgerGateRejectDist}：${gateEntries.join(' · ')}`)
      : null,
    profileText !== ''
      ? el('div', { className: 'sap-ledgerSummaryLine' }, `${ZH.ledgerByProfile}：${profileText}`)
      : null,
    modelText !== ''
      ? el('div', { className: 'sap-ledgerSummaryLine' }, `${ZH.ledgerByModel}：${modelText}`)
      : null,
    tierText !== ''
      ? el('div', { className: 'sap-ledgerSummaryLine' }, `${ZH.ledgerByTier}：${tierText}`)
      : null,
    summary.pricedCount > 0
      ? el('div', { className: 'sap-ledgerSummaryLine' },
          ZH.ledgerCostLine
            .replace('{actual}', String(summary.estimatedCost))
            .replace('{counter}', String(summary.estimatedInheritCost))
            .replace('{saving}', String(summary.estimatedSaving))
            .replace('{ratio}', summary.estimatedSaving > 0 && summary.estimatedCost > 0 ? String(Number((summary.estimatedInheritCost / summary.estimatedCost).toFixed(2))) : '1'))
      : null,
    summary.inheritCount > 0
      ? el('div', { className: 'sap-ledgerSummaryLine' },
          ZH.ledgerInheritCost.replace('{count}', String(summary.inheritCount)).replace('{ratio}', String(summary.inheritRatio)))
      : null
  )
}

// 空态：暂无派发记录 + 一句引导。
function buildEmptyState(el) {
  return el('div', { className: 'sap-ledgerEmpty' },
    el('p', { className: 'sap-ledgerEmptyTitle' }, ZH.ledgerEmpty),
    el('p', { className: 'sap-intro' }, ZH.ledgerEmptyHint)
  )
}

// 「加载更早」按钮：hasMore 为真且未在补载时可用；点击逐页补载更早记录。
function buildLoadOlderButton(el, hasMore, loadingOlder, loadOlder) {
  return el('button', {
    type: 'button',
    className: 'sap-ledgerLoadOlder',
    disabled: !hasMore || loadingOlder,
    onClick: () => { loadOlder() }
  }, loadingOlder ? ZH.ledgerLoadingOlder : ZH.ledgerLoadOlder)
}

// 账本顶部说明行：定位说明（恒显）+ 窗口提示（hasMore 时显示已加载条数）。
function buildLedgerTopNote(el, hasMore, count) {
  return el('div', null,
    el('div', { className: 'sap-ledgerScope' }, ZH.ledgerScopeNote),
    hasMore
      ? el('div', { className: 'sap-ledgerWindowNote' }, ZH.ledgerWindowNote.replace('{n}', String(count)))
      : null
  )
}

// 标量 → 直接文本（字符串不带引号，null/undefined 空串）。
function formatGateScalar(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  return String(v)
}

// 对象/数组 → 逐字段键值行数组（depth 上限 2 防深层爆炸）；标量 → 单行文本。
// 对象逐键「中文标签（键名）: 值」；嵌套容器递归 1 层并包缩进块（sap-ledgerGateNested，
// 左侧竖线视觉分层，profiles_snapshot 等嵌套结构可读）；数组前 5 项逐项展示，
// 超出补「…共 N 项」。未知键回退原样（不崩溃）。
function gateValueRows(el, value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return [el('div', { className: 'sap-ledgerGateKV' },
      el('span', { className: 'sap-ledgerGateValue' }, formatGateScalar(value)))]
  }
  if (Array.isArray(value)) {
    const rows = []
    for (const item of value.slice(0, 5)) {
      if (item !== null && typeof item === 'object' && depth < 2) {
        rows.push(el('div', { className: 'sap-ledgerGateNested' }, ...gateValueRows(el, item, depth + 1)))
      } else {
        rows.push(el('div', { className: 'sap-ledgerGateKV' },
          el('span', { className: 'sap-ledgerGateValue' }, formatGateScalar(item))))
      }
    }
    if (value.length > 5) {
      rows.push(el('div', { className: 'sap-ledgerGateKV' },
        el('span', { className: 'sap-ledgerGateValue' }, `…共 ${value.length} 项`)))
    }
    return rows
  }
  const rows = []
  for (const [key, v] of Object.entries(value)) {
    const label = GATE_KEY_LABELS[key] !== undefined ? `${GATE_KEY_LABELS[key]}（${key}）` : key
    if (v !== null && typeof v === 'object' && depth < 2) {
      rows.push(el('div', { className: 'sap-ledgerGateKV' },
        el('span', { className: 'sap-ledgerGateKey' }, label), ':'))
      rows.push(el('div', { className: 'sap-ledgerGateNested' }, ...gateValueRows(el, v, depth + 1)))
    } else {
      rows.push(el('div', { className: 'sap-ledgerGateKV' },
        el('span', { className: 'sap-ledgerGateKey' }, label), ':',
        el('span', { className: 'sap-ledgerGateValue' }, formatGateScalar(v))))
    }
  }
  return rows
}

// 子块卡片：标题 + 字段级行（空对象/空数组显示 `{}`/`[]` 单行，不空白）。
// 供步骤①（父会话上下文/请求值）与各闸（输入/输出）共用——每段独立卡片、
// 独立标题，与闸头/拒绝信息视觉分层（不再平铺扎堆）。
function buildSubBlock(el, title, value) {
  const rows = value !== null && typeof value === 'object' && Object.keys(value).length > 0
    ? gateValueRows(el, value, 0)
    : [el('div', { className: 'sap-ledgerGateKV' },
        el('span', { className: 'sap-ledgerGateValue' }, formatGateValue(value)))]
  return el('div', { className: 'sap-ledgerSubBlock' },
    el('div', { className: 'sap-ledgerSubBlockTitle' }, title),
    el('div', { className: 'sap-ledgerSubBlockBody' }, rows)
  )
}

// 区块视图切换按钮：字段视图 ↔ 原始 JSON（点击整体切换，非追加）。active 为真时
// 显示「字段视图」提示可切回。
function buildViewToggle(el, active, onToggle) {
  return el('button', {
    type: 'button',
    className: 'sap-ledgerRawJson',
    onClick: onToggle,
    'aria-expanded': active
  }, active ? ZH.ledgerFieldView : ZH.ledgerRawJson)
}

// JSON 视图内容：kv 各段原始 JSON 逐块展示（等宽可换行），与字段视图互斥。
function buildJsonBody(el, kv) {
  return el('div', { className: 'sap-ledgerJsonBody' },
    kv.map(({ label, value }) => el('div', { key: label, className: 'sap-ledgerJsonBlock' },
      el('div', { className: 'sap-ledgerGateKey' }, label),
      el('div', { className: 'sap-ledgerGateValue' }, formatGateValue(value))
    ))
  )
}

// 决策时间线步骤 ①：发起时间 + 父会话上下文 + 请求参数（各为独立子块卡片；
// 头部右侧按钮切换 字段视图 ↔ 原始 JSON）。
function buildStartStep(el, trace, jsonView, toggleJson) {
  const startedText = formatClockTime(trace.startedAt)
  const head = startedText !== '' ? `${ZH.ledgerStarted} · ${startedText}` : ZH.ledgerStarted
  const jsonMode = jsonView['start'] === true
  const kv = [
    { label: ZH.ledgerParentContext, value: trace.parentContext },
    { label: ZH.ledgerRequested, value: trace.requested }
  ]
  return el('div', { key: 'step-start', className: 'sap-ledgerStep' },
    el('div', { className: 'sap-ledgerStepHead' },
      el('span', null, head),
      buildViewToggle(el, jsonMode, () => toggleJson('start'))
    ),
    jsonMode
      ? buildJsonBody(el, kv)
      : el('div', { className: 'sap-ledgerStepBody' },
          buildSubBlock(el, ZH.ledgerParentContext, trace.parentContext),
          buildSubBlock(el, ZH.ledgerRequested, trace.requested)
        )
  )
}

// 单道闸三段式：闸头（名称 + verdict + 视图切换）→ 输入/输出子块（或合并 JSON 视图）
// → 结论；失败闸浅红底 + 原因 + 修复方向。拒绝信息两种视图下都显示。
function buildGateStep(el, gate, index, jsonView, toggleJson) {
  const failed = gate.verdict === 'fail'
  const passed = gate.verdict === 'pass'
  const verdict = passed ? `✅ ${ZH.ledgerPass}` : (failed ? `❌ ${ZH.ledgerReject}` : gate.verdict)
  const verdictCls = failed ? 'sap-ledgerGateVerdictFail' : (passed ? 'sap-ledgerGateVerdictPass' : '')
  const key = `gate-${index}`
  const jsonMode = jsonView[key] === true
  const kv = [
    { label: ZH.ledgerGateInput, value: gate.input },
    { label: ZH.ledgerGateOutput, value: gate.output }
  ]
  const rejectRows = failed
    ? [
        el('div', { key: 'reject', className: 'sap-ledgerReject' }, gate.reason !== '' ? `${ZH.ledgerReject}：${gate.reason}` : ZH.ledgerReject),
        el('div', { key: 'rejectFix', className: 'sap-ledgerRejectFix' }, `${ZH.ledgerRejectFix}：${gateFixHint(gate.name)}`)
      ]
    : []
  return el('div', { key, className: failed ? 'sap-ledgerGate sap-ledgerGateFail' : 'sap-ledgerGate' },
    el('div', { className: 'sap-ledgerGateHead' },
      el('span', { className: 'sap-ledgerGateName' }, gateLabel(gate.name)),
      el('span', { className: `sap-ledgerGateVerdict ${verdictCls}` }, verdict),
      buildViewToggle(el, jsonMode, () => toggleJson(key))
    ),
    jsonMode
      ? el('div', { className: 'sap-ledgerGateBody' }, buildJsonBody(el, kv), ...rejectRows)
      : el('div', { className: 'sap-ledgerGateBody' },
          buildSubBlock(el, ZH.ledgerGateInput, gate.input),
          buildSubBlock(el, ZH.ledgerGateOutput, gate.output),
          ...rejectRows
        )
  )
}

  // 决策时间线：① 发起 + 各闸。步骤元素带稳定 key（静态列表也满足 React key 契约）。
  // jsonView/toggleJson：区块级「字段视图 ↔ 原始 JSON」切换状态（LedgerRow 持有）。
function buildDecisionTimeline(el, record, jsonView, toggleJson) {
  const gates = record.trace && Array.isArray(record.trace.gates) ? record.trace.gates : []
  const blocks = [buildStartStep(el, record.trace, jsonView, toggleJson)]
  gates.forEach((gate, index) => blocks.push(buildGateStep(el, gate, index, jsonView, toggleJson)))
  return el('div', { className: 'sap-ledgerSection' },
    el('div', { className: 'sap-ledgerSectionTitle' }, ZH.ledgerDecisionTimeline),
    el('div', { className: 'sap-ledgerTimeline' }, blocks)
  )
}

// 模型选择审计标注 chips（Task 37d）：警示色 chip，title 给出确定性判定依据。
function buildAuditChips(el, trace) {
  return auditModelChoice(trace).map((a) => el('span', {
    key: 'audit-' + a.key,
    className: 'sap-chip sap-chipWarn',
    title: a.title
  }, a.label))
}

// 生效值 chips + ⬆被忽略项（沿用既有 ignored chip 风格）。
function buildEffectiveSection(el, chip, record, profileNames) {
  const eff = record.trace.effective || {}
  // 拒绝路径无生效值（闸 fail 即中止派发）——整节省略。
  if (Object.keys(eff).length === 0) return null
  const requested = record.trace.requested || {}
  const chips = []
  chips.push(chip('profile', ZH.chipProfile, profileDisplay(eff.profile, profileNames)))
  chips.push(chip('preset', ZH.chipPreset, presetZh(eff.preset), { dim: !eff.preset }))
  const p = rawOrInherit(eff.provider)
  const m = rawOrInherit(eff.model)
  chips.push(chip('providerModel', `${ZH.chipProvider}·${ZH.chipModel}`, p === ZH.inherit && m === ZH.inherit ? ZH.inherit : `${p} / ${m}`, { dim: p === ZH.inherit && m === ZH.inherit }))
  chips.push(chip('effort', ZH.chipEffort, effortZh(eff.reasoningEffort), { dim: !eff.reasoningEffort }))
  const tier = typeof eff.tokenTier === 'string' && eff.tokenTier !== '' ? eff.tokenTier : ''
  if (tier !== '') chips.push(chip('tier', ZH.chipTier, ZH.tierZh[tier] || tier))
  const ignored = Array.isArray(eff.ignored) ? eff.ignored : []
  for (const key of ignored) {
    const reqVal = typeof requested[key] === 'string' && requested[key] !== '' ? requested[key] : ''
    chips.push(el('span', {
      key: `ignored-${key}`,
      className: 'sap-chip sap-chipWarn',
      title: reqVal !== '' ? ZH.ignoredChipTitle.replace('{value}', reqVal) : ZH.ignoredChipTitleEmpty
    }, `⬆${key}(${ZH.ignoredMark})`))
  }
  chips.push(...buildAuditChips(el, record.trace))
  return el('div', { className: 'sap-ledgerSection' },
    el('div', { className: 'sap-ledgerSectionTitle' }, ZH.ledgerEffectiveStep),
    el('div', { className: 'sap-chips' }, chips)
  )
}

// 结算：stopReason / 耗时 / token + 五段分解（复用 usageBreakdownText）。
// 仅 trace.settled 有值时渲染；settled 为 null（运行中/拒绝）整节省略。
function buildSettledSection(el, record) {
  const settled = record.trace && record.trace.settled
  if (!settled) return null
  const { tokens, elapsedMs } = recordNumbers(record)
  const stopZh = recordStopZh(record)
  const usageText = usageBreakdownText(recordUsage(record))
  const parts = []
  if (stopZh !== '') parts.push(`${ZH.ledgerStopReason}=${stopZh}`)
  if (elapsedMs !== null) parts.push(`${ZH.ledgerElapsed}=${formatDurationMs(elapsedMs)}`)
  if (tokens !== null) parts.push(`≈${tokens} tokens`)
  if (usageText !== '') parts.push(usageText)
  if (parts.length === 0) return null
  return el('div', { className: 'sap-ledgerSection' },
    el('div', { className: 'sap-ledgerSectionTitle' }, ZH.ledgerSettledStep),
    el('div', { className: 'sap-ledgerUsage' }, parts.join(' · '))
  )
}

// 逐次调用明细折叠区（默认收起）：trace.settled.calls 逐条五段紧凑表格（序号 + 五列，
// 缺失段显示 —）+ 末行合计（∑已存 calls，未截断时与 childUsage 五段分解对账一致）+
// 截断提示。无 calls 数据时整区不渲染。
function buildCallDetailSection(el, record) {
  const data = recordCalls(record)
  if (data === null) return null
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
  const labels = [ZH.usageInput, ZH.usageOutput, ZH.usageCacheRead, ZH.usageCacheWrite, ZH.usageReasoning]
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  const rows = data.calls.map((call, i) => {
    const cells = keys.map((key) => {
      const value = call[key]
      if (typeof value === 'number') totals[key] += value
      return el('td', { key }, typeof value === 'number' ? String(value) : '—')
    })
    return el('tr', { key: i },
      el('td', { className: 'sap-ledgerCallsIndex' }, String(i + 1)),
      ...cells
    )
  })
  const totalCells = keys.map((key) => el('td', { key, className: 'sap-ledgerCallsTotal' }, String(totals[key])))
  const note = data.truncated
    ? el('div', { className: 'sap-ledgerCallsNote' },
        ZH.ledgerCallsTruncated.replace('{shown}', String(data.calls.length)).replace('{total}', String(data.totalCalls)))
    : null
  return el('details', { className: 'sap-customized' },
    el('summary', { className: 'sap-customizedSummary' }, ZH.ledgerCallDetail),
    el('div', { className: 'sap-customizedBody' },
      el('table', { className: 'sap-ledgerCallsTable' },
        el('thead', null,
          el('tr', null,
            el('th', { className: 'sap-ledgerCallsIndex' }, ZH.ledgerCallsIndex),
            keys.map((key, i) => el('th', { key }, labels[i]))
          )
        ),
        el('tbody', null,
          rows,
          el('tr', { key: 'total' },
            el('td', { className: 'sap-ledgerCallsIndex sap-ledgerCallsTotal' }, ZH.ledgerCallsTotal),
            ...totalCells
          )
        )
      ),
      note
    )
  )
}

// 子会话跳转：地址三字段齐全 →「打开子会话」；不完整 → 显示 id 供手动检索。
// 后台派发只有 jobId（execute 返回时子会话尚未启动），无子会话可跳，恒走手动检索。
function buildHierarchyHint(el, record, openChild) {
  const execution = (record.trace && record.trace.execution) || {}
  const parentSessionId = typeof execution.parentSessionId === 'string' ? execution.parentSessionId : ''
  const childSessionId = typeof execution.childSessionId === 'string' ? execution.childSessionId : ''
  const jobId = typeof execution.jobId === 'string' ? execution.jobId : ''
  const mode = typeof execution.mode === 'string' ? execution.mode : ''
  const canJump = parentSessionId !== '' && childSessionId !== '' && mode !== ''
  let body = null
  if (canJump) {
    body = el('button', {
      type: 'button',
      className: 'sap-detailToggle',
      onClick: () => openChild({ parentSessionId, childSessionId, mode })
    }, ZH.ledgerJumpChild)
  } else if (childSessionId !== '') {
    body = el('div', { className: 'sap-ledgerManual' }, `${ZH.ledgerChildManual}：`, el('code', { className: 'sap-ledgerManualId' }, childSessionId))
  } else if (jobId !== '') {
    body = el('div', { className: 'sap-ledgerManual' }, `${ZH.ledgerJobManual}：`, el('code', { className: 'sap-ledgerManualId' }, jobId))
  }
  if (body === null) return null
  return el('div', { className: 'sap-ledgerSection' },
    el('div', { className: 'sap-ledgerSectionTitle' }, ZH.ledgerExecutionStep),
    body
  )
}

// 记录摘要行 chips：后台/continuable 派发方式 + 方案 + 档位。
function buildRowChips(el, chip, record, profileNames) {
  const chips = []
  const kind = recordKind(record)
  if (kind === 'background' || kind === 'continuable') {
    chips.push(el('span', { key: 'kind', className: 'sap-chip' }, kindLabel(kind)))
  }
  const profile = recordProfile(record)
  if (profile !== '') chips.push(chip('profile', ZH.chipProfile, profileDisplay(profile, profileNames)))
  const tier = recordTier(record)
  if (tier !== '') chips.push(chip('tier', ZH.chipTier, ZH.tierZh[tier] || tier))
  chips.push(...buildAuditChips(el, record.trace))
  return chips
}

// 展开区：旧记录降级提示；新记录 = 决策时间线 → 生效值 → 执行信息
// → 结算 → 调用级明细。
function buildExpandArea(el, chip, record, isLegacy, openChild, profileNames, jsonView, toggleJson) {
  if (isLegacy) {
    return el('div', { className: 'sap-ledgerExpand' },
      el('div', { className: 'sap-ledgerLegacy' }, ZH.ledgerLegacy)
    )
  }
  return el('div', { className: 'sap-ledgerExpand' },
    buildDecisionTimeline(el, record, jsonView, toggleJson),
    buildEffectiveSection(el, chip, record, profileNames),
    buildHierarchyHint(el, record, openChild),
    buildSettledSection(el, record),
    buildCallDetailSection(el, record)
  )
}

// ── 账本 maker（React 依赖经参数注入）───────────────────────────────────────

function makeLedgerRow(el, chip, useState, openChild) {
  function LedgerRow({ record, profileNames }) {
    const [open, setOpen] = useState(false)
    // 区块级视图切换：jsonView[key] 为 true 时该区块显示原始 JSON（key='start' 或
    // `gate-<index>`），false/缺省显示字段级子块视图。各区块独立切换。
    const [jsonView, setJsonView] = useState({})
    const toggleJson = (key) => setJsonView((prev) => ({ ...prev, [key]: !(prev[key] === true) }))
    const isLegacy = record.legacy === true
    const numbers = recordNumbers(record)
    const rejected = recordIsRejected(record)
    const stopZh = rejected ? '' : recordStopZh(record)
    const metaParts = []
    if (numbers.tokens !== null) metaParts.push(`≈${numbers.tokens} tokens`)
    if (numbers.elapsedMs !== null) metaParts.push(`${ZH.ledgerElapsed}=${numbers.elapsedMs}ms`)
    if (stopZh !== '') metaParts.push(`${ZH.ledgerStopReason}=${stopZh}`)
    return el('li', { className: open ? 'sap-ledgerRow sap-ledgerRowOpen' : 'sap-ledgerRow' },
      el('button', {
        type: 'button',
        className: 'sap-ledgerRowHead',
        'aria-expanded': open,
        onClick: () => setOpen((prev) => !prev)
      },
        el('span', { className: 'sap-ledgerTime' }, formatClockTime(record.time)),
        el('span', { className: 'sap-chips' }, buildRowChips(el, chip, record, profileNames)),
        rejected ? el('span', { className: 'sap-ledgerReject' }, `❌ ${ZH.ledgerReject}`) : null,
        el('span', { className: 'sap-ledgerMeta' }, metaParts.join(' · ')),
        el('span', { className: 'sap-ledgerToggle' }, '▸')
      ),
      open ? buildExpandArea(el, chip, record, isLegacy, openChild, profileNames, jsonView, toggleJson) : null
    )
  }
  return LedgerRow
}

function makeDispatchLedgerView(el, chip, useState, useEffect, openChild) {
  const LedgerRow = makeLedgerRow(el, chip, useState, openChild)
  function DispatchLedgerView({ useSession, sessionId, loadOlder = () => {} }) {
    const nodes = useSession((s) => s?.chat?.legacy?.nodes)
    const hasMore = useSession((s) => s?.hasMore)
    const loadingOlder = useSession((s) => s?.loadingOlder)
    const [failures, setFailures] = useState([])
    const [profileNames, setProfileNames] = useState({})
    useEffect(() => {
      let cancelled = false
      fetchLedgerFailures(sessionId).then((list) => {
        if (!cancelled) setFailures(list)
      })
      return () => { cancelled = true }
    }, [sessionId])
    // profile 注册表 id→中文名映射：账本挂载时拉一次 /list，用于方案名中英双表达
    // （「标准编码（swap-standard）」）；拉取失败保留空映射，显示层回退纯 id。
    useEffect(() => {
      let cancelled = false
      api('/list').then((data) => {
        if (cancelled || data === undefined || !Array.isArray(data.profiles)) return
        const map = {}
        for (const profile of data.profiles) {
          if (profile !== null && typeof profile === 'object' && typeof profile.id === 'string' && typeof profile.name === 'string' && profile.name !== '') {
            map[profile.id] = profile.name
          }
        }
        setProfileNames(map)
      }).catch(() => {})
      return () => { cancelled = true }
    }, [])
    // 账本默认只统计已加载窗口；经「加载更早」逐页补载更早记录后 nodes 变多、
    // 统计自然扩大。
    const records = mergeFailureRecords(collectDispatchRecords(nodes), failures)
    const summary = records.length === 0 ? null : computeLedgerSummary(records)
    const ordered = records.slice().reverse()
    const rows = records.length === 0
      ? buildEmptyState(el)
      : el('ul', { className: 'sap-ledgerRows' },
          ordered.map((record, index) => el(LedgerRow, { key: ledgerKey(record, index), record, profileNames }))
        )
    return el('div', { className: 'sap-ledger' },
      buildLedgerTopNote(el, hasMore, records.length),
      buildLoadOlderButton(el, hasMore, loadingOlder, loadOlder),
      summary === null ? null : buildLedgerSummary(el, summary, profileNames),
      rows
    )
  }
  return DispatchLedgerView
}

// ── plugin 装配 ─────────────────────────────────────────────────────────────

window.__ModuleLoader__.load({
  id: 'dsh-subagent-profile',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useState, useCallback } = React
    const el = React.createElement

    // slots：槽注册；sessions：子会话跳转（openSubagent）。两者皆 client 核心服务。
    const inject = ['slots', 'sessions']

    const chip = makeChip(el)
    const DispatchToolview = makeDispatchToolview(el, chip, useState)
    const ProfilesSection = makeProfilesSection(el, api, chip, useState, useEffect, useCallback)

    function apply(ctx) {
      ensureStyles()
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'dispatch'
      }, DispatchToolview))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'subagent-profiles',
        order: 100,
        label: '子 Agent 方案'
      }, ProfilesSection))
      // 子会话跳转回调：经 sessions 服务按 SubagentAddress 打开子会话。
      const openChild = (address) => ctx.sessions.openSubagent(address)
      const DispatchLedgerView = makeDispatchLedgerView(el, chip, useState, useEffect, openChild)
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'dispatch-ledger',
        order: 20,
        label: ZH.ledgerTab,
        inject: (sessionId) => {
          const session = ctx.sessions.binding(sessionId)?.session
          if (session === void 0) throw new Error(`dsh-subagent-profile: 会话 "${sessionId}" 不可用（可能已归档或未加载）`)
          return { loadOlder: async () => { await session.loadOlder() } }
        }
      }, DispatchLedgerView))
    }

    return { apply, inject }
  },
})
