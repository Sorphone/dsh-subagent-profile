// test/csrf.test.mjs — 写路由 CSRF 传输授权：Origin 白名单 + Content-Type +
// 自定义头三件套。四验收场景（非白名单 Origin 拒 + 留痕 / text-plain 拒 /
// 缺自定义头拒 / 合法三件套通过）+ 无 Origin 但有自定义头 + JSON 通过（本地脚本口径）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCtx, makeIsolatedDshHome } from './harness/ctx.mjs';
import { makeRouteHarness, callRoute, WRITE_HEADERS } from './harness/routes.mjs';

const mod = await import('../index.mjs');

// apply() 交还路由 handler + fake ctx 的日志记录（用于断言 CSRF 拒绝留痕）。
async function setupApp() {
  const { webServer, routes } = makeRouteHarness();
  const { ctx, records } = createFakeCtx({ services: { webServer } });
  await mod.apply(ctx);
  return { handler: routes[0].handler, records };
}

// 断言「拒绝必留痕」：任一 warn 消息含 CSRF 防护标记即可（setup 可能另有 warn）。
function assertCsrfWarn(records) {
  assert.ok(
    records.logs.warn.some((args) => args.join(' ').includes('CSRF 防护拒绝')),
    'CSRF 拒绝必须 logger.warn 留痕'
  );
}

test('CSRF ①：非白名单 Origin 的写请求被 403 拒绝且 logger.warn 留痕', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler, records } = await setupApp();
    const resp = await callRoute(handler, 'POST', '/add', { id: 'x', name: 'n' }, {
      ...WRITE_HEADERS,
      origin: 'http://evil.example',
    });
    assert.equal(resp.code, 403);
    assert.equal(resp.json.ok, false);
    assert.match(resp.json.error, /CSRF 防护拒绝/);
    assert.match(resp.json.error, /Origin 不在本机白名单/);
    assertCsrfWarn(records);
  } finally { iso.restore(); iso.teardown(); }
});

test('CSRF ②：text/plain 与 application/x-www-form-urlencoded 写请求被 403 拒绝', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler } = await setupApp();
    const textPlain = await callRoute(handler, 'POST', '/add', { id: 'x', name: 'n' }, {
      ...WRITE_HEADERS,
      'content-type': 'text/plain',
    });
    assert.equal(textPlain.code, 403);
    assert.match(textPlain.json.error, /CSRF 防护拒绝/);
    assert.match(textPlain.json.error, /Content-Type: application\/json/);
    const form = await callRoute(handler, 'POST', '/add', { id: 'x', name: 'n' }, {
      ...WRITE_HEADERS,
      'content-type': 'application/x-www-form-urlencoded',
    });
    assert.equal(form.code, 403);
    assert.match(form.json.error, /Content-Type: application\/json/);
  } finally { iso.restore(); iso.teardown(); }
});

test('CSRF ③：缺自定义头 X-DSH-Plugin 的写请求被 403 拒绝', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler } = await setupApp();
    const resp = await callRoute(handler, 'POST', '/add', { id: 'x', name: 'n' }, {
      origin: WRITE_HEADERS.origin,
      'content-type': WRITE_HEADERS['content-type'],
    });
    assert.equal(resp.code, 403);
    assert.equal(resp.json.ok, false);
    assert.match(resp.json.error, /CSRF 防护拒绝/);
    assert.match(resp.json.error, /X-DSH-Plugin/);
  } finally { iso.restore(); iso.teardown(); }
});

test('CSRF ④：合法 JSON + 正确 Origin + 自定义头三件套通过', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler } = await setupApp();
    const resp = await callRoute(handler, 'POST', '/add', { id: 'x', name: 'n' }, WRITE_HEADERS);
    assert.equal(resp.code, 200);
    assert.equal(resp.json.ok, true);
    assert.equal(resp.json.id, 'x');
  } finally { iso.restore(); iso.teardown(); }
});

test('CSRF ⑤：无 Origin 但有自定义头 + JSON 的本地脚本请求通过', async () => {
  const iso = makeIsolatedDshHome();
  try {
    const { handler } = await setupApp();
    const resp = await callRoute(handler, 'POST', '/add', { id: 'x', name: 'n' }, {
      'content-type': 'application/json',
      'x-dsh-plugin': 'dsh-subagent-profile',
    });
    assert.equal(resp.code, 200);
    assert.equal(resp.json.ok, true);
  } finally { iso.restore(); iso.teardown(); }
});
