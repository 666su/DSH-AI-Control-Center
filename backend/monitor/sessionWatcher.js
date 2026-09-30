import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { nowIso, addLog, addSessionTurn, markSessionTurnNotified } from '../database/db.js';
import { getSessionTurnsConfig, sendNotification } from '../services/notifyService.js';
import { broadcast } from './hub.js';

/**
 * 工作区对话监听器（session watcher）—— 「工作区里的对话框结束了通知我」。
 *
 * 背景：控制中心已有的「指令完成推送」只覆盖 /api/tasks 创建的 headless 任务。
 * 用户在 DSH Web 界面（工作区内）直接对话时，DSH 会把每个会话写成
 *   <USERPROFILE>\.dsh\sessions\<工作区>\<session-id>\session.v*.jsonl.zstd
 * 每一轮回复结束都会追加一条 turn/end 事件：
 *   {"type":"turn/end","seq":N,"time":MS,"data":{"turn":16,"reason":{"kind":"completed"}}}
 *   reason.kind = completed | error | max-tokens | aborted | blocked | interrupted
 * 这就是「对话框结束」的地面事实，本模块据此推送。
 *
 * 文件是「多个 zstd 帧顺序追加」的结构（DSH 每批事件压一个独立帧），所以只能
 * 按帧边界增量解码。scanZstdFrames 是 DSH 内部同名函数的等价移植——只解析帧头、
 * 不解压块，因此全量扫一遍元数据非常快。
 */

const ZSTD_MAGIC = 0xfd2fb528;

/** 定位 buffer 内所有结构完整的 zstd 帧；末尾半截帧返回 tornStart。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) break;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** 解码一个完整的 zstd 帧为文本；失败返回空串。 */
function decodeFrame(buf, frame) {
  try {
    return zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8');
  } catch {
    return '';
  }
}

/** 取文本里第一条能 parse 的 JSON 事件。 */
function firstJsonEvent(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') return e;
    } catch { /* next */ }
  }
  return null;
}

/** 读文件 [offset, offset+length) 片段。 */
function readSlice(p, offset, length) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, b, got, length - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    return got < length ? b.subarray(0, got) : b;
  } finally {
    fs.closeSync(fd);
  }
}

/** 会话日志 header：{"type":"session","id","cwd","createdAt"}。 */
function parseHeaderObj(o) {
  if (!o || o.type !== 'session') return null;
  return {
    sessionId: o.id || null,
    cwd: o.cwd || null,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : null
  };
}

