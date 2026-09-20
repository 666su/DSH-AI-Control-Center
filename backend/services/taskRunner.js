import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, ROOT_DIR, TASK_LOG_DIR } from '../config.js';
import { db, nowIso, nextTaskId, addLog } from '../database/db.js';
import { suspend, resume, kill } from './processControl.js';
import { sendNotification, classifyDshError } from './notifyService.js';
import { readDshCredentials } from './credentials.js';

const execFileP = promisify(execFile);
const tasks = new Map(); // id -> { pid, buffer, lastRead }

/** Resolve the absolute path to the dsh bin.js (for headless jobs). */
export function resolveDshBin() {
  if (process.env.DSH_BIN_PATH && fs.existsSync(process.env.DSH_BIN_PATH)) return process.env.DSH_BIN_PATH;
  const cacheBase = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  let best = null, bestTime = 0;
  try {
    for (const dir of fs.readdirSync(cacheBase)) {
      const cand = path.join(cacheBase, dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(cand)) {
        const t = fs.statSync(cand).mtimeMs;
        if (t > bestTime) { bestTime = t; best = cand; }
      }
    }
  } catch { /* ignore */ }
  return best;
}

const DSH_BIN = resolveDshBin();

function taskRow(row) {
  if (!row) return null;
  return { ...row };
}

export function listTasks({ status, limit = 100, includeAll = true } = {}) {
  let sql = 'SELECT * FROM tasks';
  const params = [];
  if (status) {
    if (Array.isArray(status)) {
      sql += ' WHERE status IN (' + status.map(() => '?').join(',') + ')';
      params.push(...status);
    } else {
      sql += ' WHERE status = ?';
      params.push(status);
    }
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 100, 500));
  return db.prepare(sql).all(...params).map(taskRow);
}

export function getTask(id) {
  return taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

function setTaskStatus(id, status, extra = {}) {
  const sets = ['status = ?'];
  const params = [status];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(k + ' = ?');
    params.push(v);
  }
  params.push(id);
  db.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);
  addLog('info', 'task', 'task ' + id + ' status -> ' + status + (extra.result ? ' (completed)' : ''));
}

