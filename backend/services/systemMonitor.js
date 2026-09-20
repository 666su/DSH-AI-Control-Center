
import si from 'systeminformation';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, nowIso } from '../database/db.js';
import { config } from '../config.js';

const execFileP = promisify(execFile);
let lastSnapshot = null;

/** Query GPU via nvidia-smi (fast, reliable). Returns null when absent. */
async function queryGpu() {
  try {
    const { stdout } = await execFileP('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name',
      '--format=csv,noheader,nounits'
    ], { timeout: 4000, windowsHide: true });
    const parts = stdout.trim().split(/,\s*/);
    if (parts.length < 4) return null;
    return {
      name: parts.slice(4).join(',').trim() || 'NVIDIA GPU',
      util: Math.min(100, Math.max(0, parseFloat(parts[0]))),
      memUsedMb: parseFloat(parts[1]),
      memTotalMb: parseFloat(parts[2]),
      tempC: parseFloat(parts[3])
    };
  } catch {
    return null;
  }
}

/** Take one full snapshot: cpu/gpu/mem/disk. */
export async function snapshot() {
  const [cpu, mem, fsSize] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.mem().catch(() => null),
    si.fsSize().catch(() => null)
  ]);
  const gpu = await queryGpu();

  // pick system drive for disk info
  let disk = null;
  if (Array.isArray(fsSize) && fsSize.length) {
    const drive = process.platform === 'win32'
      ? (fsSize.find(d => d.mount === 'C:') || fsSize[0])
      : fsSize[0];
    disk = {
      used: drive.used ?? 0,
      size: drive.size ?? 0,
      free: (drive.size ?? 0) - (drive.used ?? 0),
      mount: drive.mount ?? ''
    };
  }

  lastSnapshot = {
    ts: nowIso(),
    cpu: {
      load: cpu ? Math.round(cpu.currentLoad * 10) / 10 : null,
      cores: cpu && cpu.cpus ? cpu.cpus.length : null
    },
    gpu,
    mem: mem ? {
      usedGb: +(mem.used / 1024 ** 3).toFixed(2),
      totalGb: +(mem.total / 1024 ** 3).toFixed(2),
      usedPercent: mem.total ? Math.round((mem.used / mem.total) * 100) : null
    } : null,
    disk,
    diskFreeGb: disk ? +(disk.free / 1024 ** 3).toFixed(2) : null,
    diskTotalGb: disk ? +(disk.size / 1024 ** 3).toFixed(2) : null
  };
  return lastSnapshot;
}

/** Persist snapshot to history table. */
export function persistSnapshot(snap) {
  const stmt = db.prepare(`INSERT INTO system_stats
    (ts, cpu, gpu_util, gpu_mem_used, gpu_mem_total, mem_used, mem_total, disk_free, disk_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  stmt.run(
    snap.ts,
    snap.cpu?.load ?? null,
    snap.gpu?.util ?? null,
    snap.gpu ? Math.round(snap.gpu.memUsedMb) : null,
    snap.gpu ? Math.round(snap.gpu.memTotalMb) : null,
    snap.mem ? Math.round(snap.mem.usedGb * 1024) : null,
    snap.mem ? Math.round(snap.mem.totalGb * 1024) : null,
    snap.disk ? Math.round(snap.disk.free / 1024 ** 2) : null,   // MB
    snap.disk ? Math.round(snap.disk.size / 1024 ** 2) : null    // MB
  );
}

/** Prune history older than retention. */
export function pruneHistory() {
  const cutoff = new Date(Date.now() - config.monitor.historyRetentionHours * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM system_stats WHERE ts < ?').run(cutoff);
}

export function getLastSnapshot() {
  return lastSnapshot;
}

export function getHistory(hours = 6, limit = 2000) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return db.prepare(`SELECT ts, cpu, gpu_util, gpu_mem_used, mem_used, mem_total, disk_free, disk_total
    FROM system_stats WHERE ts >= ? ORDER BY id ASC LIMIT ?`).all(cutoff, limit);
}

/** Start the sampling loop. */
export function startMonitor() {
  const tick = async () => {
    try {
      const snap = await snapshot();
      persistSnapshot(snap);
      pruneHistory();
    } catch (e) {
      console.error('[monitor] snapshot error:', e.message);
    }
  };
  tick();
  const t = setInterval(tick, config.monitor.intervalMs);
  t.unref?.();
  return t;
}
