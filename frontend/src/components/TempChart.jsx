import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

/**
 * 温度历史趋势图（纯内联 SVG，无第三方图表依赖）。
 * 数据来源：/api/system/history（system_stats 的 gpu_temp / cpu_temp 列）。
 *
 * 采用「分桶取最大值」降采样：温度是尖峰型指标，取平均会抹掉真正的高温瞬间。
 */

const W = 840;
const H = 220;
const PAD = { l: 46, r: 16, t: 16, b: 26 };
const BUCKETS = 170;
const HOURS_OPTIONS = [1, 6, 24];

function aggregate(rows, buckets) {
  if (!rows.length) return [];
  const t0 = new Date(rows[0].ts).getTime();
  const t1 = new Date(rows[rows.length - 1].ts).getTime();
  const span = Math.max(1, t1 - t0);
  const out = Array.from({ length: buckets }, () => ({ t: null, gpu: null, cpu: null }));
  for (const r of rows) {
    const t = new Date(r.ts).getTime();
    let idx = Math.floor(((t - t0) / span) * (buckets - 1));
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    if (idx >= buckets) idx = buckets - 1;
    const b = out[idx];
    b.t = t;
    if (r.gpu_temp != null) b.gpu = b.gpu == null ? r.gpu_temp : Math.max(b.gpu, r.gpu_temp);
    if (r.cpu_temp != null) b.cpu = b.cpu == null ? r.cpu_temp : Math.max(b.cpu, r.cpu_temp);
  }
  return out;
}

function pathOf(points, key, xOf, yOf) {
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    const v = p[key];
    if (v == null) { pen = false; return; }
    d += (pen ? ' L' : ' M') + xOf(i).toFixed(1) + ' ' + yOf(v).toFixed(1);
    pen = true;
  });
  return d.trim();
}

function fmtClock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export default function TempChart({ thresholds, onJump }) {
  const [rows, setRows] = useState(null);
  const [hours, setHours] = useState(6);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.systemHistory(hours)
        .then(d => { if (alive) { setRows(Array.isArray(d) ? d : []); setFailed(false); } })
        .catch(() => { if (alive) setFailed(true); });
    };
    load();
    const iv = setInterval(load, 60000);
    return () => { alive = false; clearInterval(iv); };
  }, [hours]);

  const model = useMemo(() => {
    if (!rows || !rows.length) return null;
    const pts = aggregate(rows, BUCKETS);
    const vals = [];
    for (const p of pts) {
      if (p.gpu != null) vals.push(p.gpu);
      if (p.cpu != null) vals.push(p.cpu);
    }
    if (!vals.length) return { pts, empty: true };
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    lo = Math.floor((lo - 5) / 10) * 10;
    hi = Math.ceil((hi + 5) / 10) * 10;
    if (hi - lo < 20) hi = lo + 20;
    const gpuLimit = thresholds?.gpuC ?? 80;
    const cpuLimit = thresholds?.cpuC ?? 90;
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const n = pts.length;
    const xOf = i => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const yOf = v => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;
    const t0 = pts.find(p => p.t)?.t;
    const t1 = [...pts].reverse().find(p => p.t)?.t;
    const lastGpu = [...pts].reverse().find(p => p.gpu != null)?.gpu ?? null;
    const lastCpu = [...pts].reverse().find(p => p.cpu != null)?.cpu ?? null;
    return {
      pts, empty: false, lo, hi, xOf, yOf, t0, t1, gpuLimit, cpuLimit, lastGpu, lastCpu,
      gpuPath: pathOf(pts, 'gpu', xOf, yOf),
      cpuPath: pathOf(pts, 'cpu', xOf, yOf),
      hasGpu: pts.some(p => p.gpu != null),
      hasCpu: pts.some(p => p.cpu != null)
    };
  }, [rows, thresholds]);

  const ticks = model && !model.empty
    ? [model.lo, Math.round((model.lo + model.hi) / 2), model.hi]
    : [];

  return (
    <div className="card">
      <div className="chart-head">
        <h3>温度历史趋势</h3>
        <div className="chart-range">
          {HOURS_OPTIONS.map(h => (
            <button
              key={h}
              className={'btn tiny' + (hours === h ? ' primary' : '')}
              onClick={() => setHours(h)}
            >{h}h</button>
          ))}
        </div>
      </div>

      {failed && <div className="empty">加载失败，正在重试…</div>}
      {!failed && !model && <div className="empty">加载中…</div>}
      {!failed && model && model.empty && (
        <div className="empty">
          暂无温度数据<br /><br />
          <span className="m-sub">曲线从温度采集开启后才会有数据</span>
        </div>
      )}

      {!failed && model && !model.empty && (
        <>
          <div className="chart-legend">
            {model.hasGpu && <span className="lg lg-gpu">● GPU {model.lastGpu != null ? model.lastGpu.toFixed(1) + '°C' : '—'}</span>}
            {model.hasCpu && <span className="lg lg-cpu">● CPU {model.lastCpu != null ? model.lastCpu.toFixed(1) + '°C' : '—'}</span>}
          </div>
          <svg className="temp-chart" viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label="温度历史趋势图">
            {ticks.map((v, i) => (
              <g key={'y' + i}>
                <line x1={PAD.l} y1={model.yOf(v)} x2={W - PAD.r} y2={model.yOf(v)} className="grid-line" />
                <text x={PAD.l - 8} y={model.yOf(v) + 4} className="axis-text" textAnchor="end">{v}°</text>
              </g>
            ))}
            {model.hasGpu && model.gpuLimit >= model.lo && model.gpuLimit <= model.hi && (
              <line x1={PAD.l} y1={model.yOf(model.gpuLimit)} x2={W - PAD.r} y2={model.yOf(model.gpuLimit)} className="limit-line gpu" />
            )}
            {model.hasCpu && model.cpuLimit >= model.lo && model.cpuLimit <= model.hi && (
              <line x1={PAD.l} y1={model.yOf(model.cpuLimit)} x2={W - PAD.r} y2={model.yOf(model.cpuLimit)} className="limit-line cpu" />
            )}
            {model.cpuPath && <path d={model.cpuPath} className="series cpu" />}
            {model.gpuPath && <path d={model.gpuPath} className="series gpu" />}
            <text x={PAD.l} y={H - 8} className="axis-text">{fmtClock(model.t0)}</text>
            <text x={W - PAD.r} y={H - 8} className="axis-text" textAnchor="end">{fmtClock(model.t1)}</text>
          </svg>
          <div className="chart-foot">
            <span>虚线为告警阈值（GPU {model.gpuLimit}°C / CPU {model.cpuLimit}°C）</span>
            <span>每格为区间峰值，只保留高温瞬间</span>
          </div>
        </>
      )}
    </div>
  );
}