/** 从 user/message 事件里取纯文本指令。 */
function messageText(e) {
  const data = e && e.data;
  if (!data || !Array.isArray(data.content)) return '';
  const parts = [];
  for (const c of data.content) {
    if (c && typeof c === 'object' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** 只认用户真实输入，排除 approval / system 之类注入消息。 */
function isUserInput(e) {
  const src = e && e.data && e.data.source;
  return !src || src.kind === 'user';
}

/** turn/end reason → 简短中文说明。 */
function turnDetail(reason) {
  if (!reason || typeof reason !== 'object') return '';
  const kind = reason.kind;
  if (kind === 'completed') return '';
  if (kind === 'error') {
    const er = reason.error;
    if (!er) return '';
    if (typeof er === 'string') return er;
    return er.message || (er.info && er.info.message) || er.code || '';
  }
  if (kind === 'aborted') {
    const r = reason.reason;
    if (!r) return '';
    if (typeof r === 'string') return r;
    return r.kind || (r.reason ? 'hook:' + r.reason : '');
  }
  if (kind === 'max-tokens') return '输出长度达到上限，回复被截断';
  if (kind === 'blocked') return '被权限 / 策略拦截，未执行';
  return kind ? String(kind) : '';
}

const FAILURE_KINDS = new Set(['error', 'max-tokens', 'blocked', 'interrupted', 'unknown']);

// ---- headless 任务窗口：/api/tasks 自己会推 task.completed / task.failed ----
const taskWindows = new Map(); // 规范化工作区 -> Set(sinceMs)
const normWs = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

export function registerTaskWindow(workspace, sinceMs = Date.now()) {
  const k = normWs(workspace);
  if (!k) return;
  if (!taskWindows.has(k)) taskWindows.set(k, new Set());
  taskWindows.get(k).add(sinceMs);
}

export function unregisterTaskWindow(workspace, sinceMs) {
  const set = taskWindows.get(normWs(workspace));
  if (!set) return;
  if (sinceMs != null) set.delete(sinceMs); else set.clear();
}

/** 判断某个 turn/end 是否属于 headless 任务自己新建的会话。 */
function isTaskOwned(st, evtTime) {
  const wins = taskWindows.get(normWs(st.cwd));
  if (!wins || wins.size === 0) return false;
  const now = Date.now();
  for (const sinceMs of wins) {
    // 会话是在任务运行期间新建的 → 属于该任务
    if (st.createdAt && st.createdAt >= sinceMs - 60000) return true;
    // 兜底：turn 结束时间落在任务运行窗口内
    if (evtTime && evtTime >= sinceMs - 60000 && evtTime <= now + 60000) return true;
  }
  return false;
}

/** 会话日志根目录。 */
export function resolveSessionsRoot() {
  const st = getSessionTurnsConfig();
  if (st.sessionsRoot) return st.sessionsRoot;
  const profile = config.dsh.userProfile || process.env.USERPROFILE || os.homedir();
  return path.join(profile, '.dsh', 'sessions');
}

/** 收集 <root>/<工作区>/<session>/session.v*.jsonl.zstd。 */
function discoverLogFiles(rootDir) {
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(rootDir); } catch { return out; }
  for (const ws of workspaces) {
    const wsDir = path.join(rootDir, ws);
    let sess = [];
    try {
      if (!fs.statSync(wsDir).isDirectory()) continue;
      sess = fs.readdirSync(wsDir);
    } catch { continue; }
    for (const sname of sess) {
      const sDir = path.join(wsDir, sname);
      let files = [];
      try {
        if (!fs.statSync(sDir).isDirectory()) continue;
        files = fs.readdirSync(sDir);
      } catch { continue; }
      for (const f of files) {
        if (!/^session\.v\d+\.jsonl\.zstd$/.test(f)) continue;
        const p = path.join(sDir, f);
        try {
          const s = fs.statSync(p);
          out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs, workspaceDir: ws });
        } catch { /* 文件刚好消失 */ }
      }
    }
  }
  return out;
}

function newFileState(entry) {
  return {
    initialized: false, backfilled: false, size: 0, endOffset: 0,
    cwd: null, sessionId: null, createdAt: null,
    title: '', prompt: '', lastTurnEndSeq: null,
    lastSeenAt: entry.mtimeMs, skipped: 0,
    workspaceDir: path.basename(path.dirname(entry.path))
  };
}

function pruneIgnored(cwd, ignore) {
  if (!ignore || !ignore.length || !cwd) return false;
  const low = String(cwd).toLowerCase();
  return ignore.some(k => k && low.includes(String(k).toLowerCase()));
}

const stats = {
  pollCount: 0, decodeMs: 0, lastPollAt: null, lastError: null,
  turnsSeen: 0,        // 观察到的 turn/end（已去重）
  turnsRecorded: 0,    // 已写入 session_turns
  turnsNotified: 0,    // 已实际送达
  turnsSuppressed: 0,  // 已入库但因开关未推送
  turnsTaskOwned: 0,   // headless 任务会话，跳过
  turnsDedup: 0,       // 同一 seq 重复，跳过
  backfilled: 0        // 启动回填入库条数
};

const tracked = new Map(); // logPath -> state

/**
 * 处理一条会话事件。
 * mode='live'      实时：入库 + SSE 广播 + 推送
 * mode='backfill'  回填：只入库（不推送、不广播）
 * mode='none'      忽略（只更新 title / prompt 上下文）
 */
