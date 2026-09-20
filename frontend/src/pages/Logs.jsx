import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, getToken } from '../api.js';

export default function Logs({ notify }) {
  const [logs, setLogs] = useState([]);
  const [source, setSource] = useState('');
  const [level, setLevel] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [live, setLive] = useState(true);
  const hasToken = !!getToken();
  const boxRef = useRef(null);
  const lastIdRef = useRef(0);

  const loadInitial = useCallback(() => {
    api.logs('?limit=300&source=' + source + '&level=' + level)
      .then(rows => {
        setLogs(rows);
        lastIdRef.current = rows.length ? rows[rows.length - 1].id : 0;
      })
      .catch(e => notify('加载日志失败: ' + e.message, 'error'));
  }, [source, level, notify]);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  // polling fallback + SSE
  useEffect(() => {
    let es = null;
    const useSse = !hasToken && typeof EventSource !== 'undefined';
    if (useSse) {
      try {
        es = new EventSource('/api/logs/stream');
        const handle = (ev) => {
          try {
            const entry = JSON.parse(ev.data);
            if (!entry || !entry.id) return;
            if (entry.id > lastIdRef.current) lastIdRef.current = entry.id;
            setLogs(prev => {
              if (prev.some(l => l.id === entry.id)) return prev;
              const next = [...prev, entry];
              return next.length > 500 ? next.slice(next.length - 500) : next;
            });
          } catch { /* ignore malformed */ }
        };
        es.addEventListener('log', handle);
        es.addEventListener('dsh-status', handle);
        es.onmessage = handle;
      } catch { es = null; }
    }
    const iv = setInterval(() => {
      if (!useSse) {
        api.logs('?limit=50&afterId=' + lastIdRef.current + '&source=' + source + '&level=' + level)
          .then(rows => {
            if (rows.length) {
              lastIdRef.current = rows[rows.length - 1].id;
              setLogs(prev => [...prev, ...rows].slice(-500));
            }
          }).catch(() => {});
      }
      if (boxRef.current && autoScroll) boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }, 3000);
    return () => { if (es) es.close(); clearInterval(iv); };
  }, [source, level, autoScroll, live]);

  const clearView = () => { setLogs([]); lastIdRef.current = 0; };

  return (
    <div className="card">
      <h3>运行日志（实时）</h3>
      <div className="log-filters">
        <select value={source} onChange={e => setSource(e.target.value)}>
          <option value="">全部来源</option>
          <option value="dsh">DSH</option>
          <option value="task">任务</option>
          <option value="system">系统</option>
          <option value="notify">通知</option>
        </select>
        <select value={level} onChange={e => setLevel(e.target.value)}>
          <option value="">全部级别</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} /> 自动滚动
        </label>
        <div className="spacer" />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{logs.length} 条</span>
        <button className="btn sm" onClick={loadInitial}>刷新</button>
        <button className="btn sm" onClick={clearView}>清空视图</button>
      </div>
      <div className="log-viewer" ref={boxRef}>
        {logs.length === 0 ? <div className="empty">暂无日志</div> : logs.map(l => (
          <div key={l.id} className={'log-line ' + (l.level || 'info')}>
            <span className="t">[{new Date(l.ts).toLocaleTimeString()}]</span>
            <span className="src">{l.source}</span>
            <span className="m">{l.message}</span>
          </div>
        ))}
      </div>
      <p style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)' }}>
        日志来源：DSH运行日志（dsh.log）自动采集 + 控制中心自身事件。历史日志保存在 SQLite（logs 表）。
      </p>
    </div>
  );
}
