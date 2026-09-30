import { addLog } from '../database/db.js';
import { getTempAlertConfig, sendNotification } from './notifyService.js';

/**
 * 温度告警状态机（滚动窗口防抖版）。
 *
 * 为什么不用「连续 N 次」：
 *   负载型 CPU 的温度是**振荡**的，实测序列 87,91,73,91,86,94,91,67,92,71,91,64,99,63,100
 *   （每 5 秒一次）。这种波形下「连续 2 次 ≥90」几乎不成立、「连续 2 次 ≤87」也不成立，
 *   结果要么是告警永不触发，要么是一旦进入高温就永远回不到正常（badge 卡在 🔥）。
 *
 * 改用**滚动窗口 + 计数占比**（业界常见做法，类似 5 分钟移动平均）：
 *   进入高温：最近 windowSamples 次采样里，有 >= minSustained 次 ≥ 阈值
 *   降温恢复：最近 windowSamples 次采样里，有 >= windowSamples - minSustained + 1 次 ≤ 阈值 - 迟滞
 *
 * 窗口 60 秒、minSustained=5（≈12 次采样里的 5 次 = 42%）时：
 *   - 87,91,73,91,86,94,91,67,92,71,91,64,99,63,100 → 窗口内 ≥90 共 8 次 → 判高温（正确：确实反复烫）
 *   - 88,95,80,82（单次尖峰）        → 窗口内 ≥90 仅 1 次 → 不告警（正确：尖峰忽略）
 *   - 93,94,92,91,90,91,93,92（持续高温）→ 8 次全超 → 判高温（正确）
 *
 * 推送策略：
 *   进入高温：推 1 次（onHigh）
 *   持续高温：每 repeatMs 最多再提醒 1 次（onStillHigh）
 *   降温恢复：推 1 次（onRecovered，默认关 —— 这类消息没有可行动信息，是最主要的刷屏源）
 *
 * 状态保存在内存中：控制中心重启后重新武装（不会重复补推历史告警）。
 * 窗口长度或判定参数变化时自动重置状态，避免用旧口径继续判定。
 */

const DEFAULT_INTERVAL_MS = 5000;

const state = {
  gpu: { level: 'normal', samples: [], lastNotifyAt: 0, lastValue: null },
  cpu: { level: 'normal', samples: [], lastNotifyAt: 0, lastValue: null }
};

/** 配置指纹：判定参数变了就重置窗口，避免新旧口径混用。 */
function configFingerprint(cfg) {
  return [cfg.cpuC, cfg.gpuC, cfg.hysteresisC, cfg.minSustained, cfg.windowSeconds].join('|');
}
let currentFingerprint = null;

function pushSample(sensor, value, cfg) {
  const st = state[sensor.key];
  st.lastValue = value;
  st.samples.push(value);
  const windowSamples = cfg.windowSamples;
  while (st.samples.length > windowSamples) st.samples.shift();
  return st.samples;
}

function notify(event, sensor, phase, cfg) {
  addLog(
    event === 'temp.high' ? 'warn' : 'info',
    'temp',
    (event === 'temp.high' ? 'HIGH TEMP ' : 'TEMP RECOVERED ') +
      sensor.label + ' ' + sensor.value + 'C (threshold ' + sensor.threshold + 'C, ' + phase + ')'
  );
  // 异步推送，永不阻塞采样循环
  Promise.resolve(sendNotification(event, {
    sensor: sensor.key,
    label: sensor.label,
    value: sensor.value,
    threshold: sensor.threshold,
    phase,
    windowAbove: sensor.windowAbove,
    windowTotal: sensor.windowTotal,
    windowMax: sensor.windowMax,
    windowMin: sensor.windowMin
  })).catch(() => { /* 通知失败不影响监控 */ });
}

/**
 * 每轮采样后调用，判定是否需要推送温度告警。
 * @param {object} snap systemMonitor 产出的快照
 */
