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
      repeatMs: 1800000,
      onHigh: true,        // 判高温时推送
      onStillHigh: true,   // 持续高温时每 repeatMs 再提醒一次
      onRecovered: false,  // 判正常时推送（默认关：这类消息没有可行动信息，是最主要的刷屏源）
      windowSeconds: 60,   // 判定窗口时长（秒）；采样间隔 5s → 12 个采样点
      minSustained: 5      // 窗口内至少 N 次超阈值才判高温（5/12 ≈ 42%）
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
  notify: {
    enabled: false,
    channels: [],
    // 工作区对话（Web UI 会话）结束推送
    sessionTurns: {
      enabled: true,          // 监听 DSH 会话日志中的 turn/end
      sessionsRoot: '',       // 留空 = 自动定位 <USERPROFILE>/.dsh/sessions
      intervalMs: 3000,       // 轮询间隔
      backfillHours: 24,      // 启动时回填最近 N 小时的历史对话结束（0 = 不回填）
      onCompleted: true,      // 推送正常完成的对话
      onFailed: true,         // 推送出错 / 输出超长的对话
      onAborted: false,       // 是否推送用户手动停止的对话
      ignoreWorkspaces: [],   // 忽略这些工作区（路径包含匹配）
      maxPromptChars: 120     // 通知里附带用户指令摘要的最大长度
    }
  }
};

function load() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* use defaults */ }
  // 递归 deep-merge：用户配置里没写的键保留默认值。
  // 之前是一层 merge，导致 config.json 里写了一个子块（例如 monitor.tempAlert）时
  // 整个子块被替换、后加的新键（onHigh 等）全部丢成 false。
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function deepMerge(dst, src) {
    for (const [k, v] of Object.entries(src)) {
      if (isObj(v) && isObj(dst[k])) deepMerge(dst[k], v);
      else dst[k] = v;
    }
    return dst;
  }
  return deepMerge(structuredClone(defaults), user);
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