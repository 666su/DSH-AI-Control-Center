// API client with access-token support
const TOKEN_KEY = 'cc_access_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers['X-Access-Token'] = token;
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const resp = await fetch('/api' + path, { ...options, headers });
  if (resp.status === 401) {
    const err = new Error('unauthorized');
    err.unauthorized = true;
    throw err;
  }
  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try { const j = await resp.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const ct = resp.headers.get('content-type') || '';
  return ct.includes('application/json') ? resp.json() : resp.text();
}

export const api = {
  status: () => request('/status'),
  dshStatus: () => request('/dsh/status'),
  dshRestart: () => request('/dsh/restart', { method: 'POST' }),
  dshStart: () => request('/dsh/start', { method: 'POST' }),
  dshStop: () => request('/dsh/stop', { method: 'POST' }),
  dshControl: (action) => request('/dsh/control', { method: 'POST', body: JSON.stringify({ action }) }),
  authSession: () => request('/auth/session', { method: 'POST' }),
  systemLast: () => request('/system/last'),
  systemHistory: (hours = 6) => request('/system/history?hours=' + hours),

  getModels: () => request('/tasks/models'),
  listTasks: (params = '') => request('/tasks' + params),
  createTask: (payload) => request('/tasks', { method: 'POST', body: JSON.stringify(payload) }),
  getTask: (id) => request('/tasks/' + id),
  taskLog: (id, maxLen = 30000) => request('/tasks/' + id + '/log?maxLen=' + maxLen),
  taskControl: (id, action) => request('/tasks/' + id + '/control', { method: 'POST', body: JSON.stringify({ action }) }),

  monitorStatus: () => request('/monitor/status'),
  logs: (params = '') => request('/logs' + params),
  addLog: (payload) => request('/logs', { method: 'POST', body: JSON.stringify(payload) }),
  notifyConfig: () => request('/notify/config'),
  saveNotify: (payload) => request('/notify/config', { method: 'POST', body: JSON.stringify(payload) }),
  testNotify: () => request('/notify/test', { method: 'POST' })
};
