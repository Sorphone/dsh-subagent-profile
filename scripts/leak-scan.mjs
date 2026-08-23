// scripts/leak-scan.mjs — 公开前敏感信息扫描：遍历全历史（所有 ref 可达提交）
// 与工作区，匹配私网地址、本机用户名、本机绝对路径、凭据模式。任何命中即
// 非零退出（发布前第 0 步门禁）。零依赖（node 内置 + git）。

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

function main() {
  const problems = [];
  for (const pattern of PATTERNS) {
    const hits = scanPattern(pattern);
    if (hits.length > 0) {
      problems.push(`模式「${pattern.name}」命中 ${hits.length} 处：\n  ${hits.join('\n  ')}`);
    }
  }
  if (problems.length === 0) {
    console.log('✅ leak-scan 通过：全历史与工作区无敏感模式命中。');
    return;
  }
  console.error('❌ leak-scan 发现敏感信息（公开推送前必须清零）：\n');
  for (const p of problems) console.error(`${p}\n`);
  process.exitCode = 1;
}

main();