function applyEvent(st, e, cfg, mode) {
  if (e.type === 'session') {
    const h = parseHeaderObj(e);
    if (h) {
      if (!st.cwd) st.cwd = h.cwd;
      if (!st.sessionId) st.sessionId = h.sessionId;
      if (!st.createdAt) st.createdAt = h.createdAt;
    }
    return;
  }
  if (e.type === 'session/title') {
    const t = e.data && e.data.title;
    if (typeof t === 'string' && t.trim()) st.title = t.trim();
    return;
  }
  if (e.type === 'user/message') {
    if (!isUserInput(e)) return;
    const txt = messageText(e);
    if (txt) st.prompt = txt;
    return;
  }
  if (e.type === 'turn/end') return recordTurnEnd(st, e, cfg, mode);
}

function recordTurnEnd(st, e, cfg, mode) {
  const data = e.data || {};
  const reason = data.reason || {};
  const kind = reason.kind || 'unknown';
  const detail = String(turnDetail(reason) || '');
  const turn = data.turn != null ? Number(data.turn) : null;
  const evtTime = typeof e.time === 'number' ? e.time : null;

  // 同一 seq 只处理一次（重启重扫 / 帧重放都幂等）
  if (e.seq != null) {
    if (st.lastTurnEndSeq != null && e.seq <= st.lastTurnEndSeq) {
      st.skipped += 1;
      stats.turnsDedup += 1;
      return;
    }
    st.lastTurnEndSeq = e.seq;
  }
  if (mode === 'none') return;

  const ws = st.cwd || st.workspaceDir || '未知工作区';
  const sessionId = st.sessionId || '';
  const title = st.title || '';
  const maxPrompt = Math.max(0, Math.min(500, Number(cfg.maxPromptChars) || 120));
  let prompt = st.prompt || '';
  if (prompt && prompt.length > maxPrompt) prompt = prompt.slice(0, maxPrompt) + '…';

  // 去重 1：headless 任务会自己推 task.completed / task.failed
  if (isTaskOwned(st, evtTime)) {
    st.skipped += 1;
    stats.turnsTaskOwned += 1;
    if (mode === 'live') addLog('info', 'task', '跳过 headless 任务会话的 turn/end：' + ws + ' ' + sessionId);
    return;
  }

  stats.turnsSeen += 1;
  const id = addSessionTurn({
    workspace: ws, session_id: sessionId, title, turn,
    reason_kind: kind, reason_detail: detail, prompt, notified: 0
  });
  stats.turnsRecorded += 1;
  if (mode === 'backfill') { stats.backfilled += 1; return; }

  broadcast('session-turn', {
    id, ts: nowIso(), workspace: ws, sessionId, title, turn,
    reasonKind: kind, reasonDetail: detail, prompt
  });

  // 去重 2：用户关掉了某一类结束原因的推送
  let gate = null;
  if (kind === 'completed' && !cfg.onCompleted) gate = 'onCompleted=false';
  else if (kind === 'aborted' && !cfg.onAborted) gate = 'onAborted=false';
  else if (FAILURE_KINDS.has(kind) && !cfg.onFailed) gate = 'onFailed=false';

  if (gate) {
    st.skipped += 1;
    stats.turnsSuppressed += 1;
    addLog('info', 'task', '已记录对话结束（未推送，' + gate + '）：' + ws);
    return;
  }

  sendNotification('session.turn.end', {
    workspace: ws, sessionId, title, turn, reasonKind: kind, reasonDetail: detail, prompt
  }).then(res => {
    const ok = !!(res && res.delivered);
    markSessionTurnNotified(id, ok);
    if (ok) stats.turnsNotified += 1;
    addLog(ok ? 'info' : 'warn', 'notify',
      '对话结束推送' + (ok ? '已送达' : '未送达') + '：' + ws + (kind === 'completed' ? '' : ' [' + kind + ']'));
  }).catch(err => addLog('warn', 'notify', '对话结束推送失败：' + err.message));
}

