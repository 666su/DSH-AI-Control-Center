import React, { useState, useEffect } from 'react';
import { api, getToken } from '../api.js';

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
