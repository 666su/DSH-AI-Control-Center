import React from 'react';

function fmtGb(mb) { return (mb / 1024).toFixed(1) + ' GB'; }
function fmtGbVal(gb) { return gb != null ? gb.toFixed(1) + ' GB' : '—'; }

const STATE_META = {
  running:    { cls: 'on',    label: '🟢 运行中' },
  starting:   { cls: 'boot',  label: '🟡 启动中…' },
  degraded:   { cls: 'warn',  label: '🟠 检测异常（阈值内）' },
  abnormal:   { cls: 'err',   label: '🔴 异常' },
  recovering: { cls: 'boot',  label: '🔵 恢复中…' },
  halted:     { cls: 'halt',  label: '⛔ 自动恢复已熔断' },
  stopped:    { cls: 'off',   label: '⚪ 已停止' }
};

export function DshPanel({ dsh, onRestart, onPause, onResume, onStart, onStop, busy, onOpenWeb }) {
  const upd = dsh.uptimeSec ? fmtUptime(dsh.uptimeSec) : '—';
  // 优先走受控制中心保护的代理地址（需先登录控制中心）；无代理则退回本地地址
  const openUrl = dsh.proxyUrl || dsh.publicWebUrl || dsh.webUrl || ('http://127.0.0.1:' + (dsh.port || 3080));
  const meta = STATE_META[dsh.state] || STATE_META.stopped;
  const running = dsh.state === 'running' || dsh.state === 'degraded';
  const mon = dsh.monitor || null;
  return (
    <div className="card">
      <h3>DSH 运行状态</h3>
      <div className="dsh-status-row">
        <span className={'dsh-dot ' + meta.cls} />
        <span className="dsh-main">{meta.label}</span>
      </div>
      <div className="dsh-meta">
        <div>启动时间 <b>{dsh.startedAt ? new Date(dsh.startedAt).toLocaleString() : '—'}</b></div>
        <div>运行时长 <b>{upd}</b></div>
        <div>当前PID <b>{dsh.pid || '—'}</b></div>
        <div>Web端口 <b>{dsh.port}</b></div>
        <div>状态检测 <b>端口{dsh.portUp ? '✅' : '❌'} / HTTP{dsh.httpOk ? '✅' : '❌'} / 进程{dsh.pid ? '✅' : '❌'}</b></div>
        {mon && <>
          <div>恢复守护 <b>{mon.state || '—'}{mon.failStreak > 0 ? '（连续失败 ' + mon.failStreak + ' 次）' : ''}</b></div>
          <div>恢复尝试 <b>{mon.attempts || 0} / {dsh.monitor ? (dsh.monitor.maxAttempts || '—') : '—'}</b></div>
        </>}
      </div>
      <div className="btn-row">
        {running && <button className="btn danger" disabled={busy} onClick={onStop}>⏹ 停止DSH</button>}
        {!running && dsh.state !== 'starting' && dsh.state !== 'recovering' && (
          <button className="btn primary" disabled={busy} onClick={onStart}>▶ 启动DSH</button>
        )}
        <button className="btn primary" disabled={busy || !running} onClick={onRestart}>🔄 重启DSH</button>
        {running && <>
          <button className="btn warn" disabled={busy} onClick={onPause}>⏸ 暂停DSH</button>
          <button className="btn" disabled={busy} onClick={onResume}>▶ 继续</button>
        </>}
        <button className="btn" onClick={onOpenWeb}>🌐 打开DSH界面</button>
      </div>
    </div>
  );
}

export function SystemCards({ sys }) {
  if (!sys) return <div className="card"><div className="empty">等待系统数据…</div></div>;
  const cpuPct = sys.cpu?.load ?? null;
  const gpuPct = sys.gpu?.util ?? null;
  const vramPct = sys.gpu && sys.gpu.memTotalMb ? Math.round(sys.gpu.memUsedMb / sys.gpu.memTotalMb * 100) : null;
  const ramPct = sys.mem?.usedPercent ?? null;
  const diskPct = sys.diskTotalGb ? Math.round(sys.diskFreeGb / sys.diskTotalGb * 100) : null;
  return (
    <div className="card">
      <h3>系统资源（5秒自动刷新）</h3>
      <div className="grid">
        <Metric label="CPU" value={(cpuPct ?? '—') + '%'} bar={cpuPct} barClass="green" sub={sys.cpu?.cores ? sys.cpu.cores + ' 核心' : ''} />
        <Metric label="GPU" value={(gpuPct ?? '—') + '%'} bar={gpuPct} barClass="purple" sub={sys.gpu ? sys.gpu.name : '无GPU'} />
        <Metric label="显存 VRAM" value={fmtGb(sys.gpu?.memUsedMb)} bar={vramPct} barClass="blue"
          sub={sys.gpu ? fmtGb(sys.gpu.memTotalMb) + ' / ' + sys.gpu.tempC + '°C' : ''} />
        <Metric label="内存 RAM" value={fmtGbVal(sys.mem?.usedGb)} bar={ramPct} barClass="yellow"
          sub={sys.mem ? fmtGbVal(sys.mem.totalGb) + ' 总量' : ''} />
        <Metric label="磁盘剩余" value={sys.diskFreeGb + ' GB'} bar={diskPct} barClass="green"
          sub={sys.diskTotalGb + ' GB 总量（' + (sys.disk?.mount || 'C:') + '）'} />
      </div>
    </div>
  );
}

function Metric({ label, value, bar, barClass, sub }) {
  const pct = bar == null ? 0 : Math.min(100, Math.max(0, bar));
  return (
    <div className="metric">
      <div className="m-label"><span>{label}</span></div>
      <div className="m-val">{value}</div>
      <div className={'bar ' + (barClass || 'green')}><div style={{ width: pct + '%' }} /></div>
      {sub && <div className="m-sub">{sub}</div>}
    </div>
  );
}

export function fmtUptime(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d > 0) return d + '天' + h + '小时';
  if (h > 0) return h + '小时' + m + '分';
  if (m > 0) return m + '分' + s + '秒';
  return s + '秒';
}