export function checkTemperatureAlerts(snap) {
  const cfg = getTempAlertConfig();
  if (cfg.enabled === false) return;

  const fp = configFingerprint(cfg);
  if (currentFingerprint !== null && fp !== currentFingerprint) {
    for (const k of Object.keys(state)) {
      state[k].level = 'normal';
      state[k].samples = [];
      state[k].lastNotifyAt = 0;
    }
  }
  currentFingerprint = fp;

  const now = Date.now();
  const recLineOffset = cfg.hysteresisC;
  const windowSamples = cfg.windowSamples;
  const hotNeed = cfg.minSustained;
  const coolNeed = Math.max(1, windowSamples - cfg.minSustained + 1);

  const sensors = [
    { key: 'gpu', label: 'GPU', value: snap?.temps?.gpuC ?? null, threshold: cfg.gpuC },
    { key: 'cpu', label: 'CPU', value: snap?.temps?.cpuC ?? null, threshold: cfg.cpuC }
  ];

  for (const sensor of sensors) {
    if (sensor.value == null || !Number.isFinite(sensor.value)) continue; // 传感器掉线不动作
    const window = pushSample(sensor, sensor.value, cfg);
    const recLine = sensor.threshold - recLineOffset;
    const above = window.filter(v => v >= sensor.threshold).length;
    const below = window.filter(v => v <= recLine).length;
    const st = state[sensor.key];

    if (st.level === 'normal') {
      if (window.length >= windowSamples && above >= hotNeed) {
        st.level = 'high';
        st.lastNotifyAt = now;
        if (cfg.onHigh) notify('temp.high', { ...sensor, windowAbove: above, windowTotal: window.length, windowMax: Math.max(...window), windowMin: Math.min(...window) }, 'entered', cfg);
      }
    } else if (window.length >= windowSamples && below >= coolNeed) {
      st.level = 'normal';
      st.lastNotifyAt = 0;
      if (cfg.onRecovered) notify('temp.recovered', { ...sensor, windowAbove: above, windowTotal: window.length, windowMax: Math.max(...window), windowMin: Math.min(...window) }, 'recovered', cfg);
    } else if (cfg.onStillHigh && now - st.lastNotifyAt >= cfg.repeatMs) {
      st.lastNotifyAt = now;
      notify('temp.high', { ...sensor, windowAbove: above, windowTotal: window.length, windowMax: Math.max(...window), windowMin: Math.min(...window) }, 'still high', cfg);
    }
  }
}

/** 重置状态机（配置变化或面板手动操作时使用）。 */
export function resetTempAlertState() {
  currentFingerprint = null;
  for (const k of Object.keys(state)) {
    state[k].level = 'normal';
    state[k].samples = [];
    state[k].lastNotifyAt = 0;
  }
}

/** 供 API / 面板展示当前告警状态。 */
export function getTempAlertState() {
  const cfg = getTempAlertConfig();
  const mk = (k, threshold) => {
    const st = state[k];
    const recLine = threshold - cfg.hysteresisC;
    return {
      level: st.level,
      lastValue: st.lastValue,
      samples: st.samples.slice(),
      sampleCount: st.samples.length,
      windowAbove: st.samples.filter(v => v >= threshold).length,
      windowBelowRecover: st.samples.filter(v => v <= recLine).length,
      windowMax: st.samples.length ? Math.max(...st.samples) : null,
      windowMin: st.samples.length ? Math.min(...st.samples) : null,
      hotNeed: cfg.minSustained,
      coolNeed: Math.max(1, cfg.windowSamples - cfg.minSustained + 1),
      lastNotifyAt: st.lastNotifyAt || null
    };
  };
  return {
    enabled: cfg.enabled,
    thresholds: { gpuC: cfg.gpuC, cpuC: cfg.cpuC },
    hysteresisC: cfg.hysteresisC,
    repeatMs: cfg.repeatMs,
    minSustained: cfg.minSustained,
    windowSeconds: cfg.windowSeconds,
    windowSamples: cfg.windowSamples,
    intervalMs: cfg.intervalMs,
    onHigh: cfg.onHigh,
    onStillHigh: cfg.onStillHigh,
    onRecovered: cfg.onRecovered,
    sensors: { gpu: mk('gpu', cfg.gpuC), cpu: mk('cpu', cfg.cpuC) }
  };
}
