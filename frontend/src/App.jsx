import React, { useState, useEffect, useCallback } from 'react';
import Dashboard from './pages/Dashboard.jsx';
import Tasks from './pages/Tasks.jsx';
import Logs from './pages/Logs.jsx';
import Settings from './pages/Settings.jsx';
import { api, getToken, setToken } from './api.js';

const TABS = [
  { id: 'dashboard', label: '状态', icon: '📊' },
  { id: 'tasks', label: '任务', icon: '🗂️' },
  { id: 'logs', label: '日志', icon: '📜' },
  { id: 'settings', label: '设置', icon: '⚙️' }
];

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [authGate, setAuthGate] = useState(false);
  const [tokenInput, setTokenInput] = useState(getToken());
  const [globalStatus, setGlobalStatus] = useState(null);
  const [toast, setToast] = useState(null);

  // check auth + bootstrap status
  useEffect(() => {
    api.status().then((s) => {
      setGlobalStatus(s);
      // 每次打开控制中心都刷新登录 cookie（供 dshui 代理子域名使用，避免已登录设备无 cookie 被 302 弹回）
      api.authSession().catch(() => {});
    }).catch((e) => {
      if (e.unauthorized) setAuthGate(true);
    });
    const iv = setInterval(() => {
      api.status().then(setGlobalStatus).catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, [authGate]);

  const notify = useCallback((msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  if (authGate) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <div className="auth-logo">🛰️</div>
          <h1>DSH AI Control Center</h1>
          <p>请输入访问令牌以继续</p>
          <input
            type="password" value={tokenInput} autoFocus
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Access Token" />
          <button onClick={submit}>连接</button>
        </div>
      </div>
    );
    function submit() {
      setToken(tokenInput.trim());
      const saved = getToken();
      api.status().then((s) => {
        setAuthGate(false); setToken(saved); setGlobalStatus(s);
        api.authSession().catch(() => {}); // 设置登录 cookie（供 DSH 代理子域名共享登录态）
      })
        .catch(() => alert('令牌无效'));
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">🛰️</span>
          <div>
            <div className="brand-name">DSH Control Center</div>
            <div className="brand-sub">{globalStatus ? (globalStatus.dsh.running ? '🟢 DSH 运行中' : '🔴 DSH 已停止') : '连接中…'}</div>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map(t => (
            <button key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
              <span className="tab-icon">{t.icon}</span>
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {tab === 'dashboard' && <Dashboard globalStatus={globalStatus} notify={notify} onJump={setTab} />}
        {tab === 'tasks' && <Tasks notify={notify} />}
        {tab === 'logs' && <Logs notify={notify} />}
        {tab === 'settings' && <Settings notify={notify} />}
      </main>


      {/* ===== 作者署名 ===== */}
      <footer className="site-footer">
        <div className="footer-inner">
          <span>© {new Date().getFullYear()}</span>
          <a href="https://github.com/666su" target="_blank" rel="noopener noreferrer">Jason</a>
          <span className="footer-dot">·</span>
          <a href="https://blog.20240606.xyz/" target="_blank" rel="noopener noreferrer">Blog</a>
          <span className="footer-dot">·</span>
          DSH AI Control Center
        </div>
      </footer>

      {toast && <div className={'toast ' + toast.type}>{toast.msg}</div>}
    </div>
  );
}
