
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config, LOG_DIR } from '../config.js';
import { addLog, nowIso } from '../database/db.js';

const execFileP = promisify(execFile);

/** 本地实时时间戳 (YYYY-MM-DD HH:mm:ss)，写入 dsh.log 时与 DSH 自身输出对齐（避免 UTC 差 8 小时） */
function localTs() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** TCP check: is something listening on the DSH web port? */
/** HTTP probe: does the DSH web server respond? (status < 500 counts as alive). */
export function httpProbe(port = config.dsh.port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get({
      host, port, path: '/', timeout: config.dsh.healthTimeoutMs,
      headers: { 'User-Agent': 'dsh-monitor/2.0' }
    }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null }); });
    req.on('error', () => resolve({ ok: false, status: null }));
  });
}

/** Read the recovery daemon's latest state snapshot (logs/monitor-state.json). */
export function readMonitorState() {
  try {
    const f = path.join(LOG_DIR, 'monitor-state.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error('[dshService] readMonitorState error:', e.message);
    return null;
  }
}

export function checkPort(port = config.dsh.port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host, timeout: config.dsh.healthTimeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

/** Parse the latest token/URL from the DSH log. */
export function parseTokenFromLog() {
  try {
    const text = fs.readFileSync(config.dsh.logFile, 'utf8');
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      const m = /http:\/\/[\w.:]+:?\d*\/\?token=([\w-]+)/.exec(line);
      if (m) return { token: m[1], url: m[0] };
    }
  } catch { /* ignore */ }
  return null;
}

/** Parse a Win32_Process CreationDate ("\/Date(millis)\/" or ISO). */
function parseCimDate(v) {
  if (!v) return null;
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(v);
  if (m) {
    const d = new Date(Number(m[1]));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Find DSH node processes by command line match. */
export async function findDshProcesses() {
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dsh' } | Select-Object ProcessId, CreationDate, CommandLine | ConvertTo-Json -Compress`
    ], { timeout: 8000, windowsHide: true });
    if (!stdout.trim() || stdout.trim() === 'null') return [];
    const parsed = JSON.parse(stdout.trim());
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(p => ({
      pid: Number(p.ProcessId),
      startedAt: parseCimDate(p.CreationDate),
      cmdline: p.CommandLine || ''
    }));
  } catch (e) {
    console.error('[dshService] findDshProcesses error:', e.message);
    return [];
  }
}

export function isDshProcess(p) {
  return /dsh/i.test(p.cmdline) && /(web|headless|sdk|acp)/i.test(p.cmdline);
}

/** Derive a status classification ('running'|'starting'|'abnormal'|'stopped'). */
export function classifyState(portUp, httpOk, procs) {
  const main = procs.some(p => /bin\.js/.test(p.cmdline)) ? procs[0] : procs[0] || null;
  if (portUp && httpOk && procs.length > 0) return 'running';
  if (procs.length > 0 && !portUp) return 'starting';            // process booting, port not ready
  if (portUp && !httpOk) return 'abnormal';                      // port open but HTTP dead
  if (procs.length > 0 && portUp && !httpOk) return 'abnormal';
  return 'stopped';                                              // nothing alive
}

/** Full DSH status object. */
export async function getStatus() {
  const portUp = await checkPort();
  const procs = (await findDshProcesses()).filter(isDshProcess);
  const http = portUp ? await httpProbe() : { ok: false, status: null };
  const logToken = parseTokenFromLog();

  // determine main dsh process (the one whose cmdline has bin.js and 'web')
  const main = procs.find(p => /bin\.js/.test(p.cmdline) && /web/i.test(p.cmdline))
    || procs.find(p => /bin\.js/.test(p.cmdline))
    || procs[0] || null;

  // derive token from main process cmdline if possible
  let token = logToken?.token || null;
  if (main && !token) {
    const m = /token=([\w-]+)/.exec(main.cmdline);
    if (m) token = m[1];
  }

  const state = classifyState(portUp, http.ok, procs);
  const running = state === 'running';
  const monitor = readMonitorState();
  const effectiveState = resolveEffectiveState(state, monitor);
  return {
    running,
    state: effectiveState,
    monitorState: monitor ? monitor.state : null,
    monitor: monitor,
    port: config.dsh.port,
    portUp,
    httpOk: http.ok,
    httpStatus: http.status,
    pid: main ? main.pid : null,
    startedAt: main ? main.startedAt : null,
    uptimeSec: main && main.startedAt ? Math.max(0, (Date.now() - new Date(main.startedAt).getTime()) / 1000) : null,
    processes: procs.map(p => ({ pid: p.pid, startedAt: p.startedAt })),
    token,
    webUrl: token ? `http://127.0.0.1:${config.dsh.port}/?token=${token}` : `http://127.0.0.1:${config.dsh.port}`,
    publicUrl: config.dsh.publicUrl || null,
    publicWebUrl: (config.dsh.publicUrl && token) ? `${config.dsh.publicUrl}/?token=${token}` : null,
    proxyHost: config.dsh.proxyHost || null,
    proxyUrl: config.dsh.proxyHost ? `https://${config.dsh.proxyHost}` : null,
    lastLogTokenAt: logToken ? logToken.url : null,
    logFile: config.dsh.logFile
  };
}

/** Merge the monitor daemon's knowledge into the state for the panel. */
function resolveEffectiveState(own, monitor) {
  if (!monitor || !monitor.state) return own;
  if (monitor.state === 'HALTED') return 'halted';       // auto-recovery stopped
  if (monitor.state === 'RECOVERING') return 'recovering';
  if (monitor.state === 'ABNORMAL') return 'abnormal';
  if (monitor.state === 'DEGRADED' && own === 'running') return 'degraded';
  return own;
}

