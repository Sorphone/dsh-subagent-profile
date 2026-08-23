// scripts/leak-scan.mjs — 公开前敏感信息扫描：遍历全历史（所有 ref 可达提交）
// 与工作区，匹配私网地址、本机用户名、本机绝对路径、凭据模式。任何命中即
// 非零退出（发布前第 0 步门禁）。零依赖（node 内置 + git）。
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
function scanPattern(pattern) {
  const hits = [];
  for (const scope of ['--all', 'HEAD']) {
    let out;
    try {
      out = execFileSync('git', ['log', scope, '--oneline', '-G', pattern.regex, '--all-match'], {
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

// 作者身份检查：扫「将公开的 main 分支」的全部提交作者，逐条校验。
// 范围取 main（发布分支；含 tags 指向的历史）——内部分支（main-legacy 等）
// 不进公开端，不在检查范围（如未来要公开须先重写，见 postmortem 文档）。
// CI 浅克隆可能没有 main 分支：`git log main` 失败时回退 `git log HEAD`
// （CI 只跑 main/v2-midterm 的 push，检查仍有效）。
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
  if (problems.length === 0) {
    console.log('✅ leak-scan 通过：全历史与工作区无敏感模式命中，main 分支作者身份合规。');
    return;
  }
  console.error('❌ leak-scan 发现敏感信息（公开推送前必须清零）：\n');
  for (const p of problems) console.error(`${p}\n`);
  process.exitCode = 1;
}

main();
