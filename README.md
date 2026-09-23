<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/English-0052CC?style=for-the-badge" alt="English"></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-495057?style=for-the-badge" alt="中文"></a>
</p>

# 🛰️ DSH AI Control Center — Personal AI Agent Control Center

A **self-hosted AI agent management platform** running on your own machine: monitor [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) status, system resources (CPU / GPU / VRAM / memory / disk), task execution and logs in real time from your phone or PC browser — and send new commands, pause / resume / cancel tasks, and restart DSH with one click, even when you're away.

| Component | Value |
|---|---|
| Backend | Node.js + Express (port **3081**) |
| Frontend | React + Vite (responsive mobile / PC, production build served by the backend) |
| Database | SQLite (Node built-in `node:sqlite`, zero native dependencies) |
| System monitoring | systeminformation + nvidia-smi (RTX GPU support) |
| Command channel | `dsh --profile headless "<command>"` (DSH official CLI one-shot session, full output returned) |
| Recovery daemon | `monitor.js` checks every 30 seconds, auto-restarts DSH if it goes down |
| Notifications | Telegram / Server酱 (WeChat) / Webhook channels: task completion/failure and session anomalies pushed to your phone |

> 👤 **Author: Jason** ｜ 📝 Blog: https://blog.20240606.xyz/ ｜ 🐙 GitHub: https://github.com/666su
> After deployment, the control center page footer shows the author signature (see the "Branding" section to remove it).

---

## 1. Feature Overview

1. **DSH Status Monitoring** — running / stopped, start time, uptime, PID, web port, automatic token parsing
2. **Task Management** — create tasks by sending commands (`DSH-001` style IDs), view current / historical tasks, pause / resume / cancel, save results
3. **Log System** — real-time logs (SSE push + polling fallback), automatic DSH log collection into the `logs` table, filter by source / level
4. **Mobile Control** — responsive UI with control buttons: [Continue] [Pause task] [Send command] [Restart DSH]
5. **Auto Recovery** — `monitor.js` checks the DSH port + process every 30 seconds, auto-restarts on anomalies, records `logs/recovery.log` (enterprise-grade health checks, see below)
6. **Notification Push** — Telegram / Server酱 (WeChat) / Webhook channels; task completion/failure and DSH session anomalies pushed to your phone (configurable in Settings)
7. **Background Operation** — NSSM service scripts (`scripts/install-service.bat`), auto-start on boot, no CMD window

---

## 2. Project Structure

``text
DSH-AI-Control-Center/            (project root)
├── backend/
│   ├── server.js                   Express entry (API + serves the frontend build)
│   ├── config.js                   Config loading (merges config/config.json)
│   ├── api/                        Routes: status / system / dsh / tasks / logs / monitor / notify / health
│   ├── services/
│   │   ├── dshService.js           DSH process detection, token parsing, start / stop / restart, pause / resume
│   │   ├── taskRunner.js           headless task executor (create / status / logs / control)
│   │   ├── processControl.js       Windows process suspend / resume (NtSuspendProcess)
│   │   ├── systemMonitor.js        CPU / GPU / VRAM / memory / disk sampling + history persistence
│   │   └── notifyService.js        Notification stub (log-first)
│   ├── monitor/
│   │   ├── hub.js                  SSE real-time push hub
│   │   └── logTailer.js            dsh.log tail collection → logs table
│   └── database/db.js              SQLite (node:sqlite) schema + utilities
├── frontend/
│   ├── src/                        React source (App / api / styles / pages / components)
│   ├── vite.config.js
│   └── package.json
├── monitor.js                      Recovery daemon (enterprise health check v2)
├── config/
│   └── config.example.json         Config template (copy to config.json and fill in)
├── scripts/                        Start / NSSM install / Cloudflare helper scripts
├── README.md                       English README (default)
└── README.zh-CN.md                 Chinese README
``

---

## 3. Quick Start

### Prerequisites
- Node.js ≥ 22.5 (verified on Node v24)
- DeepSeek Harness: `npx --yes @deepseek-ai/dsh web --no-open` (can be started in another window first)

