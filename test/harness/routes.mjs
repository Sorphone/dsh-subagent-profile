// test/harness/routes.mjs — 共享 HTTP 路由 harness：capture webServer（apply 的
// inject scope 注册设置路由并交还 handler）+ mock req/res（支持 POST body）。
// persist / degradation 等测试共用，避免各测试文件复制且分歧。

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

export function makeReq(method, urlPath, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    url: `http://localhost/subagent-profiles${urlPath}`,
    socket: { remoteAddress: '127.0.0.1' },
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

export async function callRoute(handler, method, urlPath, body) {
  const { req, feed } = makeReq(method, urlPath, body);
  const res = makeRes();
  const p = handler(req, res);
  feed();
  await p;
  return { code: res.state.code, json: res.state.data ? JSON.parse(res.state.data) : null };
}
