import React, { useState } from 'react';
import { DshPanel, SystemCards } from '../components/DashboardCards.jsx';
import { api } from '../api.js';

export default function Dashboard({ globalStatus, notify, onJump }) {
  const [sys, setSys] = useState(globalStatus?.system || null);
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState(null);

  React.useEffect(() => {
    let alive = true;
    const load = () => {
      api.systemLast().then(s => alive && setSys(s)).catch(() => {});
      api.listTasks('?limit=6').then(l => alive && setTasks(l)).catch(() => {});
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const doAction = async (fn, okMsg) => {
    setBusy(true);
    try { const r = await fn(); notify(okMsg + (r.pid ? ' (pid ' + r.pid + ')' : ''), r.ok ? 'ok' : 'error'); }
    catch (e) { notify('操作失败: ' + e.message, 'error'); }
    finally { setBusy(false); }
  };

  const dsh = globalStatus?.dsh || { state: 'stopped', running: false, port: 3080, portUp: false, pid: null, startedAt: null, uptimeSec: null };
  // 优先走受保护代理（proxyUrl）；无代理则退回本地地址
  const openUrlFor = (s) => s.proxyUrl || s.publicWebUrl || s.webUrl || ('http://127.0.0.1:' + (s.port || 3080));

  return (
    <>
      <DshPanel
        dsh={dsh}
        busy={busy}
        onRestart={() => doAction(() => api.dshRestart(), 'DSH 重启指令已发送')}
        onStart={() => doAction(() => api.dshStart(), 'DSH 启动指令已发送')}
        onStop={() => doAction(() => api.dshStop(), 'DSH 停止指令已发送')}
        onPause={() => doAction(() => api.dshControl('pause'), 'DSH 已暂停')}
        onResume={() => doAction(() => api.dshControl('resume'), 'DSH 已恢复')}
        onOpenWeb={() => window.open(openUrlFor(dsh), '_blank')}
      />
      <SystemCards sys={sys} />

      <div className="card">
        <h3>最近任务</h3>
        {!tasks ? <div className="empty">加载中…</div> : tasks.length === 0 ? (
          <div className="empty">
            暂无任务<br /><br />
            <button className="btn primary" onClick={() => onJump('tasks')}>➕ 创建新任务</button>
          </div>
        ) : (
          tasks.map(t => (
            <div key={t.id} className="task-item" onClick={() => onJump('tasks')}>
              <div className="task-head">
                <span className="task-id">{t.id}</span>
                <span className="task-name">{t.name}</span>
                <span className={'badge ' + t.status}>{t.status}</span>
              </div>
              <div className="task-meta">
                <span>创建: {new Date(t.created_at).toLocaleString()}</span>
                {t.finished_at && <span>完成: {new Date(t.finished_at).toLocaleString()}</span>}
                {t.exit_code !== null && <span>退出码: {t.exit_code}</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
