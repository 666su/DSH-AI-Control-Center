import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'config.json');

const defaults = {
  server: { port: 3081, host: '0.0.0.0', token: '', cookieDomain: '', publicUrl: '' },
  dsh: {
    webUrl: 'http://127.0.0.1:3080',
    port: 3080,
    logFile: path.join(ROOT, 'dsh.log'),
    publicUrl: '',
    proxyHost: '',
    userProfile: '',
    startCommand: 'npx --yes @deepseek-ai/dsh web --no-open',
    startCwd: ROOT,
    healthTimeoutMs: 2000
  },
  monitor: {
    intervalMs: 5000,
    historyRetentionHours: 48,
    tempAlert: {
      enabled: true,
      gpuC: 80,
      cpuC: 90,
      hysteresisC: 3,
      repeatMs: 1800000
    }
  },
  lhm: { url: 'http://127.0.0.1:8085/data.json', timeoutMs: 1500 },
  recovery: {
    intervalMs: 30000,
    autoRestart: true,
    failThreshold: 3,
    bootGraceMs: 90000,
    processYoungMs: 30000,
    launchWaitMs: 60000,
    cooldownsMs: [30000, 60000, 120000],
    maxAttempts: 3
  },
  tasks: { defaultWorkspace: ROOT },
  notify: { enabled: false, channels: [] }
};

function load() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* use defaults */ }
  // deep-merge
  const merged = structuredClone(defaults);
  for (const [k, v] of Object.entries(user)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') {
      merged[k] = { ...merged[k], ...v };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

export const config = load();
export const ROOT_DIR = ROOT;
export const LOG_DIR = path.join(ROOT, 'logs');
export const TASK_LOG_DIR = path.join(LOG_DIR, 'tasks');
export const DATA_DIR = path.join(ROOT, 'backend', 'data');
export const DB_FILE = path.join(DATA_DIR, 'control-center.db');
export { CONFIG_FILE };

// ensure dirs
for (const d of [LOG_DIR, TASK_LOG_DIR, DATA_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}