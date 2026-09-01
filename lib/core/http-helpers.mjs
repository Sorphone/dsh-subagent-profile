// lib/core/http-helpers.mjs — 设置 HTTP 路由的共享小助手（从 http-routes 逐字移出）：
// JSON 响应、POST body 解析（1MB 上限）、persistOk 包装（persisted:false 时回传
// 「已保存但未持久化」警示）。零依赖，多个路由模块共用。

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1 << 20) { reject(new Error('请求体过大')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data === '' ? {} : JSON.parse(data)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function persistOk(res, payload, persist) {
  return json(res, 200, {
    ok: true,
    ...payload,
    persisted: persist.persisted,
    ...(persist.persisted ? {} : { persistWarning: '已保存但未持久化' }),
  });
}

export { json, readBody, persistOk };
