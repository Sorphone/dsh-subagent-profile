// test/harness/routes.mjs — 共享 HTTP 路由 harness：capture webServer（apply 的
// inject scope 注册设置路由并交还 handler）+ mock req/res（支持 POST body 与 headers）。
// persist / degradation 等测试共用，避免各测试文件复制且分歧。

// 合法写请求头（CSRF 三件套）：写路由测试默认带上；需测「被 403 拒绝」的场景时
// 显式传 headers 整体替换。键为小写，镜像 Node 对 req.headers 的归一化。
export const WRITE_HEADERS = {
  origin: 'http://127.0.0.1:12545',
  'content-type': 'application/json',
  'x-dsh-plugin': 'dsh-subagent-profile',
};

// capture webServer：apply() 的 inject 作用域实际注册设置路由并交还 handler。
export function makeRouteHarness() {
  const routes = [];
  const webServer = {
    register(config) {
      routes.push(config);
      return () => {};
    },
  };
  return { webServer, routes };
}

export function makeReq(method, urlPath, body, headers) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    url: `http://localhost/subagent-profiles${urlPath}`,
    socket: { remoteAddress: '127.0.0.1' },
    // POST 默认带 CSRF 三件套（新写路由守卫的合法口径）；GET 只读无需任何头。
    headers: method === 'POST' ? (headers ?? WRITE_HEADERS) : (headers ?? {}),
    on(event, fn) { (listeners[event] ??= []).push(fn); },
    destroy() {},
  };
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  return {
    req,
    feed() {
      if (bodyText.length > 0) for (const fn of listeners.data) fn(Buffer.from(bodyText));
      for (const fn of listeners.end) fn();
    },
  };
}

export function makeRes() {
  const state = { code: null, data: '' };
  return {
    state,
    writeHead(code) { state.code = code; },
    end(text) { state.data = text; },
  };
}

export async function callRoute(handler, method, urlPath, body, headers) {
  const { req, feed } = makeReq(method, urlPath, body, headers);
  const res = makeRes();
  const p = handler(req, res);
  feed();
  await p;
  return { code: res.state.code, json: res.state.data ? JSON.parse(res.state.data) : null };
}
