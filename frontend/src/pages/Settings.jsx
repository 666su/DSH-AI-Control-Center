import React, { useState, useEffect, useCallback } from 'react';
import { api, getToken } from '../api.js';

// ---- 工作区对话推送：监听 DSH Web 界面里的会话，每轮回复结束就推送 ----

const REASON_BADGE = {
  completed: { label: '完成', cls: 'completed' },
  error: { label: '出错', cls: 'failed' },
  'max-tokens': { label: '超长', cls: 'failed' },
  aborted: { label: '手动停止', cls: 'cancelled' },
  blocked: { label: '被拦截', cls: 'paused' },
  interrupted: { label: '中断', cls: 'cancelled' },
  unknown: { label: '未知', cls: 'cancelled' }
};

function wsName(ws) {
  if (!ws) return '未知工作区';
  const parts = String(ws).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(ws);
}

function SessionTurns({ notify }) {
  const [st, setSt] = useState(null);
  const [rows, setRows] = useState([]);
  const [ignoreText, setIgnoreText] = useState('');
  const [testing, setTesting] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, t] = await Promise.all([api.sessionWatcher(), api.sessionTurns('?limit=30')]);
      setSt(w);
      setRows(Array.isArray(t) ? t : []);
      setIgnoreText((Array.isArray(w.ignoreWorkspaces) ? w.ignoreWorkspaces : []).join('\n'));
    } catch { /* ignore */ }
  }, []);

  // 保存忽略工作区列表（按行拆分）
  const saveIgnore = async () => {
    const list = ignoreText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    api.notifyConfig().then(async (c) => {
      const next = { ...c, sessionTurns: { ...(c.sessionTurns || {}), ignoreWorkspaces: list } };
      try {
        await api.saveNotify(next);
        notify('忽略工作区已保存，正在重启监听…');
        await api.restartSessions();
        load();
      } catch (err) { notify('保存失败: ' + err.message, 'error'); }
    });
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 8000);
    return () => clearInterval(iv);
  }, [load]);

  const toggleReason = (key, label) => {
    api.notifyConfig().then(async (c) => {
      const cur = c.sessionTurns || {};
      const next = { ...c, sessionTurns: { ...cur, [key]: !cur[key] } };
      try {
        await api.saveNotify(next);
        notify((!cur[key] ? '已开启' : '已关闭') + '「' + label + '」推送');
        load();
      } catch (err) { notify('保存失败: ' + err.message, 'error'); }
    });
  };

  const restart = async () => {
    setRestarting(true);
    try {
      const r = await api.restartSessions();
      notify(r.running ? '监听器已重启' : '监听器未启动（请检查开关）');
      await load();
    } catch (err) { notify('重启失败: ' + err.message, 'error'); }
    setRestarting(false);
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.testSessionTurn();
      if (r && r.delivered) notify('✅ 对话推送测试已送达');
      else notify('⚠️ 未送达：' + JSON.stringify((r && r.deliveries) || r), 'error');
    } catch (err) { notify('测试失败: ' + err.message, 'error'); }
    setTesting(false);
  };

  const w = st || {};
  return (
    <div className="card">
      <h3>工作区对话推送</h3>
      <div className="setting-desc" style={{ marginBottom: 10 }}>
        监听 DSH Web 界面里的工作区会话：每轮回复结束（完成 / 出错 / 输出超长 / 手动停止）就推送一条。
        任务页创建的单次指令由「任务完成 / 失败」推送覆盖，这里不会重复推送。
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">开启完成推送</div>
          <div className="setting-desc">对话正常跑完时推送（含本轮用户指令摘要）</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={!!w.onCompleted} onChange={() => toggleReason('onCompleted', '完成推送')} />
          <span className="slider" />
        </label>
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">开启失败推送</div>
          <div className="setting-desc">出错、输出超长、被权限拦截时推送（含原因）</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={!!w.onFailed} onChange={() => toggleReason('onFailed', '失败推送')} />
          <span className="slider" />
        </label>
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">开启手动停止推送</div>
          <div className="setting-desc">自己点了停止也推送一条记录</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={!!w.onAborted} onChange={() => toggleReason('onAborted', '手动停止推送')} />
          <span className="slider" />
        </label>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">忽略工作区</div>
          <div className="setting-desc">每行一个工作区路径（支持包含匹配），这些工作区的对话不推送、不记录。留空 = 全部监听</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <textarea
            style={{ width: 300, minHeight: 54, fontFamily: 'inherit', fontSize: 12, background: 'var(--card2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '6px 8px' }}
            placeholder={'例如\nD:\\projects\\my-app'}
            value={ignoreText}
            onChange={e => setIgnoreText(e.target.value)}
          />
          <button className="btn sm" onClick={saveIgnore}>保存忽略列表</button>
        </div>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">监听状态</div>
          <div className="setting-desc" title={w.root || ''}>
            {w.running ? '🟢 运行中' : '⚪ 未运行'} ｜ 跟踪 {w.trackingFiles || 0} 个会话 ｜ 已推送 {w.turnsNotified || 0} 条 ｜ 已跳过 {w.turnsSkipped || 0} 条
            {w.lastPollAt ? ' ｜ 上次轮询 ' + w.lastPollAt : ''}
          </div>
        </div>
        <div className="btn-row">
          <button className="btn sm" onClick={restart} disabled={restarting}>{restarting ? '重启中…' : '重启监听'}</button>
          <button className="btn sm" onClick={test} disabled={testing}>{testing ? '发送中…' : '测试推送'}</button>
        </div>
      </div>
      {w.lastError ? (
        <div className="setting-desc" style={{ color: 'var(--red)', marginTop: 8 }}>监听异常：{w.lastError}</div>
      ) : null}

      <div className="setting-label" style={{ marginTop: 16, marginBottom: 6 }}>最近结束的对话</div>
      {rows.length === 0 ? (
        <div className="empty">还没有记录。保存配置后等一会儿，或先「重启监听」触发一次历史回填。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
          {rows.map(r => {
            const b = REASON_BADGE[r.reason_kind] || REASON_BADGE.unknown;
            return (
              <div key={r.id} className="task-item" style={{ padding: '8px 10px' }}>
                <div className="task-head">
                  <span className={'badge ' + b.cls}>{b.label}</span>
                  <span className="task-name" title={r.workspace}>{wsName(r.workspace)}</span>
                  <span className="task-meta" style={{ margin: 0 }}>
                    {r.title || (r.session_id ? r.session_id.slice(0, 12) : '')}
                    {r.turn ? ' · 第 ' + r.turn + ' 轮' : ''}
                  </span>
                </div>
                {r.prompt ? <div className="task-instr" title={r.prompt}>{r.prompt}</div> : null}
                {r.reason_detail ? <div className="task-instr" title={r.reason_detail}>{r.reason_detail}</div> : null}
                <div className="task-meta">
                  <span>{r.ts}</span>
                  {r.notified ? <span style={{ color: 'var(--green)' }}>已推送</span> : <span>未推送</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


function TempAlert({ notify }) {
  const [t, setT] = useState(null);        // notify.tempAlert 配置
  const [live, setLive] = useState(null);  // /api/system/last 里的 tempAlert 状态机
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await api.notifyConfig();
      if (c.tempAlert) setT(c.tempAlert);
      const s = await api.systemLast();
      if (s) setLive(s);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  const patch = (obj) => setT(prev => (prev ? { ...prev, ...obj } : prev));
  const num = (v, d) => (v === '' || v == null ? d : Number(v));

  const save = async () => {
    if (!t) return;
    setSaving(true);
    try {
      const c = await api.notifyConfig();
      const r = await api.saveNotify({ ...c, tempAlert: t });
      setT(r.tempAlert);
      notify('温度推送配置已保存');
    } catch (err) { notify('保存失败: ' + err.message, 'error'); }
    setSaving(false);
  };

  if (!t) return <div className="card"><h3>温度推送</h3><div className="empty">加载中…</div></div>;

  const st = (live && live.tempAlert) || {};
  const sensors = st.sensors || {};
  const cur = (live && live.temps) || {};
  const intervalMin = Math.round((t.repeatMs || 1800000) / 60000);

  const sensorRow = (key, label, color) => {
    const s = sensors[key] || {};
    const v = cur[key + 'C'];
    const th = key === 'gpu' ? t.gpuC : t.cpuC;
    const over = v != null && th != null && v >= th;
    return (
      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
        <span style={{ width: 44, color: color, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 20, fontWeight: 700, minWidth: 78, color: over ? 'var(--red)' : 'var(--text)' }}>
          {v == null ? '--' : v.toFixed(0) + '°C'}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>阈值 {th}°C</span>
        <span className={'badge ' + (s.level === 'high' ? 'failed' : 'running')} style={{ marginLeft: 'auto' }}>
          {s.level === 'high' ? '🔥 高温中' : '🟢 正常'}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12, minWidth: 120 }}>
          窗口 {s.sampleCount || 0}/{st.windowSamples} 次采样
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12, minWidth: 96 }}>
          其中 <b style={{ color: (s.windowAbove || 0) >= s.hotNeed ? 'var(--red)' : 'var(--text)' }}>{s.windowAbove || 0}</b>/{st.windowSamples} 次超阈值
        </span>
        {s.windowMax != null && s.windowMin != null ? (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>区间 {s.windowMin.toFixed(0)}–{s.windowMax.toFixed(0)}°C</span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="card">
      <h3>温度推送</h3>

      <div className="setting-row">
        <div>
          <div className="setting-label">启用温度推送</div>
          <div className="setting-desc">关闭后完全不发送温度告警（仍会继续采样和记录）</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={!!t.enabled} onChange={e => patch({ enabled: e.target.checked })} />
          <span className="slider" />
        </label>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">进入高温推送</div>
          <div className="setting-desc">温度升到阈值时推送一次（CPU {t.cpuC}°C / GPU {t.gpuC}°C）</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={!!t.onHigh} onChange={e => patch({ onHigh: e.target.checked })} />
          <span className="slider" />
        </label>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">持续高温重复提醒</div>
          <div className="setting-desc">一直高温时每 {intervalMin} 分钟再提醒一次；关闭则只在进入高温时推一次</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={!!t.onStillHigh} onChange={e => patch({ onStillHigh: e.target.checked })} />
          <span className="slider" />
        </label>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">降温恢复推送</div>
          <div className="setting-desc">温度降回正常时推送一次。CPU 温度波动大时这类消息是主要噪音来源，建议关闭</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={!!t.onRecovered} onChange={e => patch({ onRecovered: e.target.checked })} />
          <span className="slider" />
        </label>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">CPU 阈值</div>
          <div className="setting-desc">单位 °C</div>
        </div>
        <input type="number" min={40} max={110} value={t.cpuC} style={{ width: 90, textAlign: 'right' }}
          onChange={e => patch({ cpuC: num(e.target.value, t.cpuC) })} />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">GPU 阈值</div>
          <div className="setting-desc">单位 °C</div>
        </div>
        <input type="number" min={40} max={110} value={t.gpuC} style={{ width: 90, textAlign: 'right' }}
          onChange={e => patch({ gpuC: num(e.target.value, t.gpuC) })} />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">迟滞温度</div>
          <div className="setting-desc">判定"已恢复正常"要降到「阈值 - 迟滞」以下，避免在阈值附近来回穿越</div>
        </div>
        <input type="number" min={0} max={20} step={1} value={t.hysteresisC} style={{ width: 90, textAlign: 'right' }}
          onChange={e => patch({ hysteresisC: num(e.target.value, t.hysteresisC) })} />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">判定窗口</div>
          <div className="setting-desc">
            最近 windowSeconds 秒内的采样作为判定依据（采样间隔 {(t.intervalMs || 5000) / 1000}s
            → 窗口共 <b>{t.windowSamples}</b> 个采样点）。<b>不要</b>用「连续 N 次」判定：
            负载型 CPU 温度是振荡的，连续判定既不灵敏、进入高温后也回不到正常
          </div>
        </div>
        <input type="number" min={10} max={600} step={5} value={t.windowSeconds} style={{ width: 90, textAlign: 'right' }}
          onChange={e => patch({ windowSeconds: num(e.target.value, t.windowSeconds) })} />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">窗口内超阈值次数</div>
          <div className="setting-desc">
            窗口 {t.windowSamples} 次采样里，至少 <b>{t.minSustained}</b> 次超阈值才判高温
            （约 {Math.round(t.minSustained / Math.max(1, t.windowSamples) * 100)}%）；
            降温恢复需 {(t.windowSamples - t.minSustained + 1)}/{t.windowSamples} 次低于「阈值-迟滞」。
            调大 = 更不容易误报，调小 = 更灵敏
          </div>
        </div>
        <input type="number" min={1} max={t.windowSamples} step={1} value={t.minSustained} style={{ width: 90, textAlign: 'right' }}
          onChange={e => patch({ minSustained: num(e.target.value, t.minSustained) })} />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">重复提醒间隔</div>
          <div className="setting-desc">单位 分钟</div>
        </div>
        <input type="number" min={1} max={120} step={1} value={intervalMin} style={{ width: 90, textAlign: 'right' }}
          onChange={e => patch({ repeatMs: num(e.target.value, intervalMin) * 60000 })} />
      </div>

      <div className="btn-row">
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
        <button className="btn" onClick={() => {
          api.notifyConfig().then(async c => {
            const r = await api.saveNotify({ ...c, tempAlert: { ...c.tempAlert, onRecovered: false, onHigh: true, onStillHigh: true, windowSeconds: 60, minSustained: 5 } });
            setT(r.tempAlert);
            notify('已套用推荐配置：关恢复推送 + 60 秒窗口内 5/12 次超阈值才告警');
          }).catch(err => notify('保存失败: ' + err.message, 'error'));
        }}>套推荐配置（防刷屏）</button>
      </div>

      <div className="setting-label" style={{ marginTop: 16, marginBottom: 6 }}>当前温度</div>
      <div style={{ background: 'var(--card2)', borderRadius: 8, padding: '4px 12px' }}>
        {sensorRow('cpu', 'CPU', '#ff9e64')}
        <div style={{ height: 1, background: 'var(--border)' }} />
        {sensorRow('gpu', 'GPU', '#7ee787')}
      </div>
      {st.enabled === false ? (
        <div className="setting-desc" style={{ color: 'var(--yellow)', marginTop: 8 }}>温度推送已关闭</div>
      ) : null}
    </div>
  );
}

export default function Settings({ notify }) {
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState({ enabled: false, channels: [], telegramBotToken: '', telegramChatId: '', serverChanKey: '', endpoint: '' });
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.notifyConfig().then(c => {
      setCfg(c);
      setForm({ enabled: c.enabled, channels: c.channels, telegramBotToken: '', telegramChatId: c.telegramChatId || '', serverChanKey: '', endpoint: c.endpoint || '' });
    }).catch(e => notify('加载设置失败: ' + e.message, 'error'));
  }, []); // 仅挂载时加载一次，避免每 5 秒状态轮询导致表单被重置

  const toggleChannel = (ch) => {
    const has = form.channels.includes(ch);
    setForm({ ...form, channels: has ? form.channels.filter(x => x !== ch) : [...form.channels, ch] });
  };

  const save = async () => {
    try {
      const r = await api.saveNotify(form);
      setCfg(r);
      notify('通知配置已保存');
    } catch (e) { notify('保存失败: ' + e.message, 'error'); }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.testNotify();
      if (r && r.delivered) notify('✅ 测试推送已送达');
      else notify('⚠️ 推送未送达：' + JSON.stringify((r && r.deliveries) || r), 'error');
    } catch (e) { notify('测试失败: ' + e.message, 'error'); }
    setTesting(false);
  };

  const removeToken = () => {
    localStorage.removeItem('cc_access_token');
    notify('已清除本地令牌');
    setTimeout(() => location.reload(), 600);
  };

  return (
    <>
      <div className="card">
        <h3>通知推送</h3>
        <div className="setting-row">
          <div>
            <div className="setting-label">启用通知</div>
            <div className="setting-desc">开启后，任务完成/失败、DSH 会话异常（上下文不足、Token 超限、API Key 无效、限流等）会通过下方通道推送到手机</div>
          </div>
          <label className="switch">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
            <span className="slider" />
          </label>
        </div>

        {!cfg ? <div className="empty">加载中…</div> : (
          <>
            <div className="setting-row">
              <div>
                <div className="setting-label">Telegram 通道</div>
                <div className="setting-desc">推荐：手机装 Telegram，向 @BotFather 创建机器人拿到 token，再私聊机器人获取 chat_id</div>
              </div>
              <label className="switch">
                <input type="checkbox" checked={form.channels.includes('telegram')} onChange={() => toggleChannel('telegram')} />
                <span className="slider" />
              </label>
            </div>
            {form.channels.includes('telegram') && (
              <>
                <div className="setting-row">
                  <div>
                    <div className="setting-label">Telegram Bot Token</div>
                    <div className="setting-desc">{cfg.telegramBotTokenSet ? '✅ 已保存（留空表示不修改）' : '格式：123456789:AA…'}</div>
                  </div>
                  <input style={{ width: 240, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: "6px 8px" }} type="password" placeholder={cfg.telegramBotTokenSet ? '••••••••（已设置）' : '123456:ABC…'}
                    value={form.telegramBotToken} onChange={e => setForm({ ...form, telegramBotToken: e.target.value })} />
                </div>
                <div className="setting-row">
                  <div>
                    <div className="setting-label">Telegram Chat ID</div>
                    <div className="setting-desc">私聊 @userinfobot 或你的机器人可获取（如 123456789）</div>
                  </div>
                  <input style={{ width: 200, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: "6px 8px" }} value={form.telegramChatId}
                    onChange={e => setForm({ ...form, telegramChatId: e.target.value })} />
                </div>
              </>
            )}


            <div className="setting-row">
              <div>
                <div className="setting-label">Server酱（微信）通道</div>
                <div className="setting-desc">推荐给用微信的人：到 sct.ftqq.com 微信扫码登录拿 SendKey，即可推到个人微信</div>
              </div>
              <label className="switch">
                <input type="checkbox" checked={form.channels.includes('serverchan')} onChange={() => toggleChannel('serverchan')} />
                <span className="slider" />
              </label>
            </div>
            {form.channels.includes('serverchan') && (
              <div className="setting-row">
                <div>
                  <div className="setting-label">Server酱 SendKey</div>
                  <div className="setting-desc">{cfg.serverChanKeySet ? '✅ 已保存（留空表示不修改）' : '格式：SCTxxxxxx…（sct.ftqq.com 登录可见）'}</div>
                </div>
                <input style={{ width: 260, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: "6px 8px" }} type="password" placeholder={cfg.serverChanKeySet ? '••••••••（已设置）' : 'SCT…'}
                  value={form.serverChanKey} onChange={e => setForm({ ...form, serverChanKey: e.target.value })} />
              </div>
            )}

            <div className="setting-row">
              <div>
                <div className="setting-label">Webhook 通道</div>
                <div className="setting-desc">用于微信/钉钉/企业微信等自定义机器人 HTTP 推送</div>
              </div>
              <label className="switch">
                <input type="checkbox" checked={form.channels.includes('webhook')} onChange={() => toggleChannel('webhook')} />
                <span className="slider" />
              </label>
            </div>
            {form.channels.includes('webhook') && (
              <div className="setting-row">
                <div>
                  <div className="setting-label">Webhook 地址</div>
                  <div className="setting-desc">POST JSON：{ '{ event, data, text, ts }' }</div>
                </div>
                <input style={{ width: 260, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: "6px 8px" }} placeholder="https://…"
                  value={form.endpoint} onChange={e => setForm({ ...form, endpoint: e.target.value })} />
              </div>
            )}

            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={save}>保存配置</button>
              <button className="btn" onClick={test} disabled={testing}>{testing ? '发送中…' : '发送测试推送'}</button>
            </div>
          </>
        )}
      </div>

      <SessionTurns notify={notify} />

      <TempAlert notify={notify} />

      <div className="card">
        <h3>访问与安全</h3>
        <div className="setting-row">
          <div>
            <div className="setting-label">访问令牌</div>
            <div className="setting-desc">所有 /api 请求需携带 X-Access-Token 请求头。配置文件：config/config.json（server.token）</div>
          </div>
          <button className="btn sm danger" onClick={removeToken}>清除本地令牌</button>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">前端访问地址</div>
            <div className="setting-desc">本机: http://127.0.0.1:3081 ｜ 局域网: http://&lt;本机IP&gt;:3081</div>
          </div>
          <button className="btn sm" onClick={() => window.open('http://127.0.0.1:3081', '_blank')}>打开</button>
        </div>
      </div>
    </>
  );
}
