import fs from 'node:fs';
import path from 'node:path';
import { config, LOG_DIR } from '../config.js';
import { getSetting, setSetting, addLog } from '../database/db.js';

/**
 * 通知服务（v3，真实推送）。
 * 通道：Telegram（真实发送）、Server酱（推送到个人微信）、Webhook（企业微信/钉钉/自定义）。
 * 触发源：taskRunner（任务完成/失败）、logTailer（DSH 会话错误）。
 */

const NOTIFY_LOG = path.join(LOG_DIR, 'notify.log');

function writeNotify(event, data) {
  try {
    fs.appendFileSync(NOTIFY_LOG, `[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}
`, 'utf8');
  } catch { /* ignore */ }
}

/** 把 DSH 输出/错误文本归类为常见失败原因。 */
export function classifyDshError(text) {
  const low = text ? String(text).toLowerCase() : '';
  if (/context.{0,25}(length|window|overflow|exceed)|context_length_exceeded|maximum context|输入过长|上下文不足|上下文超|超出上下文|max_context|context window/.test(low) ||
      /token.{0,20}(limit|exceed|overflow)|max_tokens|token数|令牌.{0,10}上限|tokens?\s+(limit|exceed|cap)/.test(low)) {
    return { kind: 'context', label: '上下文不足 / Token 超限' };
  }
  if (/rate.?limit|too many requests|\b429\b|限流|请求过于频繁|rate_limit/.test(low)) {
    return { kind: 'rate_limit', label: '触发限流 (rate limit)' };
  }
  if (/invalid.{0,20}(api.?key|token)|api.?key.{0,20}(invalid|wrong|not|expired)|\b401\b|\b403\b|unauthorized|authentication|无效.{0,10}(key|密钥|token|api)|api.{0,12}(无效|失效|过期)|认证失败|forbidden/.test(low)) {
    return { kind: 'api_key', label: 'API Key 无效 / 失效' };
  }
  if (/network|timeout|econn|etimedout|socket|连接超时|网络错误|connect/.test(low)) {
    return { kind: 'network', label: '网络 / 连接错误' };
  }
  return { kind: 'unknown', label: '执行错误' };
}

export function getNotifyConfig() {
  return {
    enabled: getSetting('notify.enabled', String(config.notify.enabled)) === 'true',
    channels: JSON.parse(getSetting('notify.channels', JSON.stringify(config.notify.channels)) || '[]'),
    telegramBotTokenSet: !!getSetting('notify.telegram.token', ''),
    telegramChatId: getSetting('notify.telegram.chatId', ''),
    serverChanKeySet: !!getSetting('notify.serverchan.key', ''),
    endpoint: getSetting('notify.endpoint', ''),
    logFile: NOTIFY_LOG
  };
}

function getTelegramToken() { return getSetting('notify.telegram.token', ''); }
function getServerChanKey() { return getSetting('notify.serverchan.key', ''); }

export function saveNotifyConfig(cfg) {
  if (cfg.enabled !== undefined) setSetting('notify.enabled', String(!!cfg.enabled));
  if (cfg.channels !== undefined) setSetting('notify.channels', JSON.stringify(cfg.channels));
  if (cfg.telegramBotToken) setSetting('notify.telegram.token', cfg.telegramBotToken);
  if (cfg.telegramChatId !== undefined) setSetting('notify.telegram.chatId', cfg.telegramChatId);
  if (cfg.serverChanKey) setSetting('notify.serverchan.key', cfg.serverChanKey);
  if (cfg.endpoint !== undefined) setSetting('notify.endpoint', cfg.endpoint);
  addLog('info', 'notify', 'notification config updated');
  return getNotifyConfig();
}

// 生成「标题 + 正文」纯文本（各通道各自套壳）
function formatParts(event, data) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  let title = '📢 DSH 通知';
  let body = '';
  switch (event) {
    case 'task.completed':
      title = '✅ 任务运行完成';
      body = '任务 ' + (data.taskId || '') + '「' + (data.name || '') + '」已完成';
      break;
    case 'task.failed':
      title = '❌ 任务运行失败';
      body = '任务 ' + (data.taskId || '') + '「' + (data.name || '') + '」失败' + (data.exitCode != null ? '（exit ' + data.exitCode + '）' : '');
      if (data.label) body += '\n原因：' + data.label;
      if (data.error) body += '\n' + String(data.error).slice(0, 400);
      break;
    case 'dsh.session.error':
      title = '⚠️ DSH 会话异常';
      body = '检测到 ' + (data.count || 0) + ' 条错误';
      if (data.labels && data.labels.length) body += '\n类型：' + data.labels.join('、');
      if (data.samples && data.samples.length) body += '\n示例：' + data.samples[0].slice(0, 200);
      break;
    case 'dsh.halted':
      title = '⛔ DSH 自动恢复已熔断';
      body = data.message || 'DSH 连续多次恢复失败，请人工介入';
      break;
    case 'test':
      title = '🧪 测试推送';
      body = '这是一条来自 DSH 控制中心的测试通知';
      break;
    default:
      body = event + ' ' + JSON.stringify(data);
  }
  return { title, body, ts };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(token, chatId, message) {
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    return { ok: false, status: resp.status, error: j.description || resp.statusText };
  }
  return { ok: true, status: resp.status };
}

// Server酱（个人微信推送）：POST https://sctapi.ftqq.com/<SendKey>.send
async function sendServerChan(key, title, desp) {
  const url = 'https://sctapi.ftqq.com/' + key + '.send';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title: title.slice(0, 32), desp })
  });
  const j = await resp.json().catch(() => ({}));
  const ok = resp.ok && (j.code === 0);
  return { ok, status: resp.status, error: (!ok ? (j.message || j.info || '') : '') };
}

/** 发送通知（异步，不抛异常）。始终先写 notify.log，再按启用状态走通道。 */
export async function sendNotification(event, data) {
  const cfg = getNotifyConfig();
  writeNotify(event, data);
  if (!cfg.enabled) return { delivered: false, reason: 'disabled' };

  const { title, body, ts } = formatParts(event, data);
  const deliveries = [];

  if (cfg.channels.includes('telegram')) {
    const token = getTelegramToken();
    if (token && cfg.telegramChatId) {
      const msg = '<b>' + escapeHtml(title) + '</b>\n' + escapeHtml(body) + '\n<code>' + ts + '</code>';
      try {
        const r = await sendTelegram(token, cfg.telegramChatId, msg);
        deliveries.push({ channel: 'telegram', ...r });
      } catch (e) {
        deliveries.push({ channel: 'telegram', ok: false, reason: e.message });
      }
    } else {
      deliveries.push({ channel: 'telegram', ok: false, reason: '未配置 token / chatId' });
    }
  }

  if (cfg.channels.includes('serverchan')) {
    const key = getServerChanKey();
    if (key) {
      try {
        const r = await sendServerChan(key, title, body + '\n\n' + ts);
        deliveries.push({ channel: 'serverchan', ...r });
      } catch (e) {
        deliveries.push({ channel: 'serverchan', ok: false, reason: e.message });
      }
    } else {
      deliveries.push({ channel: 'serverchan', ok: false, reason: '未配置 SendKey' });
    }
  }

  if (cfg.channels.includes('webhook') && cfg.endpoint) {
    try {
      const resp = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, data, title, body, ts: new Date().toISOString() })
      });
      deliveries.push({ channel: 'webhook', ok: resp.ok, status: resp.status });
    } catch (e) {
      deliveries.push({ channel: 'webhook', ok: false, reason: e.message });
    }
  }

  return { delivered: deliveries.some(d => d.ok), deliveries };
}
