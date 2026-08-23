// scripts/leak-scan.mjs — 公开前敏感信息扫描：遍历 git 可达历史（--all 与
// HEAD 两个范围），匹配私网地址、本机用户名、本机绝对路径、凭据模式、
// 内部标识词。任何命中即非零退出（发布前第 0 步门禁）。零依赖（node 内置 +
// git）。注意：只扫已提交内容（git log 语义），未提交/暂存内容不在扫描范围；
// 发布脚本要求干净工作区，门禁执行时工作区必为已提交状态。
//
// 作者身份门禁（2026-08 教训：公开历史曾出现个人 QQ 邮箱与内网 IP 邮箱）：
// 另扫「将公开的 main 分支」提交作者，邮箱非 @users.noreply.github.com 结尾
// 即失败。leak-scan 的 -G 内容扫描看不到作者元数据，必须显式检查。

import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

// 敏感模式清单。每项：{ name, regex }——regex 供 git log -G 使用（基本正则）。
// 排除合法用途：127.0.0.1/::1 loopback 功能代码不在此列。
const PATTERNS = [
  { name: '私网 IPv4（10.x）', regex: '10\\.\\d+\\.\\d+\\.\\d+' },
  { name: '私网 IPv4（172.16-31.x）', regex: '172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+' },
  { name: '私网 IPv4（192.168.x）', regex: '192\\.168\\.\\d+\\.\\d+' },
  { name: '本机用户名', regex: userInfo().username },
  { name: '用户目录绝对路径', regex: '[A-Za-z]:\\\\Users\\\\' },
  { name: '盘符绝对路径（D:\\Agent 等）', regex: '[A-Za-z]:\\\\(Agent|dsh|dev|work|projects)\\\\' },
  { name: 'password 赋值', regex: "password\\s*[:=]\\s*[^\\s\"']+" },
  { name: 'secret 赋值', regex: "secret\\s*[:=]\\s*[^\\s\"']+" },
  { name: 'api key 赋值', regex: "api[_-]?key\\s*[:=]\\s*[^\\s\"']+" },
  { name: '长 token 赋值', regex: '(token|access[_-]?token)\\s*[:=]\\s*[A-Za-z0-9._-]{16,}' },
  { name: '私钥材料', regex: 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' },
  // 内部标识词（已删分支名 / 内网组织名）：任何公开内容不得出现这些词。
  // 排除 scripts/leak-scan.mjs 自身——本文件的说明性注释会提及它们（自指）。
  // 注：`v2-midterm` 不在此列——.gitea/workflows/ci.yml 的触发分支配置是功能
  // 必需，且历史 README 已有残留（连删除它的提交都会被 -G 命中），无法以内容
  // 门禁拦截；该词防再犯靠提交纪律与本地 postmortem 记录。
  { name: '内部标识词（内部分支/组织名）', regex: 'v2-first-slice|main-legacy|DarkGitea', exclude: ['scripts/leak-scan.mjs'] },
];

// 作者身份门禁（2026-08-24 教训入库，复盘记录仅本地留存不随包发布）：
// 将公开的 main 分支历史作者邮箱必须以 @users.noreply.github.com 结尾——
// 个人邮箱（QQ/163 等）与内网邮箱（如 noreply.<内网 IP>）一律拦截。
// 单人项目此规则足够；多作者项目请在下方精确白名单里显式列出。
const AUTHOR_EMAIL_SUFFIX = '@users.noreply.github.com';
// 可选精确白名单（邮箱全匹配；留空表示只按后缀规则）。扩展示例：
// ['muzyLink <109686802+muzyLink@users.noreply.github.com>']
const ALLOWED_AUTHORS = [];

// 对单个模式扫描全历史与工作区，返回命中行（提交缩写 + 匹配摘要）。
// 带 exclude 的模式追加 pathspec 排除（git log -G 支持路径限定，
// 只在该范围内匹配新增/删除行）。
function scanPattern(pattern) {
  const hits = [];
  for (const scope of ['--all', 'HEAD']) {
    const args = ['log', scope, '--oneline', '-G', pattern.regex, '--all-match'];
    if (Array.isArray(pattern.exclude) && pattern.exclude.length > 0) {
      args.push('--', '.', ...pattern.exclude.map((p) => `:(exclude)${p}`));
    }
    let out;
    try {
      out = execFileSync('git', args, {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      // git log 无匹配时退出码 1；其余错误同样视为该范围无结果。
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      if (line.trim() !== '') hits.push(`${scope === '--all' ? '历史' : 'HEAD'} ${line}`);
    }
  }
  return hits;
}

// 提交信息检查（2026-08-24 教训：提交信息曾含 Task/阶段编号、内部文档名与
// 评审记录 body，推上公开仓库即永久可见）：扫「将公开的 main 分支」的完整
// 提交消息（含 body），命中内部内容即失败。范围与作者检查一致（main，CI 回退
// HEAD）。
const COMMIT_MSG_PATTERNS = [
  /Task\s*[\dA-Za-z.]+/,          // 内部任务编号（Task 7a / 8.6 / 17/18）
  /阶段\s*[A-E]/,                 // 内部阶段编号（阶段 C / D+E）
  /任务\s*\d+/,                   // 任务编号
  /measured-params|postmortem|成本闭环|v2-spec|首切片|开发期/,  // 内部文档名
  /内网/,                          // 内网表述
  /双评审|评审报告/,               // 内部评审流程
  /测试\s*\d+\s*→\s*\d+/,         // 测试计数演进（内部过程记录）
];
function scanCommitMessages() {
  const hits = [];
  let ref = 'main';
  let out;
  try {
    out = execFileSync('git', ['log', ref, '--format=%h %B'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    ref = 'HEAD';
    try {
      out = execFileSync('git', ['log', ref, '--format=%h %B'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return hits;
    }
  }
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    for (const pattern of COMMIT_MSG_PATTERNS) {
      const m = pattern.exec(line);
      if (m !== null) {
        hits.push(`${ref} ${line.trim().slice(0, 120)}（命中「${m[0]}」）`);
        break;
      }
    }
  }
  return hits;
}

// 作者身份检查：扫「将公开的 main 分支」的全部提交作者，逐条校验。
// 范围取 main（发布分支；含 tags 指向的历史）——内部分支不进公开端，不在
// 检查范围（如未来要公开须先重写，见本地 postmortem 记录）。
// CI 浅克隆可能没有 main 分支：`git log main` 失败时回退 `git log HEAD`
// （CI 只跑 main 与开发分支的 push，检查仍有效）。
function scanAuthors() {
  const hits = [];
  let ref = 'main';
  let out;
  try {
    out = execFileSync('git', ['log', ref, '--format=%an <%ae>'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    ref = 'HEAD';
    try {
      out = execFileSync('git', ['log', ref, '--format=%an <%ae>'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return hits;
    }
  }
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const match = /<([^>]+)>$/.exec(line);
    const email = match !== null ? match[1] : '';
    const allowed = email.endsWith(AUTHOR_EMAIL_SUFFIX) || ALLOWED_AUTHORS.includes(line.trim());
    if (!allowed) hits.push(`${ref} ${line.trim()}`);
  }
  return hits;
}

function main() {
  const problems = [];
  for (const pattern of PATTERNS) {
    const hits = scanPattern(pattern);
    if (hits.length > 0) {
      problems.push(`模式「${pattern.name}」命中 ${hits.length} 处：\n  ${hits.join('\n  ')}`);
    }
  }
  const authorHits = scanAuthors();
  if (authorHits.length > 0) {
    problems.push(`作者身份门禁：${authorHits.length} 个提交作者邮箱不是 noreply 形式（公开历史会暴露个人邮箱，必须重写或移除）：\n  ${[...new Set(authorHits)].join('\n  ')}`);
  }
  const msgHits = scanCommitMessages();
  if (msgHits.length > 0) {
    problems.push(`提交信息门禁：${msgHits.length} 条提交消息含内部内容（Task/阶段编号、内部文档名、评审记录等，公开即永久可见）：\n  ${[...new Set(msgHits)].join('\n  ')}`);
  }
  if (problems.length === 0) {
    console.log('✅ leak-scan 通过：全历史与工作区无敏感模式命中，main 分支作者身份与提交信息合规。');
    return;
  }
  console.error('❌ leak-scan 发现敏感信息（公开推送前必须清零）：\n');
  for (const p of problems) console.error(`${p}\n`);
  process.exitCode = 1;
}

main();
