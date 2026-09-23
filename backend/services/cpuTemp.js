import { config } from '../config.js';

/**
 * CPU 温度读取（LibreHardwareMonitor 本地 HTTP 接口）。
 *
 * 前置条件：LHM 常驻运行并开启 Remote Web Server（默认 127.0.0.1:8085）。
 * 安装脚本：scripts/enable-temp-monitor.bat（提权运行一次即可，含开机自启计划任务）。
 *
 * 设计原则：**任何失败都返回 null，绝不抛异常**，以免拖垮 5 秒一次的系统采样循环。
 */

// 当 HardwareId 缺失时（某些 LHM 版本/配置下常见），改用传感器名称启发式识别 CPU。
const PREFERRED_RE = /(package|tdie|tctl|tccd|core average|core max|ccd)/i;
const CPU_SENSOR_RE = /^(core #|core max|core average|cpu package|p-core|e-core|cpu #|proximity)/i;
const NON_CPU_RE = /gpu|vram|memory|ram|dimm|motherboard|board|nic|wlan|nvme|ssd|battery|fan|pump|flow|voltage|current|power|clock|hdd|sdd/i;

let inflight = null;

/** 递归收集整棵传感器树中的全部温度读数。 */
function collectCpuTemps(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.Type === 'Temperature') {
    const raw = String(node.RawValue ?? node.Value ?? '').replace(',', '.');
    const value = parseFloat(raw);
    if (Number.isFinite(value) && value > 0) {
      out.push({ name: typeof node.Text === 'string' ? node.Text : '', value });
    }
  }
  for (const c of node.Children || []) collectCpuTemps(c, out);
}

function isCpuSensor(name) {
  if (!name) return false;
  if (NON_CPU_RE.test(name)) return false;
  return CPU_SENSOR_RE.test(name) || PREFERRED_RE.test(name);
}

/** 从候选传感器中选出最能代表 CPU 整体温度的读数。 */
function chooseCpuTemp(list) {
  if (!list.length) return null;
  const cpuList = list.filter(s => isCpuSensor(s.name));
  const pool = cpuList.length ? cpuList : list;
  const preferred = pool.find(s => PREFERRED_RE.test(s.name));
  if (preferred) return preferred;
  // 只有核心温度时取最高值：告警场景下取最大更安全
  return pool.reduce((a, b) => (b.value > a.value ? b : a));
}

async function doRead() {
  const url = config.lhm?.url || 'http://127.0.0.1:8085/data.json';
  const timeout = config.lhm?.timeoutMs || 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const tree = await resp.json();
    const candidates = [];
    collectCpuTemps(tree, candidates);
    const picked = chooseCpuTemp(candidates);
    if (!picked) return null;
    return {
      name: picked.name || 'CPU',
      value: Math.round(picked.value * 10) / 10,
      cores: candidates.length
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取 CPU 温度。同一时刻的并发调用会复用同一个请求。
 * @returns {Promise<{name: string, value: number, cores: number}|null>}
 */
export async function readCpuTemp() {
  if (inflight) return inflight;
  inflight = doRead().finally(() => { inflight = null; });
  return inflight;
}

/** 探测 LHM 接口是否可用（供诊断/健康检查使用）。 */
export async function probeLhm() {
  const t = await readCpuTemp();
  return { reachable: t !== null, cpuTemp: t };
}