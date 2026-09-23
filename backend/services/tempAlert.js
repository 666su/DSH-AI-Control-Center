import { config } from '../config.js';
import { addLog } from '../database/db.js';
import { sendNotification } from './notifyService.js';

/**
 * 温度告警状态机。
 *
 * 策略（与用户确认）：
 *   - 进入高温：立即推送 1 次
 *   - 持续高温：每 repeatMs（默认 30 分钟）最多再提醒 1 次
 *   - 降温恢复：降到「阈值 - 迟滞」以下时推送 1 次
 *   - 迟滞（默认 3°C）用于防止在阈值附近反复抖动造成刷屏
 *
 * 状态保存在内存中：控制中心重启后重新武装（不会重复补推历史告警）。
 */

const state = {
  gpu: { level: 'normal', lastNotifyAt: 0, lastValue: null, lastNotifiedValue: null },
  cpu: { level: 'normal', lastNotifyAt: 0, lastValue: null, lastNotifiedValue: null }
};

function alertConfig() {
  return config.monitor?.tempAlert || {};
}

function buildSensors(snap) {
  const cfg = alertConfig();
  return [
    { key: 'gpu', label: 'GPU', value: snap?.temps?.gpuC ?? null, threshold: cfg.gpuC ?? 80 },
    { key: 'cpu', label: 'CPU', value: snap?.temps?.cpuC ?? null, threshold: cfg.cpuC ?? 90 }
  ];
}

function notify(event, sensor, phase) {
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
    phase
  })).catch(() => { /* 通知失败不影响监控 */ });
}

/**
 * 每轮采样后调用，判定是否需要推送温度告警。
 * @param {object} snap systemMonitor 产出的快照
 */
export function checkTemperatureAlerts(snap) {
  const cfg = alertConfig();
  if (cfg.enabled === false) return;

  const hysteresis = Number(cfg.hysteresisC ?? 3);
  const repeatMs = Number(cfg.repeatMs ?? 1800000);
  const now = Date.now();

  for (const sensor of buildSensors(snap)) {
    const st = state[sensor.key];
    if (sensor.value == null || !Number.isFinite(sensor.value)) continue;
    st.lastValue = sensor.value;

    if (st.level === 'normal') {
      if (sensor.value >= sensor.threshold) {
        st.level = 'high';
        st.lastNotifyAt = now;
        st.lastNotifiedValue = sensor.value;
        notify('temp.high', sensor, 'entered');
      }
    } else if (sensor.value <= sensor.threshold - hysteresis) {
      st.level = 'normal';
      st.lastNotifyAt = now;
      notify('temp.recovered', sensor, 'recovered');
    } else if (now - st.lastNotifyAt >= repeatMs) {
      st.lastNotifyAt = now;
      st.lastNotifiedValue = sensor.value;
      notify('temp.high', sensor, 'still high');
    }
  }
}

/** 供 API / 面板展示当前告警状态。 */
export function getTempAlertState() {
  const cfg = alertConfig();
  return {
    enabled: cfg.enabled !== false,
    thresholds: { gpuC: cfg.gpuC ?? 80, cpuC: cfg.cpuC ?? 90 },
    hysteresisC: cfg.hysteresisC ?? 3,
    repeatMs: cfg.repeatMs ?? 1800000,
    sensors: {
      gpu: { level: state.gpu.level, lastValue: state.gpu.lastValue, lastNotifyAt: state.gpu.lastNotifyAt || null },
      cpu: { level: state.cpu.level, lastValue: state.cpu.lastValue, lastNotifyAt: state.cpu.lastNotifyAt || null }
    }
  };
}