async function killProcesses(pids) {
  for (const pid of pids) {
    try {
      await execFileP('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
      addLog('warn', 'dsh', `killed DSH process PID ${pid}`);
    } catch (e) {
      addLog('warn', 'dsh', `failed to kill PID ${pid}: ${e.message}`);
    }
  }
}

/** 构建 DSH 子进程环境：服务以 LocalSystem 运行时必须显式注入用户主目录，
 *  否则 DSH 会到 systemprofile 找 .dsh（会话/历史"消失"）且 npx 重新下载。 */
export function buildSpawnEnv() {
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

/** Resolve the executable used to start DSH (npx.cmd absolute path). */
function resolveNpx() {
  const candidates = [
    process.env.npx_cmd || process.env.npm_config_npx,
    'E:\\app\\node.js\\npx.cmd',
    'npx.cmd'
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'npx.cmd';
}

/** Restart DSH: kill processes, wait for port free, relaunch, wait for port up. */
export async function restart() {
  addLog('info', 'dsh', 'restart requested');
  const before = await findDshProcesses();
  await killProcesses(before.map(p => p.pid));

  // wait for port to free (max 15s)
  for (let i = 0; i < 30; i++) {
    const up = await checkPort();
    if (!up) break;
    await new Promise(r => setTimeout(r, 500));
  }

  try { fs.appendFileSync(config.dsh.logFile, `\n[${localTs()}] control-center restart DSH\n`); } catch { /* ignore */ }

  // 关键: cmd 自身文件重定向捕获 DSH 输出（Node stdio 流在服务环境下丢 token）
  const redirectCmd = `${config.dsh.startCommand} >> "${config.dsh.logFile}" 2>&1`;
  const child = spawn('cmd.exe', ['/d', '/c', redirectCmd], {
    cwd: config.dsh.startCwd,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: buildSpawnEnv()
  });
  child.unref();
  addLog('info', 'dsh', `DSH relaunching (pid ${child.pid}) via: ${config.dsh.startCommand}`);

  // wait for port up (max 60s)
  for (let i = 0; i < 360; i++) {
    if (await checkPort()) {
      const status = await getStatus();
      addLog('info', 'dsh', `DSH restarted successfully, pid=${status.pid}, url=${status.webUrl}`);
      return { ok: true, status };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  addLog('error', 'dsh', 'DSH did not come back up within 60s after restart');
  return { ok: false, status: await getStatus() };
}

/** Start DSH if not already running. */
export async function start() {
  const status = await getStatus();
  if (status.state === 'running' || status.state === 'starting') {
    addLog('info', 'dsh', 'start requested but DSH already active (' + status.state + ')');
    return { ok: true, alreadyRunning: true, status };
  }
  addLog('info', 'dsh', 'start requested');
  try { fs.appendFileSync(config.dsh.logFile, '\n[' + localTs() + '] control-center start DSH\n'); } catch { /* ignore */ }
  // 关键: cmd 自身文件重定向捕获 DSH 输出
  const redirectCmd = config.dsh.startCommand + ' >> "' + config.dsh.logFile + '" 2>&1';
  const child = spawn('cmd.exe', ['/d', '/c', redirectCmd], {
    cwd: config.dsh.startCwd, detached: true, windowsHide: true,
    stdio: 'ignore', env: buildSpawnEnv()
  });
  child.unref();
  addLog('info', 'dsh', 'DSH launching (pid ' + child.pid + ') via: ' + config.dsh.startCommand);
  for (let i = 0; i < 120; i++) {
    if (await checkPort()) {
      const st = await getStatus();
      addLog('info', 'dsh', 'DSH started successfully, pid=' + st.pid + ', url=' + st.webUrl);
      return { ok: true, status: st };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  addLog('error', 'dsh', 'DSH did not come up within 180s after start');
  return { ok: false, status: await getStatus() };
}

/** Stop DSH: kill all dsh processes and wait for the port to free. */
export async function stop() {
  addLog('info', 'dsh', 'stop requested');
  const procs = await findDshProcesses();
  await killProcesses(procs.map(p => p.pid));
  for (let i = 0; i < 30; i++) {
    if (!(await checkPort())) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const st = await getStatus();
  addLog('info', 'dsh', 'DSH stopped (pid=' + (st.pid || 'none') + ', portUp=' + st.portUp + ')');
  return { ok: true, status: st };
}

/** Suspend or resume the DSH process via ntdll (Windows). */
export async function control(action) {
  const procs = (await findDshProcesses()).filter(isDshProcess);
  if (!procs.length) return { ok: false, error: 'DSH process not found' };
  const pid = procs[0].pid;
  const fn = action === 'pause' ? 'NtSuspendProcess' : 'NtResumeProcess';
  const script = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class ProcCtrl {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
}';
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;
if (-not $p) { Write-Output 'NO_PROCESS'; exit 2; }
$r = [ProcCtrl]::${fn}($p.Handle);
Write-Output ("RC=" + $r);
if ($r -ne 0) { exit 3; }
`;
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 15000, windowsHide: true });
    const rcMatch = /RC=(\d+)/.exec(stdout);
    const rc = rcMatch ? Number(rcMatch[1]) : -1;
    addLog('info', 'dsh', `DSH ${action} pid ${pid} rc=${rc}`);
    return { ok: rc === 0, rc, pid, action };
  } catch (e) {
    addLog('error', 'dsh', `DSH ${action} failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
