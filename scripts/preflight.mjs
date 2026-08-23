// scripts/preflight.mjs — 发布前自检（零依赖，仅 node 内置 + lib/core/presets-sync.mjs）。
//
// 两项检查，任一失败即非零退出（exitCode = 1）并输出中文可操作信息：
//
// 1. preset 树对账：bundled `presets/` ↔ DSH_HOME/.agent-presets 派生树 byte 一致集合对账。
//    绝不写真实 ~/.dsh：用 DSH_HOME 指向一次性临时目录跑 syncBundledPresets()（与宿主启动
//    相同路径），再双向比对字节集合（bundled 每个文件必须存在于派生树且字节一致、派生树
//    不得有多余文件）。presets/ 是源（source of truth），派生树由 sync 机械产出，因此本检查
//    守护的是 sync 管线保真度：源根解析回归（Task 8.6 曾把 lib/core/presets-sync.mjs 的
//    bundledPresetsRoot 指到不存在的 lib/presets，导致启动自安装静默失效——本检查可抓）、
//    同步失败、漏拷/多拷/字节损坏。用户本机 ~/.dsh 派生树的漂移由插件启动时幂等重同步负责。
//    同步失败或任一文件漂移 → 不一致。
// 2. README 无硬编码版本徽章：版本展示由 npm 徽章（自动跟随发布版本）承担，
//    手写的 Version-vX.Y.Z 字面徽章会在 bump 时漂移 → 发现即失败。
//
// 用法：node scripts/preflight.mjs   （CI 与发布前均调用；见 .gitea/workflows/ci.yml）

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundledPresetsRoot,
  filesUnder,
  syncBundledPresets,
} from '../lib/core/presets-sync.mjs';

// 包根 = scripts/ 的上一级（本文件位于 <root>/scripts/preflight.mjs）。
function packageRoot() {
  return fileURLToPath(new URL('../', import.meta.url));
}

// 严格字节比对；任一侧读取失败视为不一致。
function bytesEqual(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

// 双向 byte 一致集合对账：源每文件须存在于目标且字节相等；目标每文件须存在于源。
function collectProblems(sourceRoot, targetRoot) {
  const problems = [];
  const ids = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const id of ids) {
    const sourceDir = join(sourceRoot, id);
    const targetDir = join(targetRoot, id);
    for (const file of filesUnder(sourceDir)) {
      const rel = relative(sourceDir, file);
      const dest = join(targetDir, rel);
      if (!existsSync(dest)) {
        problems.push(`缺失 ${id}/${rel}`);
      } else if (!bytesEqual(file, dest)) {
        problems.push(`字节不一致 ${id}/${rel}`);
      }
    }
    if (existsSync(targetDir)) {
      for (const file of filesUnder(targetDir)) {
        const rel = relative(targetDir, file);
        if (!existsSync(join(sourceDir, rel))) {
          problems.push(`多余 ${id}/${rel}`);
        }
      }
    }
  }
  return problems;
}

// 检查 ①：preset 树对账。在临时 DSH_HOME 中跑 syncBundledPresets 后做双向 byte 一致
// 集合对账；结束恢复原 DSH_HOME 并删除临时目录（清理在 finally 中，任何异常路径都执行）。
function reconcilePresetTrees() {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-subagent-profile-preflight-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = temp;
  try {
    const targetRoot = join(temp, '.agent-presets');
    let sync;
    try {
      sync = syncBundledPresets(targetRoot);
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
    const problems = [];
    for (const failed of sync.failed) {
      problems.push(`同步失败 ${failed.id}: ${failed.error}`);
    }
    const sourceRoot = bundledPresetsRoot();
    if (existsSync(sourceRoot)) {
      problems.push(...collectProblems(sourceRoot, targetRoot));
    } else {
      problems.push(`bundled 预设根不存在: ${sourceRoot}`);
    }
    return { ok: sync.failed.length === 0 && problems.length === 0, problems };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// 检查 ②：README 不得含硬编码版本徽章。版本展示由 npm 徽章（自动跟随发布版本）
// 承担；任何手写的 Version-vX.Y.Z 字面徽章都会在发布 bump 时漂移，故这里反向
// 断言「不存在」——发现即要求移除（改用 npm 徽章）。
function checkReadmeBadge(root) {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const zh = readFileSync(join(root, 'README.zh.md'), 'utf8');
  const hardcoded = [];
  for (const [name, text] of [['README.md', readme], ['README.zh.md', zh]]) {
    if (/badge\/Version-v/.test(text)) hardcoded.push(name);
  }
  if (hardcoded.length > 0) {
    return { ok: false, problems: [`${hardcoded.join('、')} 含硬编码版本徽章（badge/Version-v…）：请移除，版本展示由 npm 徽章自动跟随发布版本`] };
  }
  return { ok: true, problems: [] };
}

function main() {
  const root = packageRoot();
  const checks = [
    { name: 'preset 树对账：presets/ ↔ $DSH_HOME/.agent-presets 派生树 byte 一致（临时 DSH_HOME，不写真实 ~/.dsh）', ...reconcilePresetTrees() },
    { name: 'README 无硬编码版本徽章（版本展示由 npm 徽章承担）', ...checkReadmeBadge(root) },
  ];
  let failed = false;
  for (const check of checks) {
    console.log(`${check.ok ? '✅' : '❌'} ${check.name}`);
    for (const problem of check.problems) console.log(`   - ${problem}`);
    if (!check.ok) failed = true;
  }
  if (failed) {
    console.error('\npreflight 未通过：请修复上述漂移后重跑 `node scripts/preflight.mjs`。');
    process.exitCode = 1;
  } else {
    console.log('\npreflight 通过：preset 树一致，README 无硬编码版本徽章。');
  }
}

main();
