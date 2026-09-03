// lib/core/cleanup.mjs — 启动与卸载清理辅助（从 index.mjs 移出以守装配文件行门）。
// 卸载清理：本插件 3 个数据文件 + orchestrator-v2 预设目录改名备份（effect 清理器
// 在禁用/热重载/退出时都可能触发；硬删除会静默丢用户数据）。启动清理：删上个
// 生命周期留下的 .removed-* 备份残留（只清本插件前缀，防热重载反复产生新备份
// 积累）；卸载后用户手动改回原名的场景不受影响。全部 fail-soft（改名/删除失败
// 不抛）。import-free（仅 node 内置），可被裸 CI 单测。

import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function removeOwnedData(home) {
  const stamp = Date.now();
  for (const file of ['subagent-profiles.json', 'subagent-profiles.state.json', 'subagent-profiles.failed-traces.json']) {
    try { renameSync(join(home, file), join(home, `${file}.removed-${stamp}`)); } catch { /* 源不存在（正常首启）等：best effort */ }
  }
  try { renameSync(join(home, '.agent-presets', 'orchestrator-v2'), join(home, '.agent-presets', `orchestrator-v2.removed-${stamp}`)); } catch { /* best effort */ }
}

export function cleanRemovedBackups(home) {
  for (const dir of [home, join(home, '.agent-presets')]) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      try {
        if (name.startsWith('subagent-profiles.') && name.includes('.removed-')) {
          rmSync(join(dir, name), { force: true });
        } else if (name.startsWith('orchestrator-v2.removed-')) {
          rmSync(join(dir, name), { recursive: true, force: true });
        }
      } catch { /* best effort */ }
    }
  }
}