### 1) Install dependencies (first time only)
``bash
cd "your-project-directory"
cd backend  && npm install
cd ../frontend && npm install
cd ../frontend && npm run build     # build production frontend (served by the backend)
``

### 2) Configure
Copy `config/config.example.json` to `config/config.json` and fill in as needed (see "Configuration Reference").

### 3) Start
``bash
cd backend
npm start        # or node server.js
``
- Control center: http://127.0.0.1:3081
- On first start, an access token is auto-generated and written to `config/access-token.txt`; all `/api` requests need the `X-Access-Token` header (enter it once on the token page in the web UI).

### 4) Start the recovery daemon (optional but recommended)
``bash
node monitor.js          # checks every 30 seconds, auto-relaunches DSH if down
``

---

## 4. Background Operation (auto-start on boot, Windows service)

Use **NSSM** (https://nssm.cc) to register the "backend" and "daemon" as Windows services.

1. Download nssm.exe and put it in `PATH` or at `scripts/nssm.exe` (the repository **does not include** the nssm.exe binary)
2. Run as **Administrator**:
``bash
scripts\install-service.bat
``
3. Common commands:
``bash
sc query DSHControlCenter        # check backend service status
sc query DSHControlMonitor       # check daemon service status
nssm restart DSHControlCenter    # restart service
scripts\uninstall-service.bat    # uninstall
``

> Service notes:
> - `DSHControlCenter`: runs `node backend/server.js`, logs to `logs\backend-service.log` (LocalSystem)
> - `DSHControlMonitor`: runs `node monitor.js`, logs to `logs\monitor-service.log` (LocalSystem)
> - It's recommended to start DSH itself with your `start-dsh.bat` or another NSSM service; include `--no-open` and redirect output to `dsh.log` (see "Token Capture").
>
> **DSH service-based start/stop**: if DSH is also registered as a Windows service via NSSM (e.g. `DeepSeekHarness`), set `"serviceName": "DeepSeekHarness"` in the `dsh` section of `config.json`, and the control center's start / stop / restart buttons will use `net start` / `net stop` instead of npx spawn. The `monitor.js` recovery daemon also prefers `net start`. Leave it empty to keep the npx direct-start method.

---

## 5. Mobile Access

### Method A: LAN (local network)
The control center backend listens on `0.0.0.0:3081` by default; when the phone and PC are on the same WiFi, visit `http://PC-LAN-IP:3081`.

### Method B: Cloudflare Tunnel (public, recommended, no public IP needed)
1. Create a named tunnel in Cloudflare Zero Trust and get the tunnel token;
2. Edit `scripts\install-cloudflared.bat` and replace `YOUR_TUNNEL_TOKEN` with your token;
3. Run the script to install the `Cloudflared` service;
4. Add a Public Hostname in the tunnel: subdomain `dsh` → `HTTP 127.0.0.1:3081`;
5. Visit `https://dsh.YOUR_DOMAIN` in a browser (the control center will ask for the access token).

### Method C: DSH native web (3080) public access (protected by the control center password, recommended)
DSH native web has full control capabilities (sessions, workspaces, agents) and **must never be exposed directly to the public** (otherwise anyone with the URL can control your computer). The correct approach: point the `dshui` subdomain to the control center's **protected proxy**:

1. In the Cloudflare tunnel, point subdomain `dshui` to `HTTP 127.0.0.1:3081` (control center, **not** 3080);
2. Configure in `config/config.json`:
   `dsh.proxyHosts` = [`dshui.YOUR_DOMAIN`]　(make this domain go through the proxy);
   `server.cookieDomain` = `.YOUR_DOMAIN`　(subdomains share the login cookie);
   `server.publicUrl` = `https://dsh.YOUR_DOMAIN`　(redirect to the control center login page when not logged in);
3. After this, anyone visiting `https://dshui.YOUR_DOMAIN` **must log into the control center first** (enter the access key), otherwise they get a 302 redirect to the login page; DSH itself keeps listening only on 127.0.0.1 (no `--trusted-host` public domain needed).

> How it works: when the control center receives a request for the `dshui` domain, it validates the control center login cookie (`cc_auth`), then forwards to `127.0.0.1:3080` with a server-minted DSH auth cookie (Host rewritten to 127.0.0.1 to pass DSH's browser trust fence). DSH /api only accepts a Host of 127.0.0.1, so the public can't bypass the control center to connect directly.

---

## 6. Control Center API Overview

All `/api` requests need the `X-Access-Token` header (`/api/health` excluded).

| Method | Path | Description |
|---|---|---|
| GET | /api/health | Health check (no auth) |
| GET | /api/status | Combined DSH + system status |
| GET | /api/dsh/status | Detailed DSH status (includes token, publicUrl) |
| POST | /api/dsh/start | Start DSH |
| POST | /api/dsh/stop | Stop DSH |
| POST | /api/dsh/restart | Restart DSH |
| POST | /api/dsh/control | Pause / resume (pause / resume) |
| GET | /api/system/last | Latest system metrics |
| GET | /api/system/history | Historical metrics |
| GET/POST | /api/tasks | List tasks / create task |
| POST | /api/tasks/:id/control | Pause / resume / cancel task |
| GET | /api/logs | Query logs |
| GET | /api/monitor/status | Recovery daemon real-time status |

---

## 7. Configuration Reference (config/config.json)

⚠️ **Before deployment, replace all `YOUR_` placeholders with your own values.**

| Key | Default / placeholder | Description |
|---|---|---|
| `server.port` | `3081` | Control center port |
| `server.host` | `0.0.0.0` | Listen address (0.0.0.0 allows LAN access) |
| `server.token` | empty | Leave empty to auto-generate and write to access-token.txt |
| `dsh.port` | `3080` | DSH web port |
| `dsh.logFile` | `E:\YOUR_WORKSPACE\dsh.log` | ⚠️ DSH log file absolute path (token parsing depends on it) |
| `dsh.startCommand` | `npx --yes @deepseek-ai/dsh web --no-open` | ⚠️ Command used to restart / daemon-relaunch DSH; append `--trusted-host your-domain` when exposing DSH publicly |
| `dsh.startCwd` | `E:\YOUR_WORKSPACE` | ⚠️ Working directory for starting DSH |
| `dsh.publicUrl` | empty | Optional: public URL of the DSH web (for opening DSH directly on mobile) |
| `dsh.userProfile` | `C:\Users\YOUR_USERNAME` | ⚠️ Your Windows user directory (used to launch DSH as LocalSystem + read the DSH credentials file `.dsh/.credentials.yaml` to inject API keys into headless processes) |
| `tasks.defaultWorkspace` | `E:\YOUR_WORKSPACE` | ⚠️ Default working directory for tasks |
| `server.cookieDomain` | empty | ⚠️ Set to `.YOUR_DOMAIN` when enabling the DSH proxy so the dshui subdomain shares the control center login cookie |
| `server.publicUrl` | empty | ⚠️ Public URL of the control center itself (used for login redirects, e.g. `https://dsh.YOUR_DOMAIN`) |
| `dsh.proxyHosts` | [] | ⚠️ Array of public subdomains for the DSH web (e.g. [`"dshui.YOUR_DOMAIN"`]) to enable the protected proxy; supports multiple domains |
| `dsh.serviceName` | empty | Optional: NSSM service name (e.g. `DeepSeekHarness`). When set, start/stop/recovery use net start/stop; leave empty for npx direct start |
| `recovery.*` | see template | Recovery policy (consecutive failure threshold 3, cooldowns 30/60/120s, circuit-breaker limit 3) |

---

## 8. Data and Logs

| Path | Description |
|---|---|
| `logs\recovery.log` | Structured event log of the recovery daemon |
| `logs\monitor-state.json` | Real-time daemon state snapshot (read by /api/monitor/status) |
| `logs\notify.log` | Circuit-breaker alerts |
| `backend\data\control-center.db` | SQLite database (tasks / logs / system_stats / settings) |

---

## 9. Auto-Recovery Daemon (v2 — enterprise health check)

### monitor.js state machine
``text
OK ──(consecutive failures <3)──→ DEGRADED (observe only, no action)
STARTING: process exists but port not ready = booting, never intervene (90s grace)
ABNORMAL: consecutive failures ≥3, recovery is allowed
RECOVERING: exponential cooldown 30s/60s/120s, then retry (max 3 attempts)
HALTED: 3 consecutive recovery failures → circuit breaker, stop auto-recovery + CRITICAL alert
``

### Health checks (four probes)
| Probe | Description | Failure condition |
|---|---|---|
| Process | node process matching dsh+web | no process |
| Port | TCP 127.0.0.1:3080 | connection failed |
| HTTP | GET / response code <500 | timeout/>=500 |
| Boot state | process exists but port not ready | = STARTING (no action) |

### Recovery strategy (prevents brute-force restarts)
- One failure does **not** restart: only 3 consecutive failures mark ABNORMAL
- 90s boot grace + young process (<30s) protection: **never kill a process that was just launched**
- Exponential cooldown 30/60/120s + circuit-breaker limit 3 (after HALTED, wait for manual intervention; DSH auto-rearms once healthy again)

---

## 10. DSH Token Capture (important)

The DSH web access token is **randomly generated at every startup and only printed to startup output** — not persisted, no fixed parameters. The control center obtains the token by parsing this line from `dsh.log`:
``text
dsh web: http://127.0.0.1:3080/?token=xxxx
``

> ⚠️ Lesson learned: **don't capture child process output via Node `spawn` stdio streams** (under a Windows service LocalSystem environment the token can be lost / race with a `'stdio' is invalid` error).
> The correct approach is **cmd's own file redirection** (same as start-dsh.bat):
``js
const redirectCmd = startCommand + ' >> "' + logFile + '" 2>&1';
spawn('cmd.exe', ['/d', '/c', redirectCmd], { detached: true, stdio: 'ignore', env: buildSpawnEnv() });
``

**buildSpawnEnv()** injects the user environment (USERPROFILE / HOMEDRIVE / HOMEPATH / HOME / npm_config_cache / LOCALAPPDATA / APPDATA), sourced from `dsh.userProfile`. Since the control center / monitor service run as LocalSystem, without this injection DSH would look in systemprofile for .dsh (sessions / history "disappear") and re-download the npx cache.

---

## 11. Branding

After deployment, the control center page footer shows the project credit 「© DSH AI Control Center · Open Source」.

- **Keep the credit**: nothing to do (thanks for your support 🙏)
- **Remove / modify**: edit the `site-footer` block in `frontend/src/App.jsx`, then `npm run build` to rebuild the frontend

---

## 12. License and Author

- License: [MIT](./LICENSE)
- Author: **Jason**
- Blog: https://blog.20240606.xyz/
- GitHub: https://github.com/666su

---

## Appendix: Pre-deployment "things to change" checklist

1. ✅ `config/config.example.json` → copy to `config.json`, change `dsh.logFile / startCwd / userProfile / defaultWorkspace` (all `YOUR_` placeholders)
2. ✅ `dsh.startCommand`: if exposing DSH web publicly, append `--trusted-host your-subdomain.your-domain`
3. ✅ `scripts\install-cloudflared.bat`: replace `YOUR_TUNNEL_TOKEN` with your Cloudflare tunnel token
4. ✅ Download `nssm.exe` and put it in `scripts`/ (binary not included in this repo)
5. ✅ (optional) modify / remove the footer credit in `frontend/src/App.jsx`
6. ✅ `dsh.proxyHosts`: if accessing the DSH web via a DSH subdomain, set `["dsh.YOUR_DOMAIN"]` (protected by the control center password)
7. ✅ `dsh.serviceName`: if DSH runs as an NSSM service, set `"DeepSeekHarness"` (start/stop via net start/stop)

## Model Selection

When sending commands, you can select any model supported by DSH (free/paid):
- Not selected = use DSH's current default model
- After selection, temporarily overrides `agent-default-model` via `--patch`, auto-cleaned after the task ends
- Free models are marked 🆓, current default marked ←
- Set `dsh.userProfile` to read the DSH model list