/** Create and start a headless DSH task. */
export async function createTask({ name, instruction, workspace, model, provider }) {
  if (!instruction || !instruction.trim()) {
    return { ok: false, error: 'instruction is required' };
  }
  const id = nextTaskId();
  const safeName = (name || instruction.slice(0, 40)).trim();
  const cwd = workspace || config.tasks.defaultWorkspace || ROOT_DIR;
  const logFile = path.join(TASK_LOG_DIR, id + '.log');
  fs.mkdirSync(TASK_LOG_DIR, { recursive: true });
  fs.writeFileSync(logFile, '', 'utf8');

  const rec = {
    id, name: safeName, instruction, status: 'queued', workspace: cwd,
    created_at: nowIso(), log_file: logFile,
    model: model || '', provider: provider || ''
  };
  db.prepare('INSERT INTO tasks (id, name, instruction, status, workspace, created_at, log_file, model, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(rec.id, rec.name, rec.instruction, rec.status, rec.workspace, rec.created_at, rec.log_file, rec.model, rec.provider);

  addLog('info', 'task', 'task ' + id + ' created: ' + safeName + (rec.model ? ' [model: ' + rec.provider + '/' + rec.model + ']' : ''));
  startProcess(rec);
  return { ok: true, task: getTask(id) };
}

function startProcess(rec) {
  const logStream = fs.createWriteStream(rec.log_file, { flags: 'a' });
  const buffer = [];
  const cmd = DSH_BIN;

  // 如果指定了模型，创建临时 patch 文件覆盖 agent-default-model
  let patchFile = null;
  let patchArgs = [];
  if (rec.model && rec.provider) {
    patchFile = path.join(TASK_LOG_DIR, rec.id + '.patch.yaml');
    const patchContent = '- id: agent-default-model\n  config:\n    provider: ' + rec.provider + '\n    model: ' + rec.model + '\n';
    fs.writeFileSync(patchFile, patchContent, 'utf8');
    patchArgs = ['--patch', patchFile];
  }

  function cleanupPatch() {
    if (patchFile) {
      try { fs.unlinkSync(patchFile); } catch { /* ignore */ }
      patchFile = null;
    }
  }

  let child;
  const runOpts = {
    cwd: rec.workspace,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...readDshCredentials() }
  };

  if (cmd && fs.existsSync(cmd)) {
    child = spawn(process.execPath, [cmd, '--profile', 'headless', ...patchArgs, rec.instruction], runOpts);
  } else {
    const patchPart = patchArgs.length ? '--patch ' + JSON.stringify(patchArgs[1]) + ' ' : '';
    child = spawn('npx --yes @deepseek-ai/dsh --profile headless ' + patchPart + JSON.stringify(rec.instruction), [], {
      ...runOpts, shell: true
    });
  }

  const out = (data) => {
    const text = data.toString();
    buffer.push(text);
    if (buffer.length > 400) buffer.splice(0, buffer.length - 400);
    logStream.write(text);
  };
  child.stdout.on('data', out);
  child.stderr.on('data', out);

  setTaskStatus(rec.id, 'running', { started_at: nowIso(), pid: child.pid });
  tasks.set(rec.id, { pid: child.pid, buffer, stream: logStream });

  child.on('error', (err) => {
    setTaskStatus(rec.id, 'failed', { finished_at: nowIso(), result: 'spawn error: ' + err.message, exit_code: -1 });
    logStream.end();
    cleanupPatch();
    tasks.delete(rec.id);
    sendNotification('task.failed', { taskId: rec.id, name: rec.name, exitCode: -1, label: '启动失败', error: err.message }).catch(() => {});
  });

  child.on('close', (code, signal) => {
    const current = getTask(rec.id);
    if (current && current.status === 'cancelled') {
      setTimeout(() => { try { logStream.end(); } catch {} }, 100);
      cleanupPatch();
      tasks.delete(rec.id);
      return;
    }
    const finalStatus = code === 0 ? 'completed' : 'failed';
    const tail = buffer.join('').trim().slice(-4000);
    setTaskStatus(rec.id, finalStatus, { finished_at: nowIso(), result: tail || null, exit_code: code });
    addLog(finalStatus === 'completed' ? 'info' : 'warn', 'task', 'task ' + rec.id + ' ' + finalStatus + ' (exit ' + code + ')');
    if (finalStatus === 'completed') {
      sendNotification('task.completed', { taskId: rec.id, name: rec.name, exitCode: code }).catch(() => {});
    } else {
      const cls = classifyDshError(tail);
      sendNotification('task.failed', { taskId: rec.id, name: rec.name, exitCode: code, kind: cls.kind, label: cls.label, error: tail.slice(-600) }).catch(() => {});
    }
    setTimeout(() => { try { logStream.end(); } catch {} }, 100);
    cleanupPatch();
    tasks.delete(rec.id);
  });

  return child;
}

/** Pause/resume/cancel a running task. */
export async function controlTask(id, action) {
  const task = getTask(id);
  if (!task) return { ok: false, error: 'task not found' };
  if (!task.pid) return { ok: false, error: 'task has no process' };

  if (action === 'pause') {
    if (task.status !== 'running' && task.status !== 'queued') return { ok: false, error: 'task status is ' + task.status + ', cannot pause' };
    const r = await suspend(task.pid);
    if (r.ok) setTaskStatus(id, 'paused');
    return r.ok ? { ok: true, task: getTask(id) } : { ok: false, error: r.error || 'pause failed' };
  }
  if (action === 'resume') {
    if (task.status !== 'paused') return { ok: false, error: 'task status is ' + task.status + ', cannot resume' };
    const r = await resume(task.pid);
    if (r.ok) setTaskStatus(id, 'running');
    return r.ok ? { ok: true, task: getTask(id) } : { ok: false, error: r.error || 'resume failed' };
  }
  if (action === 'cancel') {
    const r = await kill(task.pid);
    if (r.ok) setTaskStatus(id, 'cancelled', { finished_at: nowIso(), result: 'cancelled by user', exit_code: -2 });
    return r.ok ? { ok: true, task: getTask(id) } : { ok: false, error: r.error || 'cancel failed' };
  }
  return { ok: false, error: 'unknown action: ' + action };
}

/** Read a task log (from file, with buffered tail when still running). */
export function readTaskLog(id, maxLen = 20000) {
  const task = getTask(id);
  if (!task || !task.log_file) return { text: '', truncated: false };
  try {
    const st = fs.statSync(task.log_file);
    const size = st.size;
    const start = Math.max(0, size - maxLen);
    const fd = fs.openSync(task.log_file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), truncated: start > 0 };
  } catch (e) {
    return { text: '', truncated: false, error: e.message };
  }
}
