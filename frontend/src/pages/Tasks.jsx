import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { fmtUptime } from '../components/DashboardCards.jsx';

const STATUS_LABEL = { queued: '排队中', running: '执行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' };

export default function Tasks({ notify }) {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ name: '', instruction: '', workspace: '', provider: '', model: '' });
  const [models, setModels] = useState([]);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const [logText, setLogText] = useState('');


  // 加载模型列表
  useEffect(() => {
    api.getModels().then(m => {
      setModels(m);
    }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    api.listTasks(filter ? '?status=' + filter + '&limit=200' : '?limit=200')
      .then(setTasks).catch(e => notify('加载任务失败: ' + e.message, 'error'));
  }, [filter, notify]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  // 按提供商分组模型
  const providers = (() => {
    const map = new Map();
    for (const m of models) {
      if (!map.has(m.provider)) {
        map.set(m.provider, { name: m.provider, models: [], freeCount: 0, paidCount: 0, hasCurrent: false });
      }
      const p = map.get(m.provider);
      p.models.push(m);
      if (m.free) p.freeCount++; else p.paidCount++;
      if (m.current) p.hasCurrent = true;
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  })();

  // 当前提供商下的模型列表
  const providerModels = form.provider
    ? (providers.find(p => p.name === form.provider)?.models || [])
    : [];

  const createTask = async () => {
    if (!form.instruction.trim()) { notify('请输入指令内容', 'error'); return; }
    setCreating(true);
    try {
      const payload = { name: form.name, instruction: form.instruction, workspace: form.workspace };
      if (form.provider && form.model) {
        payload.provider = form.provider;
        payload.model = form.model;
      }
      const r = await api.createTask(payload);
      if (r.ok) {
        notify('任务 ' + r.task.id + ' 已创建并开始执行' + (form.provider ? '（模型: ' + form.provider + (form.model ? '/' + form.model : '') + '）' : ''));
        setForm({ name: '', instruction: '', workspace: '', provider: '', model: '' });
        load();
      } else notify('创建失败: ' + r.error, 'error');
    } catch (e) { notify('创建失败: ' + e.message, 'error'); }
    finally { setCreating(false); }
  };

  const control = async (id, action, label) => {
    try {
      const r = await api.taskControl(id, action);
      notify(label + (r.ok ? '成功' : '失败: ' + (r.error || '')), r.ok ? 'ok' : 'error');
      load();
      if (detail && detail.id === id) refreshDetail(id);
    } catch (e) { notify('操作失败: ' + e.message, 'error'); }
  };

  const openDetail = async (t) => {
    setDetail(t);
    await refreshDetail(t.id);
  };

  const refreshDetail = async (id) => {
    const [t, l] = await Promise.all([api.getTask(id), api.taskLog(id, 60000)]);
    setDetail(t);
    setLogText(l.text || '');
  };

  useEffect(() => {
    if (detail && ['running', 'queued', 'paused'].includes(detail.status)) {
      const iv = setInterval(() => refreshDetail(detail.id).catch(() => {}), 4000);
      return () => clearInterval(iv);
    }
  }, [detail && detail.status]);

  const runningCount = tasks.filter(t => ['running','queued','paused'].includes(t.status)).length;

  return (
    <>
      <div className="card">
        <h3>发送新指令</h3>
        <div className="field">
          <label>任务名称（可选）</label>
          <input value={form.name} placeholder="例如：开发博客系统" onChange={e => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label>指令内容 *</label>
          <textarea value={form.instruction} placeholder="例如：检查 E:\proj 下代码错误并自动修复&#10;继续执行当前任务&#10;生成 xxx 的测试" onChange={e => setForm({ ...form, instruction: e.target.value })} />
        </div>
        <div className="field">
          <label>工作目录（可选，默认 E:\DeepSeek Harness）</label>
          <input value={form.workspace} placeholder="E:\DeepSeek Harness" onChange={e => setForm({ ...form, workspace: e.target.value })} />
        </div>

        {/* 两级模型选择器 */}
        <div className="field">
          <label>API 提供商 / 模型（不选 = 用 DSH 默认模型）</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            {/* 第一级：选择 API 提供商 */}
            <select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value, model: '' })}
              style={{ flex: 1, minWidth: 140 }}>
              <option value="">— 不指定（用默认）</option>
              {providers.map(p => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.freeCount}🆓 / {p.paidCount}💰)
                </option>
              ))}
            </select>
            {/* 第二级：选择该提供商下的模型 */}
            {form.provider && providerModels.length > 0 && (
              <select value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}
                style={{ flex: 1, minWidth: 180 }}>
                <option value="">— 提供商默认</option>
                {providerModels.map(m => (
                  <option key={m.model} value={m.model}>
                    {m.name}{m.free ? ' 🆓' : ' 💰'}{m.current ? ' ←' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          {form.provider && (
            <div style={ { fontSize: 13, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 } } >
              🎯 {form.provider}{form.model ? ' / ' + form.model : ''}
              <button className="btn sm" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setForm({ ...form, provider: '', model: '' })}>✕ 重置</button>
            </div>
          )}
          {models.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>（模型列表加载中或无可用模型）</div>}
        </div>

        <div className="btn-row">
          <button className="btn primary" disabled={creating} onClick={createTask}>
            {creating ? '提交中…' : '🚀 发送指令'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>任务列表 {runningCount > 0 && <span style={{ color: 'var(--green)' }}>（{runningCount} 个进行中）</span>}</h3>
        <div className="log-filters">
          <select value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn sm" onClick={load}>刷新</button>
        </div>
        {tasks.length === 0 ? <div className="empty">暂无任务</div> : tasks.map(t => (
          <div key={t.id} className="task-item" onClick={() => openDetail(t)}>
            <div className="task-head">
              <span className="task-id">{t.id}</span>
              <span className="task-name">{t.name}</span>
              <span className={'badge ' + t.status}>{STATUS_LABEL[t.status] || t.status}</span>
            </div>
            <div className="task-instr">{t.instruction}</div>
            <div className="task-meta">
              <span>创建: {new Date(t.created_at).toLocaleString()}</span>
              {t.started_at && t.status === 'running' && <span>运行: {fmtUptime((Date.now() - new Date(t.started_at)) / 1000)}</span>}
              {t.finished_at && <span>结束: {new Date(t.finished_at).toLocaleString()}</span>}
              {t.exit_code !== null && <span>退出码: {t.exit_code}</span>}
              {t.model && <span style={{ color: 'var(--accent)' }}>模型: {t.provider}/{t.model}</span>}
            </div>
            {['running', 'paused', 'queued'].includes(t.status) && (
              <div className="btn-row" style={{ marginTop: 10 }} onClick={e => e.stopPropagation()}>
                {t.status === 'paused'
                  ? <button className="btn sm primary" onClick={() => control(t.id, 'resume', '继续执行 ' + t.id + ' ')}>▶ 继续执行</button>
                  : <button className="btn sm warn" onClick={() => control(t.id, 'pause', '暂停 ' + t.id + ' ')}>⏸ 暂停任务</button>}
                <button className="btn sm danger" onClick={() => control(t.id, 'cancel', '取消 ' + t.id + ' ')}>✕ 取消</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{detail.id} — {detail.name} <span className={'badge ' + detail.status}>{STATUS_LABEL[detail.status] || detail.status}</span></h3>
              <button className="modal-x" onClick={() => setDetail(null)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--muted)' }}>
                <div><b style={{ color: 'var(--text)' }}>指令：</b>{detail.instruction}</div>
                <div style={{ marginTop: 4 }}>工作目录：{detail.workspace} ｜ PID: {detail.pid || '—'}</div>
                {detail.model && <div style={{ marginTop: 4 }}><b style={{ color: 'var(--text)' }}>模型：</b><span style={{ color: 'var(--accent)' }}>{detail.provider}/{detail.model}</span></div>}
                {detail.result && <div style={{ marginTop: 6 }}><b style={{ color: 'var(--text)' }}>结果：</b>{detail.result.slice(0, 300)}</div>}
              </div>
              <div className="btn-row" style={{ marginBottom: 10 }}>
                {detail.status === 'paused'
                  ? <button className="btn sm primary" onClick={() => control(detail.id, 'resume', '继续执行 ' + detail.id + ' ')}>▶ 继续执行</button>
                  : ['running', 'queued'].includes(detail.status) && <button className="btn sm warn" onClick={() => control(detail.id, 'pause', '暂停 ' + detail.id + ' ')}>⏸ 暂停任务</button>}
                {['running', 'paused', 'queued'].includes(detail.status)
                  && <button className="btn sm danger" onClick={() => control(detail.id, 'cancel', '取消 ' + detail.id + ' ')}>✕ 取消任务</button>}
              </div>
              <div className="log-viewer" style={{ height: 260 }} ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>
                {logText ? <pre style={{ fontFamily: 'inherit', fontSize: 12, whiteSpace: 'pre-wrap' }}>{logText}</pre>
                  : <div className="empty">（暂无日志输出）</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}