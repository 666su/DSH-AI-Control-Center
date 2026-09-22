
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, ROOT_DIR } from './config.js';
import { db, addLog, getSetting, setSetting } from './database/db.js';
import apiRouter from './api/index.js';
import { startMonitor } from './services/systemMonitor.js';
import { startLogTailer } from './monitor/logTailer.js';
import { broadcast } from './monitor/hub.js';
import { getStatus } from './services/dshService.js';
import { proxyDshTo, proxyDshWs } from './services/dshProxy.js';
import crypto from 'node:crypto';

// 支持多个代理域名（数组优先，兼容旧 proxyHost 字段）
const PROXY_HOSTS = new Set(
  (config.dsh.proxyHosts || (config.dsh.proxyHost ? [config.dsh.proxyHost] : [])).map(h => String(h).toLowerCase())
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ---- DSH Web 受保护代理 ----
// ⚠️ 必须注册在 express.json() 之前！express.json() 会消费请求体，
// 若代理在其后注册，POST 请求体被吃掉，转发到 DSH 时 content-length 对不上，
// DSH 永远等不到 body → 不响应（浏览器 ERR_CONNECTION_CLOSED / 按钮/对话无反应）。
// 只有 Host 命中 dsh.proxyHosts 时才代理；否则走正常控制中心路由。
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (PROXY_HOSTS.has(host)) {
    console.log('[proxy] Request hit proxy host: ' + host + ' url=' + req.url);
    // 必须先登录控制中心（cc_auth cookie）
    if (accessToken) {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.cc_auth !== accessToken) {
        console.log('[proxy] cc_auth cookie missing or invalid, redirecting to login');
        // 未登录：优先跳转控制中心登录页；未配置 publicUrl 则返回 401
        if (config.server.publicUrl) return res.redirect(config.server.publicUrl);
        return res.status(401).end('unauthorized: 请先登录控制中心');
      }
    }
    return proxyDshTo(req, res);
  } else if (config.server.cookieDomain && host.includes(config.server.cookieDomain.replace(/^\./, ''))) {
    console.log('[proxy] Non-proxy request for host: ' + host + ' (not in proxyHosts)');
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- optional access token ----
let accessToken = config.server.token || '';
if (!accessToken) {
  // generate once and persist
  const tokenFile = path.join(ROOT_DIR, 'config', 'access-token.txt');
  try {
    accessToken = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch { /* not set */ }
  if (!accessToken) {
    accessToken = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(tokenFile, accessToken, 'utf8');
  }
}

// ---- cookie 解析（无第三方依赖）----
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- 设置登录 cookie（供 DSH 代理子域名共享登录态）----
app.post('/api/auth/session', (req, res) => {
  const opts = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000 };
  if (config.server.cookieDomain) opts.domain = config.server.cookieDomain;
  res.cookie('cc_auth', accessToken, opts);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/health') || req.path.startsWith('/debug/')) return next();
  if (!accessToken) return next();
  const provided = req.headers['x-access-token'];
  if (provided === accessToken) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
});

// ---- debug: proxy state ----
app.get('/api/debug/proxy', (req, res) => {
  res.json({
    proxyHosts: [...PROXY_HOSTS],
    incomingHost: req.headers.host,
    accessToken: accessToken ? '***set***' : 'none',
    dshConfig: {
      serviceName: config.dsh.serviceName,
      proxyHost: config.dsh.proxyHost,
      proxyHosts: config.dsh.proxyHosts,
      publicUrl: config.dsh.publicUrl
    }
  });
});

app.use('/api', apiRouter);

// ---- static frontend (production build) ----
const frontendDist = path.join(ROOT_DIR, 'frontend', 'dist');
if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// ---- error handler ----
app.use((err, req, res, next) => {
  console.error('[server] error:', err);
  res.status(500).json({ ok: false, error: err.message });
});

// ---- background services ----
startMonitor();
startLogTailer();

// poll DSH status change -> broadcast (status page also polls directly)
let lastRunning = null;
setInterval(async () => {
  try {
    const s = await getStatus();
    if (s.running !== lastRunning) {
      lastRunning = s.running;
      addLog(s.running ? 'info' : 'warn', 'dsh', s.running ? 'DSH is running' : 'DSH is NOT running');
      broadcast('dsh-status', { running: s.running, pid: s.pid });
    }
  } catch { /* ignore */ }
}, 10000);

// ---- WebSocket 升级代理（代理域名的 WS 连接转发到 DSH）----
// 必须用 http.createServer(app) 显式持有 server 对象，确保 upgrade 事件被捕获
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  const host = String(req.headers.host || '').toLowerCase();
  console.log('[ws-upgrade] Request: host=' + host + ' url=' + req.url + ' cookie=' + (req.headers.cookie ? 'present' : 'MISSING'));
  if (PROXY_HOSTS.has(host)) {
    // 必须先登录控制中心（cc_auth cookie），与 HTTP 代理一致
    if (accessToken) {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.cc_auth !== accessToken) {
        console.log('[ws-upgrade] cc_auth cookie missing or invalid, destroying socket');
        socket.destroy();
        return;
      }
    }
    console.log('[ws-upgrade] Proxying WebSocket to DSH');
    return proxyDshWs(req, socket, head);
  }
  console.log('[ws-upgrade] Non-proxy host: ' + host + ' - not handling');
});

const PORT = config.server.port;
server.listen(PORT, config.server.host, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  DSH AI Control Center backend');
  console.log('  http://' + config.server.host + ':' + PORT);
  if (accessToken) console.log('  Access token: ' + accessToken + '  (header X-Access-Token)');
  console.log('  DSH web:      ' + config.dsh.webUrl);
  console.log('──────────────────────────────────────────────');
  addLog('info', 'system', 'control-center backend started on port ' + PORT);
});
