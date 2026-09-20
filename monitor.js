/**
 * DSH Control Center — Recovery Daemon v2 (enterprise health check)
 *
 * 状态机: OK → STARTING → DEGRADED → ABNORMAL → RECOVERING → (cooldown) / HALTED
 *
 * 健康检测（每 intervalMs 一次，默认 30s），四项探测：
 *   1. 进程探测   — 存在匹配 dsh+web 的 node 进程
 *   2. 端口探测   — TCP 127.0.0.1:3080 可连接
 *   3. HTTP 探测  — GET http://127.0.0.1:3080/ 返回 <500 即存活（200/303/401 均算存活）
 *   4. 启动状态   — 进程存在但端口未就绪 = STARTING，绝不干预
 *
 * 恢复策略（防"暴力重启"）：
 *   - 连续 failThreshold 次（默认 3）失败才判定 ABNORMAL，一次失败不重启
 *   - STARTING 宽限：进程刚出现 / 本监控刚拉起（bootGraceMs=90s）期间绝不 kill
 *   - 指数冷却 cooldownsMs（30s/60s/120s）：冷却期内不重复恢复
 *   - 连续 maxAttempts 次（默认 3）恢复失败 → HALTED：停止自动恢复 + CRITICAL 告警
 *   - 检测到 DSH 恢复健康后自动重新武装（attempts=0）
 *
 * 输出：
 *   - logs/recovery.log      结构化事件日志
 *   - logs/monitor-state.json 实时状态快照（控制中心 /api/monitor/status 读取）
 *   - logs/notify.log        熔断告警（通知通道）
 *
 * 运行: node monitor.js | node monitor.js --once | NSSM (DSHControlMonitor)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileP = promisify(execFile);

// ---- minimal config load (independent of backend modules) ----
function loadConfig() {
  const defaults = {
    dsh: {
      port: 3080,
      logFile: path.join(__dirname, 'dsh.log'),
      startCommand: 'npx --yes @deepseek-ai/dsh web --no-open',
      startCwd: __dirname,
      healthTimeoutMs: 2000,
      userProfile: ''
    },
    recovery: {
      intervalMs: 30000,
      autoRestart: true,
      failThreshold: 3,                 // 连续失败 N 次才判定异常
      bootGraceMs: 90000,               // 本监控拉起后的启动宽限
      processYoungMs: 30000,            // 比这年轻的 dsh 进程视为其他启动器刚拉起，不 kill
      launchWaitMs: 60000,              // 拉起后等待端口上限
      cooldownsMs: [30000, 60000, 120000], // 第1/2/3+次恢复尝试前的冷却
      maxAttempts: 3                    // 连续恢复尝试上限 → 熔断
    }
  };
  try {
    const user = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'config.json'), 'utf8'));
    return {
      dsh: { ...defaults.dsh, ...(user.dsh || {}) },
      recovery: { ...defaults.recovery, ...(user.recovery || {}) }
    };
  } catch { return defaults; }
}

const config = loadConfig();
const RECOVERY_LOG = path.join(__dirname, 'logs', 'recovery.log');
const STATE_FILE = path.join(__dirname, 'logs', 'monitor-state.json');
const NOTIFY_LOG = path.join(__dirname, 'logs', 'notify.log');

const pad = (n) => String(n).padStart(2, '0');
function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtMs(ms) { return Math.round(ms / 1000) + 's'; }

function log(msg, level = 'INFO') {
  const entry = `[${ts()}] [${level}] ${msg}`;
  try { fs.appendFileSync(RECOVERY_LOG, entry + '\n', 'utf8'); } catch { /* ignore */ }
  console.log(entry);
}

function notify(level, message) {
  try { fs.appendFileSync(NOTIFY_LOG, `[${ts()}] [${level}] ${message}\n`, 'utf8'); } catch { /* ignore */ }
}

// ---- runtime state ----
const state = {
  state: 'OK', checkedAt: null, portUp: false, httpOk: false, httpStatus: null,
  pids: [], failStreak: 0, attempts: 0, lastError: null,
  autoRestart: config.recovery.autoRestart, nextAttemptAt: null, lastAction: 'None', halted: false
};
function writeState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, checkedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

// ---- probes ----
function checkPort(port = config.dsh.port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1', timeout: config.dsh.healthTimeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

function httpProbe() {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port: config.dsh.port, path: '/',
      timeout: config.dsh.healthTimeoutMs,
      headers: { 'User-Agent': 'dsh-monitor/2.0' }
    }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null }); });
    req.on('error', () => resolve({ ok: false, status: null }));
  });
}

