
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const PROC_CTRL_SCRIPT = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class ProcCtrl {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
}';
$p = Get-Process -Id {PID} -ErrorAction SilentlyContinue;
if (-not $p) { Write-Output 'NO_PROCESS'; exit 2; }
$h = $p.Handle;
$r = [ProcCtrl]::{FN}($h);
Write-Output ("RC=" + $r);
if ($r -ne 0) { exit 3; }
`;

async function runScript(pid, fnName) {
  const script = PROC_CTRL_SCRIPT.replace('{PID}', String(pid)).replace('{FN}', fnName);
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 15000, windowsHide: true });
  const rcMatch = /RC=(\d+)/.exec(stdout);
  return rcMatch ? Number(rcMatch[1]) : -1;
}

/** Suspend a process (Windows). Returns { ok, rc }. */
export async function suspend(pid) {
  try {
    const rc = await runScript(pid, 'NtSuspendProcess');
    return { ok: rc === 0, rc, pid };
  } catch (e) {
    return { ok: false, error: e.message, pid };
  }
}

/** Resume a suspended process (Windows). */
export async function resume(pid) {
  try {
    const rc = await runScript(pid, 'NtResumeProcess');
    return { ok: rc === 0, rc, pid };
  } catch (e) {
    return { ok: false, error: e.message, pid };
  }
}

/** Force-kill a process tree (Windows). */
export async function kill(pid) {
  try {
    await execFileP('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
    return { ok: true, pid };
  } catch (e) {
    return { ok: false, error: e.message, pid };
  }
}