/** 首次发现文件：解析帧边界 + header，只登记基线，不回放历史通知。 */
function initFile(entry, cfg) {
  const st = newFileState(entry);
  if (entry.size < 8) { tracked.set(entry.path, st); return; }
  let buf;
  try { buf = fs.readFileSync(entry.path); } catch { tracked.set(entry.path, st); return; }
  const { frames } = scanZstdFrames(buf);
  if (!frames.length) { tracked.set(entry.path, st); return; }
  // 第 0 帧是 header
  const h = firstJsonEvent(decodeFrame(buf, frames[0]));
  if (h) {
    const hh = parseHeaderObj(h);
    if (hh) { st.cwd = hh.cwd; st.sessionId = hh.sessionId; st.createdAt = hh.createdAt; }
  }
  st.endOffset = frames[frames.length - 1].end;
  st.size = buf.length;
  st.initialized = true;
  tracked.set(entry.path, st);
}

/** 已有基线：只解码新追加的完整帧。 */
function advanceFile(entry, cfg) {
  const st = tracked.get(entry.path);
  if (!st) return;
  if (entry.size < st.endOffset) {
    // 文件被截断 / 重写（torn tail 修复、格式迁移）→ 重新基线
    const fresh = newFileState(entry);
    fresh.cwd = st.cwd; fresh.sessionId = st.sessionId; fresh.createdAt = st.createdAt;
    fresh.title = st.title; fresh.prompt = st.prompt;
    tracked.set(entry.path, fresh);
    return;
  }
  if (entry.size === st.endOffset) return;

  const length = entry.size - st.endOffset;
  let chunk;
  try { chunk = readSlice(entry.path, st.endOffset, length); } catch { return; }
  if (!chunk.length) return;
  const { frames } = scanZstdFrames(chunk);
  if (!frames.length) return;   // 末尾是半截帧，等下一次轮询

  const t0 = Date.now();
  for (const fr of frames) handleLines(st, decodeFrame(chunk, fr), cfg, 'live');
  stats.decodeMs += Date.now() - t0;
  st.endOffset += frames[frames.length - 1].end;
  st.size = st.endOffset;
}

function handleLines(st, text, cfg, mode) {
  if (!text) return;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || !e.type) continue;
    applyEvent(st, e, cfg, mode);
  }
}

function processFile(entry, cfg) {
  const st = tracked.get(entry.path);
  if (!st || !st.initialized) initFile(entry, cfg);
  else advanceFile(entry, cfg);
}

/** 一次完整轮询。 */
function pollOnce() {
  stats.pollCount += 1;
  const cfg = getSessionTurnsConfig();
  stats.lastPollAt = nowIso();
  if (!cfg.enabled) { stats.lastError = null; return; }

  let rootDir;
  try { rootDir = resolveSessionsRoot(); } catch (e) { stats.lastError = e.message; return; }
  let files;
  try { files = discoverLogFiles(rootDir); } catch (e) { stats.lastError = e.message; return; }

  const ignore = Array.isArray(cfg.ignoreWorkspaces) ? cfg.ignoreWorkspaces : [];
  const alive = new Set(files.map(f => f.path));
  for (const p of [...tracked.keys()]) if (!alive.has(p)) tracked.delete(p);

  for (const entry of files) {
    const st = tracked.get(entry.path);
    if (st && st.cwd && pruneIgnored(st.cwd, ignore)) continue;   // 已知忽略，直接跳过
    try {
      processFile(entry, cfg);
      const st2 = tracked.get(entry.path);
      if (st2 && st2.cwd && pruneIgnored(st2.cwd, ignore)) tracked.delete(entry.path);
    } catch (e) {
      stats.lastError = e.message;
      addLog('warn', 'task', '会话日志处理失败 ' + entry.path + '：' + e.message);
    }
  }
  stats.lastError = null;
}