function parseCimDate(v) {
  if (!v) return null;
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(v);
  if (m) { const d = new Date(Number(m[1])); return isNaN(d.getTime()) ? null : d.getTime(); }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}

async function findDshProcesses() {
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dsh' } | Select-Object ProcessId, CreationDate, CommandLine | ConvertTo-Json -Compress`
    ], { timeout: 8000, windowsHide: true });
    if (!stdout.trim() || stdout.trim() === 'null') return [];
    const parsed = JSON.parse(stdout.trim());
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(p => /dsh/i.test(p.CommandLine || '') && /(web|headless|sdk|acp)/i.test(p.CommandLine || ''))
      .map(p => ({ pid: Number(p.ProcessId), startedAtMs: parseCimDate(p.CreationDate) || 0, cmdline: p.CommandLine || '' }));
  } catch { return []; }
}

let launchUntil = 0;       // 本监控拉起后的宽限截止（ms epoch）
let inCooldownUntil = 0;   // 冷却截止

async function cycle() {
  const portUp = await checkPort();
  const procs = await findDshProcesses();
  const http = await httpProbe();
  const now = Date.now();

  const youngest = procs.length ? Math.max(...procs.map(p => p.startedAtMs)) : 0;
  const justSpawned = procs.length > 0 && (now - youngest) < config.recovery.processYoungMs;
  const healthy = portUp && http.ok && procs.length > 0;

  state.portUp = portUp; state.httpOk = http.ok; state.httpStatus = http.status;
  state.pids = procs.map(p => p.pid);
  state.nextAttemptAt = (inCooldownUntil > now) ? new Date(inCooldownUntil).toISOString() : null;

  // 1) HEALTHY
  if (healthy) {
    const wasProblem = state.failStreak > 0 || state.attempts > 0;
    state.state = 'OK'; state.failStreak = 0; state.attempts = 0; state.halted = false;
    state.lastError = null; state.lastAction = 'None'; launchUntil = 0; inCooldownUntil = 0;
    log(`DSH Status: OK | Process: Running PID:${procs.map(p => p.pid).join(',')} | Port: ${config.dsh.port} OK | HTTP: ${http.status} | Action: ${wasProblem ? 'auto-recovery re-armed' : 'None'}`, wasProblem ? 'RECOVERED' : 'INFO');
    writeState();
    return;
  }

  // 2) STARTING — process exists but port not ready; boot grace, never intervene
  if (procs.length > 0 && !portUp && (now < launchUntil || justSpawned)) {
    const graceLeft = Math.max(launchUntil - now, config.recovery.processYoungMs - (now - youngest));
    state.state = 'STARTING';
    state.lastAction = 'Wait';
    state.lastError = `Process present (pid ${procs.map(p => p.pid).join(',')}) but port ${config.dsh.port} not yet listening — booting`;
    log(`DSH Status: STARTING | Process: ${procs.map(p => p.pid).join(',')} | Port: ${config.dsh.port} NOT YET | HTTP: - | Action: wait (grace ~${fmtMs(Math.max(0, graceLeft))})`);
    writeState();
    return;
  }

  // 3) DEGRADED — accumulate consecutive failures
  state.failStreak++;
  const reason = !portUp ? `Port ${config.dsh.port} unavailable` : (procs.length === 0 ? 'no dsh process' : `HTTP not responding (${http.status})`);
  if (state.failStreak < config.recovery.failThreshold) {
    state.state = 'DEGRADED';
    state.lastAction = 'Watch';
    state.lastError = reason;
    log(`DSH Check Failed | Reason: ${reason} | Retry: ${state.failStreak}/${config.recovery.failThreshold}`, 'ALERT');
    writeState();
    return;
  }

  // 4) ABNORMAL — confirmed down
  state.state = 'ABNORMAL';
  state.lastError = reason;
  log(`DSH Status: ABNORMAL | Reason: ${reason} | Consecutive failures: ${state.failStreak}`, 'ALERT');

  if (!config.recovery.autoRestart) {
    state.lastAction = 'Skip (autoRestart=false)';
    log('INFO: auto-restart disabled by config — no action taken', 'INFO');
    writeState();
    return;
  }

  // 5) HALTED — recovery attempts exhausted: stop + notify (never loop forever)
  if (state.attempts >= config.recovery.maxAttempts) {
    state.state = 'HALTED'; state.halted = true;
    state.lastAction = 'Halt';
    state.lastError = `auto-recovery halted after ${state.attempts} consecutive failed attempts (reason: ${reason})`;
    log(`DSH Status: HALTED | Auto-recovery stopped after ${state.attempts} attempts | Reason: ${reason} | Please start DSH manually or fix the root cause`, 'CRITICAL');
    notify('CRITICAL', `DSH 自动恢复已熔断：连续 ${state.attempts} 次恢复失败。原因: ${reason}。请人工介入检查。`);
    writeState();
    return;
  }

  // 6) COOLDOWN — escalate wait between attempts
  if (now < inCooldownUntil) {
    state.state = 'RECOVERING';
    state.lastAction = 'Cooldown';
    log(`DSH Status: RECOVERING | Cooling down — next attempt in ${fmtMs(inCooldownUntil - now)} (attempt ${state.attempts + 1}/${config.recovery.maxAttempts})`);
    writeState();
    return;
  }

  // 7) RECOVERING — perform restart
  state.state = 'RECOVERING';
  state.attempts++;
  const attempt = state.attempts;
  const cdIdx = Math.min(attempt - 1, config.recovery.cooldownsMs.length - 1);
  state.lastAction = 'Restart';
  state.lastError = null;
  log(`ACTION: Restart DSH (attempt ${attempt}/${config.recovery.maxAttempts}) | Reason: ${reason}`);

  // kill only STALE leftovers — never touch young processes (other launcher may own them)
  const stale = procs.filter(p => p.startedAtMs && (now - p.startedAtMs) > config.recovery.processYoungMs);
  for (const p of stale) {
    try {
      await execFileP('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
      log(`KILLED stale DSH pid ${p.pid}`);
    } catch { /* already gone */ }
  }
  await new Promise(r => setTimeout(r, 1000));

  try { fs.appendFileSync(config.dsh.logFile, `\n[${ts()}] monitor.js recovery restart (attempt ${attempt})\n`); } catch { /* ignore */ }
  // 关键: 用 cmd 自身的文件重定向捕获 DSH 输出（Node stdio 流在服务环境下会丢 token 输出）
  const redirectCmd = `${config.dsh.startCommand} >> "${config.dsh.logFile}" 2>&1`;
  const child = spawn('cmd.exe', ['/d', '/c', redirectCmd], {
    cwd: config.dsh.startCwd, detached: true, windowsHide: true,
    stdio: 'ignore', env: buildSpawnEnv()
  });
  child.unref();
  launchUntil = Date.now() + config.recovery.bootGraceMs;
  log(`LAUNCHED: '${config.dsh.startCommand}' (wrapper pid ${child.pid}) | boot grace ${fmtMs(config.recovery.bootGraceMs)}`);

  // wait for port up (bounded)
  const waitStart = Date.now();
  let up = false;
  while (Date.now() - waitStart < config.recovery.launchWaitMs) {
    await new Promise(r => setTimeout(r, 1000));
    if (await checkPort()) { up = true; break; }
  }
  inCooldownUntil = Date.now() + config.recovery.cooldownsMs[cdIdx];
  log(up
    ? `OK: DSH is up after restart (attempt ${attempt}) | next cooldown ${fmtMs(config.recovery.cooldownsMs[cdIdx])}`
    : `FAIL: DSH did not recover within ${fmtMs(config.recovery.launchWaitMs)} (attempt ${attempt}/${config.recovery.maxAttempts}) — cooling ${fmtMs(config.recovery.cooldownsMs[cdIdx])}`,
    up ? 'INFO' : 'WARN');
  writeState();
}


function buildSpawnEnv() {
  const userHome = config.dsh.userProfile || process.env.USERPROFILE || '';
  const env = { ...process.env };
  if (userHome) {
    env.USERPROFILE = userHome;
    env.HOMEDRIVE = userHome.slice(0, 2);
    env.HOMEPATH = userHome.slice(2);
    env.HOME = userHome;
    env.npm_config_cache = path.join(userHome, 'AppData', 'Local', 'npm-cache');
    env.LOCALAPPDATA = path.join(userHome, 'AppData', 'Local');
    env.APPDATA = path.join(userHome, 'AppData', 'Roaming');
  }
  return env;
}

async function main() {
  log(`monitor.js v2 started | interval ${config.recovery.intervalMs}ms | failThreshold ${config.recovery.failThreshold} | maxAttempts ${config.recovery.maxAttempts} | autoRestart=${config.recovery.autoRestart}`);
  if (process.argv.includes('--once')) {
    await cycle();
    console.log('--once done. monitor state =', state.state);
    process.exit(0);
  }
  await cycle();
  setInterval(() => { cycle().catch(e => log('ERROR in cycle: ' + e.message, 'ERROR')); }, config.recovery.intervalMs);
}

main().catch(e => { log('FATAL: ' + e.message, 'ERROR'); process.exit(1); });
