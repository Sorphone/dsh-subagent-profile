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
// 2. README 徽章 == version：package.json 的 version 必须出现在 README.md 的字面版本徽章
//    （vX.Y.Z 形式）中；缺徽章或出现与 version 不一致的 vX.Y.Z 字面量 → 漂移。
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

const VERSION_TOKEN = /v\d+\.\d+\.\d+/g;

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

// 检查 ②：README 徽章 == version。README.md 必须含与 package.json version 一致的字面
// 版本徽章（vX.Y.Z）；缺徽章或存在不一致的 vX.Y.Z 字面量（含历史残留）→ 漂移。
function checkReadmeBadge(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expected = `v${pkg.version}`;
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const tokens = readme.match(VERSION_TOKEN) ?? [];
  if (tokens.length === 0) {
    return { ok: false, problems: [`README.md 缺少版本徽章，应含 ${expected} 字面徽章（见 README.md Hero 区）`] };
  }
  const stale = [...new Set(tokens.filter((token) => token !== expected))];
  if (stale.length > 0) {
    return { ok: false, problems: [`README.md 版本徽章漂移：期望 ${expected}，发现 ${stale.join('、')}（与 package.json 不同步，请更新徽章）`] };
  }
  return { ok: true, problems: [] };
}

function main() {
  const root = packageRoot();
  const checks = [
    { name: 'preset 树对账：presets/ ↔ $DSH_HOME/.agent-presets 派生树 byte 一致（临时 DSH_HOME，不写真实 ~/.dsh）', ...reconcilePresetTrees() },
    { name: 'README 徽章 == package.json version', ...checkReadmeBadge(root) },
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
    console.log('\npreflight 通过：preset 树一致，README 徽章与版本号同步。');
  }
}

main();
