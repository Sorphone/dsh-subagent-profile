// eslint.config.js — 行门：单文件 ≤400 行、单函数 ≤50 行（数据表豁免 + 完整性
// 护栏；client.js 文件级按 ADR 豁免、函数级为临时债见下）。拒绝 baseline
// disable：无整文件 /* eslint-disable */ 豁免。

import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        fetch: 'readonly', // Node 18+ 内置全局（host 侧 scripts 合法使用）
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
  // 行门：全仓库 ≤400 行/文件（client.js 按 ADR 豁免文件级）
  {
    files: ['**/*.mjs', '**/*.js'],
    ignores: ['lib/client.js'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: false }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: false }],
    },
  },
  // client.js：文件级 max-lines 按 ADR 永久豁免（module-host 单 bundle 契约，
  // 无相对 require/多文件路由，物理多文件拆分需引入构建，违背无构建基线）。
  // 函数级 max-lines-per-function 豁免 = 临时受追踪债：内部 3 个函数超 50 行
  // （factory / ProfilesSection / DispatchToolview）——它们**可拆**（纯数据与
  // 纯函数上提模块作用域、React 依赖件经 el 注入桥接），拆完后恢复本规则。
  // 债务登记：ADR-client-js-split.md（Task 8b 执行）。
  {
    files: ['lib/client.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        __ModuleLoader__: 'readonly',
      },
    },
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off', // 临时债：Task 8b 拆分后恢复
    },
  },
  // catalog.mjs 数据表豁免（D1：纯键值映射数据表豁免 + 完整性护栏，护栏在测试）
  {
    files: ['lib/catalog.mjs'],
    rules: {
      'max-lines-per-function': 'off', // 数据表本身无函数；防误报保险
    },
  },
  // test/ 不套行门（测试文件本身不该被 50 行函数限制扼杀）
  {
    files: ['test/**/*.mjs'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
    },
  },
];
