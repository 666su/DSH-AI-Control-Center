
import fs from 'node:fs';
import { config } from '../config.js';
import { db, nowIso, addLog } from '../database/db.js';
import { broadcast } from './hub.js';
import { sendNotification, classifyDshError } from '../services/notifyService.js';

let offset = 0;
let timer = null;
let lastStatusSeen = null;

/** Tail the DSH log file, persisting new lines to the logs table. */
function tailOnce() {
  try {
    const size = fs.statSync(config.dsh.logFile).size;
    if (size < offset) offset = 0; // file was truncated/rotated
    if (size === offset) return;
    const fd = fs.openSync(config.dsh.logFile, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const text = buf.toString('utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const level = /error|fail/i.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : 'info';
      db.prepare('INSERT INTO logs (ts, level, source, message) VALUES (?, ?, ?, ?)')
        .run(nowIso(), level, 'dsh', line.slice(0, 4000));
      broadcast('log', { ts: nowIso(), level, source: 'dsh', message: line.slice(0, 4000) });
      if (level === 'error') queueErrorNotification(line);
    }
  } catch { /* file may not exist yet */ }
}


// ---- 会话错误去重推送（防刷屏）----
let pendingErrors = [];
let flushTimer = null;
const notifyCooldown = new Map(); // kind -> last notified timestamp
const COOLDOWN_MS = 5 * 60 * 1000; // 同类错误 5 分钟内只推一次

function queueErrorNotification(line) {
  const cls = classifyDshError(line);
  if (cls.kind === 'unknown') return; // 只推送可识别的关键错误
  pendingErrors.push({ kind: cls.kind, label: cls.label, line });
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushErrors, 8000);
  flushTimer.unref?.();
}

function flushErrors() {
  flushTimer = null;
  if (!pendingErrors.length) return;
  const items = pendingErrors.slice();
  pendingErrors = [];
  const kinds = [...new Set(items.map(i => i.kind))];
  const labels = [...new Set(items.map(i => i.label))];
  // 冷却期内该类型已推过，则跳过
  const now = Date.now();
  const fresh = kinds.filter(k => !notifyCooldown.has(k) || now - notifyCooldown.get(k) >= COOLDOWN_MS);
  if (!fresh.length) return;
  for (const k of fresh) notifyCooldown.set(k, now);
  sendNotification('dsh.session.error', {
    count: items.length,
    kinds: fresh,
    labels: fresh.map(k => labels[kinds.indexOf(k)]).filter(Boolean),
    samples: items.slice(0, 3).map(i => i.line.slice(0, 200))
  }).catch(() => {});
}

export function startLogTailer() {
  // prime offset at current end
  try { offset = fs.statSync(config.dsh.logFile).size; } catch { offset = 0; }
  tailOnce();
  timer = setInterval(tailOnce, 2000);
  timer.unref?.();
  return timer;
}

export function stopLogTailer() {
  if (timer) clearInterval(timer);
  timer = null;
}
