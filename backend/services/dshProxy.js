import http from 'node:http';
import { config } from '../config.js';
import { parseTokenFromLog } from './dshService.js';

/**
 * DSH Web 受保护的反向代理。
 *
 * 目的：不把 DSH Web（3080）直接暴露到公网，而是让代理域名先打到控制中心（3081），
 * 控制中心校验登录 cookie 后，再以服务端 mint 的 DSH 认证 cookie 转发到 127.0.0.1:3080。
 * 这样任何人不先登录控制中心（知道密码）就无法触达 DSH。
 */

// 缓存的 DSH 认证 cookie（TTL 5 秒，DSH token 变化或重启后自动重新 mint）
let cachedCookie = null;
let cachedToken = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5000; // 5 秒，确保 DSH 重启后不会使用过期 cookie

/** 命中 /?token= 以 mint DSH 的 HttpOnly 认证 cookie。 */
async function mintDshCookie() {
  const parsed = parseTokenFromLog();
  const token = parsed ? parsed.token : null;
  if (!token) return null;
  const now = Date.now();
  if (cachedCookie && cachedToken === token && (now - cachedAt) < CACHE_TTL_MS) return cachedCookie;

  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: config.dsh.port,
      path: '/?token=' + encodeURIComponent(token),
      headers: { 'User-Agent': 'dsh-cc-proxy/1.0' }
    }, (res) => {
      const setCookies = res.headers['set-cookie'] || [];
      // 日志只记录 cookie 名，不记录值（避免泄露认证凭据）
      const cookieNames = setCookies.map(c => c.split('=')[0]);
      console.log('[proxy] mintDshCookie: status=' + res.statusCode + ' cookies=' + JSON.stringify(cookieNames));
      res.resume();
      const auth = setCookies.find(c => c.startsWith('dsh-auth-'));
      if (auth) {
        cachedCookie = auth.split(';')[0]; // 仅 name=value
        cachedToken = token;
        cachedAt = Date.now();
        resolve(cachedCookie);
      } else {
        // 未获取到新 cookie —— 清除过期缓存，避免返回无效 cookie
        cachedCookie = null;
        cachedToken = null;
        cachedAt = 0;
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

// 逐跳头部，转发请求时剥离（由 Node 自行管理）
// 注意：content-length 不能在此剥离！否则 POST 请求体长度丢失，DSH 返回 400
// origin / sec-fetch-site 必须剥离：DSH 校验 Origin 是否在 trusted-host，
// 公网域名不在列表会被拒（HTTP 400 / WebSocket 403 forbidden）
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie',
  'origin', 'sec-fetch-site'
]);

/** 把请求流式转发到本地 DSH Web（注入 mint 出的认证 cookie，Host 改写为 127.0.0.1 以通过 browser-trust fence）。 */
export async function proxyDshTo(req, res) {
  const cookie = await mintDshCookie();
  if (!cookie) {
    console.log('[proxy] mintDshCookie returned NULL, token not ready');
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('DSH 不可用：请先启动 DSH（token 未就绪）。');
    return;
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    headers[k] = v;
  }
  headers['host'] = '127.0.0.1:' + config.dsh.port;
  headers['cookie'] = cookie;

  console.log('[proxy] forwarding to DSH: method=' + req.method + ' url=' + (req.url || '/') + ' content-length=' + (req.headers['content-length'] || 'none'));

  const proxyReq = http.request({
    host: '127.0.0.1',
    port: config.dsh.port,
    path: req.url || '/',
    method: req.method,
    headers
  }, (proxyRes) => {
    console.log('[proxy] DSH responded: status=' + proxyRes.statusCode + ' headers=' + JSON.stringify(proxyRes.headers));
    // 仅剥离 connection 和 keep-alive（逐跳头），否则浏览器看到 keep-alive
    // 但代理实际关闭连接，导致 ERR_CONNECTION_CLOSED。
    // 保留 transfer-encoding 让 Node 正确处理 chunked 响应。
    const responseHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'connection' || lk === 'keep-alive') continue;
      responseHeaders[k] = v;
    }
    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    if (res.headersSent) { res.destroy(); }
    else {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('DSH 代理错误: ' + e.message);
    }
  });
  req.pipe(proxyReq);
}


/** WebSocket 升级代理：把代理域名的 WS 连接转发到本地 DSH（注入 mint cookie + Host 改写）。
 *  解决 DSH web 前端"连接中"——HTTP 通了但 WS 没代理的问题。 */
export async function proxyDshWs(req, socket, head) {
  console.log('[ws-proxy] Starting proxyDshWs for url=' + req.url);
  const cookie = await mintDshCookie();
  if (!cookie) { console.log('[ws-proxy] mintDshCookie returned NULL, destroying socket'); socket.destroy(); return; }

  // 构建转发头：保留 connection/upgrade/sec-websocket-*，剥离 host/cookie/content-length/origin
  // origin 必须剥离：DSH 校验 Origin 是否在 trusted-host，公网域名不在列表会返回 403 forbidden
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'cookie' || lk === 'content-length' || lk === 'origin') continue;
    headers[k] = v;
  }
  headers['host'] = '127.0.0.1:' + config.dsh.port;
  headers['cookie'] = cookie;

  // 日志只记录关键头，不含 cookie 值（避免泄露认证凭据）
  const safeHeaders = { ...headers };
  delete safeHeaders.cookie;
  console.log('[ws-proxy] Forwarded headers:', JSON.stringify(safeHeaders));

  const proxyReq = http.request({
    host: '127.0.0.1',
    port: config.dsh.port,
    method: 'GET',
    path: req.url,
    headers
  });

  proxyReq.on('error', (e) => { console.log('[ws-proxy] Error: ' + e.message); socket.destroy(); });
  // 非 101 响应（DSH 拒绝升级）：收集 body 用于诊断后关闭
  proxyReq.on('response', (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').substring(0, 200);
      console.log('[ws-proxy] DSH responded with status=' + proxyRes.statusCode + ' body=' + body);
      socket.destroy();
    });
  });
  proxyReq.setTimeout(10000, () => {
    console.log('[ws-proxy] Timeout waiting for WebSocket upgrade');
    socket.destroy();
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    console.log('[ws-proxy] DSH responded with 101 Switching Protocols');
    // 回写 101 Switching Protocols 响应给客户端
    let raw = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      raw += k + ': ' + v + '\r\n';
    }
    raw += '\r\n';
    socket.write(raw);
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    // 双向 pipe
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
    socket.on('close', () => proxySocket.destroy());
  });

  if (head && head.length) proxyReq.write(head);
  proxyReq.end();
}