/** 回填最近 N 小时的历史对话结束（只入库，不推送）。分片执行，不阻塞事件循环。 */
let backfilling = false;
async function backfillPass() {
  if (backfilling) return;
  const cfg = getSessionTurnsConfig();
  const hours = Number(cfg.backfillHours) || 0;
  if (hours <= 0) return;
  backfilling = true;
  try {
    const rootDir = resolveSessionsRoot();
    const ignore = Array.isArray(cfg.ignoreWorkspaces) ? cfg.ignoreWorkspaces : [];
    // 大文件跳过，避免回填拖慢启动
    const files = discoverLogFiles(rootDir).filter(f => f.size <= 5 * 1024 * 1024);
    const cutoff = Date.now() - hours * 3600 * 1000;
    for (const entry of files) {
      const st = tracked.get(entry.path);
      if (!st || st.backfilled) continue;
      if (st.cwd && pruneIgnored(st.cwd, ignore)) continue;
      st.backfilled = true;
      try {
        const buf = fs.readFileSync(entry.path);
        const { frames } = scanZstdFrames(buf);
        for (const fr of frames) {
          const text = decodeFrame(buf, fr);
          if (!text) continue;
          for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            if (!e || typeof e !== 'object' || !e.type) continue;
            if (e.type === 'turn/end') {
              if (typeof e.time === 'number' && e.time >= cutoff) {
                applyEvent(st, e, cfg, 'backfill');
              } else if (typeof e.seq === 'number' && (st.lastTurnEndSeq == null || e.seq > st.lastTurnEndSeq)) {
                st.lastTurnEndSeq = e.seq;   // 早于回填窗口的只记账，不入库
              }
              continue;
            }
            applyEvent(st, e, cfg, 'backfill');
          }
        }
      } catch (e) {
        addLog('warn', 'task', '回填历史失败 ' + entry.path + '：' + e.message);
      }
      await new Promise(r => setImmediate(r));
    }
    addLog('info', 'task', '历史对话结束回填完成（最近 ' + hours + ' 小时，共 ' + stats.backfilled + ' 条）');
  } finally {
    backfilling = false;
  }
}

let timer = null;

export function startSessionWatcher() {
  if (timer) return timer;
  const cfg = getSessionTurnsConfig();
  if (!cfg.enabled) {
    addLog('info', 'task', '工作区对话监听已关闭（notify.sessionTurns.enabled=false）');
    return null;
  }
  const intervalMs = Math.max(1000, Number(cfg.intervalMs) || 3000);
  addLog('info', 'task', '工作区对话监听启动：' + resolveSessionsRoot() + '（' + intervalMs + 'ms）');
  try { pollOnce(); } catch (e) { stats.lastError = e.message; }
  timer = setInterval(() => {
    try { pollOnce(); } catch (e) { stats.lastError = e.message; }
  }, intervalMs);
  if (timer.unref) timer.unref();
  // 历史回填异步跑，不阻塞启动
  setImmediate(() => { backfillPass().catch(() => {}); });
  return timer;
}

export function stopSessionWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function watcherStatus() {
  const cfg = getSessionTurnsConfig();
  let root = null, rootExists = false;
  try { root = resolveSessionsRoot(); rootExists = fs.existsSync(root); } catch { /* ignore */ }
  return {
    enabled: !!cfg.enabled,
    root,
    rootExists,
    running: !!timer,
    trackingFiles: tracked.size,
    workspaces: [...new Set([...tracked.values()].map(s => s.cwd).filter(Boolean))],
    intervalMs: cfg.intervalMs,
    backfillHours: cfg.backfillHours || 0,
    onCompleted: !!cfg.onCompleted,
    onFailed: !!cfg.onFailed,
    onAborted: !!cfg.onAborted,
    ignoreWorkspaces: cfg.ignoreWorkspaces || [],
    lastPollAt: stats.lastPollAt,
    pollCount: stats.pollCount,
    turnsSeen: stats.turnsSeen,
    turnsRecorded: stats.turnsRecorded,
    turnsNotified: stats.turnsNotified,
    turnsSuppressed: stats.turnsSuppressed,
    turnsTaskOwned: stats.turnsTaskOwned,
    turnsDedup: stats.turnsDedup,
    backfilled: stats.backfilled,
    totalDecodeMs: stats.decodeMs,
    lastError: stats.lastError
  };
}

/** 发一条模拟的对话结束通知，用于测试通道。 */
export function testSessionTurnNotification() {
  return sendNotification('session.turn.end', {
    workspace: '工作区（测试示例）',
    sessionId: 'session-test-00000000',
    title: '测试对话',
    turn: 1,
    reasonKind: 'completed',
    reasonDetail: '',
    prompt: '这是一条来自控制中心的测试推送'
  });
}
