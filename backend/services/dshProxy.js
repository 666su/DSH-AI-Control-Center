import http from 'node:http';
import { config } from '../config.js';
import { parseTokenFromLog } from './dshService.js';

/**
 * DSH Web 受保护的反向代理。
 *
 * 目的：不把 DSH Web（3080）直接暴露到公网，而是让 dshui 域名先打到控制中心（3081），
 * 控制中心校验登录 cookie 后，再以服务端 mint 的 DSH 认证 cookie 转发到 127.0.0.1:3080。
 * 这样任何人不先登录控制中心（知道密码）就无法触达 DSH。
 */

// 缓存的 DSH 认证 cookie（服务端 mint 一次，DSH token 变化时重新 mint）
let cachedCookie = null;
let cachedToken = null;

/** 命中 /?token= 以 mint DSH 的 HttpOnly 认证 cookie。 */
async function mintDshCookie() {
  const parsed = parseTokenFromLog();
  const token = parsed ? parsed.token : null;
  if (!token) return null;
  if (cachedCookie && cachedToken === token) return cachedCookie;

  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: config.dsh.port,
      path: '/?token=' + encodeURIComponent(token),
      headers: { 'User-Agent': 'dsh-cc-proxy/1.0' }
    }, (res) => {
      const setCookies = res.headers['set-cookie'] || [];
      res.resume();
      const auth = setCookies.find(c => c.startsWith('dsh-auth-'));
      if (auth) {
        cachedCookie = auth.split(';')[0]; // 仅 name=value
        cachedToken = token;
      }
      resolve(cachedCookie);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

// 逐跳头部，转发时剥离（由 Node 自行管理）
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'cookie'
]);

/** 把请求流式转发到本地 DSH Web（注入 mint 出的认证 cookie，Host 改写为 127.0.0.1 以通过 browser-trust fence）。 */
export async function proxyDshTo(req, res) {
  const cookie = await mintDshCookie();
  if (!cookie) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('DSH 不可用：请先启动 DSH（token 未就绪）。');
    return;
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers['host'] = '127.0.0.1:' + config.dsh.port;
  headers['cookie'] = cookie;

  const proxyReq = http.request({
    host: '127.0.0.1',
    port: config.dsh.port,
    path: req.url || '/',
    method: req.method,
    headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
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
