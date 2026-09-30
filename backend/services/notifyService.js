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

/** 把 turn/end 的 reason 转成中文描述。 */
export function describeTurnEnd(reasonKind, reasonDetail) {
  switch (reasonKind) {
    case 'completed': return '正常完成';
    case 'max-tokens': return '输出超长被截断（max-tokens）';
    case 'blocked': return '被策略 / 权限拦截';
    case 'aborted':
      if (reasonDetail === 'user') return '用户手动停止';
      if (reasonDetail === 'parent') return '父级任务取消';
      if (reasonDetail === 'disposed') return '会话被释放';
      if (reasonDetail === 'hook') return '被钩子中止';
      return '对话被中止' + (reasonDetail ? '（' + reasonDetail + '）' : '');
    case 'error': return '执行出错' + (reasonDetail ? '：' + String(reasonDetail).slice(0, 300) : '');
    default: return reasonKind ? ('结束原因：' + reasonKind) : '结束原因未知';
  }
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

/** 读取「工作区对话推送」配置（settings 表覆盖 config.json 默认值）。 */
export function getSessionTurnsConfig() {
  const base = { ...config.notify.sessionTurns };
  const stored = getSetting('notify.sessionTurns', null);
  if (stored) {
    try {
      const u = JSON.parse(stored);
      if (u && typeof u === 'object') return { ...base, ...u };
    } catch { /* ignore broken json */ }
  }
  return base;
}

/** 读取「温度推送」配置（settings 表覆盖 config.json 默认值）。 */
export function getTempAlertConfig() {
  const base = { ...config.monitor.tempAlert };
  const stored = getSetting('monitor.tempAlert', null);
  if (stored) {
    try {
      const u = JSON.parse(stored);
      if (u && typeof u === 'object') return normalizeTempAlert({ ...base, ...u });
    } catch { /* ignore broken json */ }
  }
  return normalizeTempAlert(base);
}

/** 规整温度推送配置，避免前端传脏值。 */
export function normalizeTempAlert(u) {
  u.enabled = !!u.enabled;
  u.onHigh = !!u.onHigh;
  u.onStillHigh = !!u.onStillHigh;
  u.onRecovered = !!u.onRecovered;
  u.gpuC = Math.max(30, Math.min(110, Number(u.gpuC ?? 80)));
  u.cpuC = Math.max(30, Math.min(110, Number(u.cpuC ?? 90)));
  u.hysteresisC = Math.max(0, Math.min(20, Number(u.hysteresisC ?? 3)));
  u.repeatMs = Math.max(60000, Number(u.repeatMs ?? 1800000));
  u.windowSeconds = Math.max(10, Math.min(600, Number(u.windowSeconds ?? 60)));
  // 采样间隔决定窗口内有多少个样本点
  u.intervalMs = Math.max(1000, Number(config.monitor?.intervalMs ?? 5000));
  u.windowSamples = Math.max(2, Math.round(u.windowSeconds * 1000 / u.intervalMs));
  u.minSustained = Math.max(1, Math.min(u.windowSamples, Math.round(Number(u.minSustained ?? 5))));
  return u;
}

/** 持久化温度推送配置。 */
export function saveTempAlertConfig(u) {
  if (!u || typeof u !== 'object') return getTempAlertConfig();
  const base = { ...config.monitor.tempAlert };
  const merged = normalizeTempAlert({ ...base, ...u });
  setSetting('monitor.tempAlert', JSON.stringify(merged));
  addLog('info', 'notify', 'temperature alert config updated');
  return merged;
}

export function getNotifyConfig() {
  return {
    enabled: getSetting('notify.enabled', String(config.notify.enabled)) === 'true',
    channels: JSON.parse(getSetting('notify.channels', JSON.stringify(config.notify.channels)) || '[]'),
    telegramBotTokenSet: !!getSetting('notify.telegram.token', ''),
    telegramChatId: getSetting('notify.telegram.chatId', ''),
    serverChanKeySet: !!getSetting('notify.serverchan.key', ''),
    endpoint: getSetting('notify.endpoint', ''),
    sessionTurns: getSessionTurnsConfig(),
    tempAlert: getTempAlertConfig(),
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
  if (cfg.sessionTurns && typeof cfg.sessionTurns === 'object') {
    const base = { ...config.notify.sessionTurns };
    const merged = { ...base, ...cfg.sessionTurns };
    // 规整类型，避免前端传脏值
    merged.intervalMs = Math.max(1000, Number(merged.intervalMs) || 3000);
    merged.maxPromptChars = Math.max(0, Math.min(500, Number(merged.maxPromptChars) || 120));
    if (!Array.isArray(merged.ignoreWorkspaces)) merged.ignoreWorkspaces = [];
    merged.enabled = !!merged.enabled;
    merged.onCompleted = !!merged.onCompleted;
    merged.onFailed = !!merged.onFailed;
    merged.onAborted = !!merged.onAborted;
    setSetting('notify.sessionTurns', JSON.stringify(merged));
  }
  if (cfg.tempAlert && typeof cfg.tempAlert === 'object') saveTempAlertConfig(cfg.tempAlert);
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
    case 'temp.high':
      title = '🔥 温度过高告警';
      body = (data.label || '设备') + ' 当前 ' + data.value + '°C，已超过阈值 ' + data.threshold + '°C';
      if (data.phase === 'still high') body += '\n（持续高温提醒）';
      else body += '\n请检查散热/负载情况';
      break;
    case 'temp.recovered':
      title = '✅ 温度已恢复正常';
      body = (data.label || '设备') + ' 已降至 ' + data.value + '°C，低于阈值 ' + data.threshold + '°C';
      break;
    case 'test':
      title = '🧪 测试推送';
      body = '这是一条来自 DSH 控制中心的测试通知';
      break;
    case 'session.turn.end': {
      const ws = data.workspace || '未知工作区';
      const conv = data.title
        || (data.sessionId ? String(data.sessionId).replace(/^session-/, '').slice(0, 12) + '…' : '对话');
      const turnTag = data.turn != null ? '（第 ' + data.turn + ' 轮）' : '';
      const promptTag = data.prompt ? '\n指令：' + data.prompt : '';
      const okTurn = data.reasonKind === 'completed';
      title = okTurn ? '✅ DSH 对话完成' : '❌ DSH 对话异常结束';
      body = '工作区：' + ws + '\n对话：' + conv + turnTag;
      if (!okTurn) body += '\n原因：' + describeTurnEnd(data.reasonKind, data.reasonDetail);
      body += promptTag;
      break;
    }
    case 'session.watcher.error':
      title = '⚠️ 会话监听异常';
      body = data.message || '工作区对话监听出现问题';
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