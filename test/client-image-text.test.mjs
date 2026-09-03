// test/client-image-text.test.mjs — ⑦ 生效参数回读展示（client.js 源码结构断言）：
// 派发卡片与台账行渲染生效画像一行（方案 X · 模型 p/m · 档位 Y；未绑定 → 继承父
// 方案 · …）；优先读 B3 交付的 meta.imageText（；→· 归一、路由段「模型」前缀），
// 旧结果无 imageText 时按生效字段同格式合成；台账记录从 node.meta 捕获 imageText。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

function functionBody(name) {
  const start = source.indexOf('function ' + name);
  assert.ok(start >= 0, '必须存在函数 ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('函数括号不平衡：' + name);
}

test('画像行：优先 meta.imageText + ；转 · + 路由段「模型」前缀 + 继承父方案合成', () => {
  const body = functionBody('imageTextOfBlock');
  assert.match(body, /m\.imageText/, '优先读 B3 交付的 meta.imageText');
  assert.match(body, /继承父方案/, '未绑定方案 → 继承父方案态');
  assert.match(body, /`方案 \$\{profile\}；/, '绑定方案 → 方案 X 态');
  assert.match(body, /parts\[1\] = '模型 ' \+ parts\[1\]/, '路由段加「模型」前缀');
  assert.match(body, /parts\.join\(' · '\)/, '分隔符统一「·」');
  assert.match(body, /'balanced'/, '档位缺省 balanced（与后端同口径）');
});

test('派发卡片：DispatchToolview 把画像并入 meta 行（有画像才渲染）', () => {
  const body = functionBody('DispatchToolview');
  assert.match(body, /imageTextOfBlock\(block/, '卡片读 block.meta 画像');
  assert.match(body, /imageText !== '' \? el\('span', \{ className: 'sap-toolMetaItem' \}/, '画像并入 meta 行渲染');
  assert.match(body, /safetyLine !== '' \|\| toolLine !== '' \|\| imageText !== ''/, '空画像不渲染该行');
});

test('台账记录：collectDispatchRecords 从 node.meta 捕获 imageText（fail-soft 空串）', () => {
  const body = functionBody('collectDispatchRecords');
  assert.match(body, /imageText: node\.meta !== null && typeof node\.meta === 'object' && typeof node\.meta\.imageText === 'string' \? node\.meta\.imageText : ''/, '台账记录携带 imageText 字段');
});

test('台账行头：buildLedgerRowHead 渲染画像（sap-ledgerImageText 样式类）', () => {
  const body = functionBody('buildLedgerRowHead');
  assert.match(body, /imageTextOfBlock\(\{ imageText: record\.imageText \}/, '台账行读记录画像');
  assert.match(body, /sap-ledgerMeta sap-ledgerImageText/, '台账行画像 span 带专属样式类');
  assert.match(body, /imageText !== ''/, '无画像不渲染');
});
