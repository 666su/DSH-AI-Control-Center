<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/English-495057?style=for-the-badge" alt="English"></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-0052CC?style=for-the-badge" alt="中文"></a>
</p>

# 🛰️ DSH AI Control Center — 个人 AI Agent 控制中心

一个运行在你自己电脑上的 **AI Agent 管理平台**：通过手机 / PC 网页实时查看 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）运行状态、系统资源（CPU / GPU / 显存 / 内存 / 磁盘）、任务执行情况与日志，并可直接给 DSH 发送新指令、暂停 / 继续 / 取消任务、一键重启 DSH——即使你人在外面。

| 项目 | 值 |
|---|---|
| 后端 | Node.js + Express（端口 **3081**） |
| 前端 | React + Vite（移动端 / PC 自适应，生产构建由后端直接托管） |
| 数据库 | SQLite（Node 内置 `node:sqlite`，零原生依赖） |
| 系统监控 | systeminformation + nvidia-smi（RTX GPU 支持） |
| 指令通道 | `dsh --profile headless "<指令>"`（DSH 官方 CLI 一次性会话，输出完整回传） |
| 守护进程 | `monitor.js` 每 30 秒巡检，DSH 掉线自动重启 |
| 通知 | Telegram / Server酱(微信) / Webhook 三通道真实推送：任务完成/失败、会话异常自动通知手机 |

> 👤 **作者：Jason** ｜ 📝 Blog: https://blog.20240606.xyz/ ｜ 🐙 GitHub: https://github.com/666su
> 本项目部署后，控制中心页面底部会显示作者署名（如需去除，见「品牌署名」一节）。

---

## 一、功能总览

1. **DSH 状态监控** — 运行 / 停止、启动时间、运行时长、PID、Web 端口、token 自动解析
2. **任务管理** — 发送指令创建任务（`DSH-001` 格式 ID），查看当前 / 历史任务，暂停 / 继续 / 取消，结果保存
3. **日志系统** — 实时日志（SSE 推送 + 轮询兜底）、DSH 日志自动采集入库（`logs` 表）、按来源 / 级别过滤
4. **手机控制** — 响应式界面 + 控制按钮：[继续执行] [暂停任务] [发送指令] [重启DSH]
5. **自动恢复** — `monitor.js` 每 30 秒检查 DSH 端口 + 进程，异常自动重启，记录 `logs/recovery.log`（企业级健康检测，见下文）
6. **通知推送** — Telegram / Server酱(微信) / Webhook 三通道；任务完成/失败、DSH 会话异常自动推送到手机（设置页可配）
7. **后台运行** — NSSM 服务化脚本（`scripts/install-service.bat`），开机自启、无 CMD 窗口

---

## 二、项目结构

``text
DSH-AI-Control-Center/            （项目根目录）
├── backend/
│   ├── server.js                   Express 入口（API + 托管前端构建产物）
│   ├── config.js                   配置加载（合并 config/config.json）
│   ├── api/                        路由：status / system / dsh / tasks / logs / monitor / notify / health
│   ├── services/
│   │   ├── dshService.js           DSH 进程检测、token 解析、启动 / 停止 / 重启、暂停 / 恢复
│   │   ├── taskRunner.js           headless 任务执行器（创建 / 状态 / 日志 / 控制）
│   │   ├── processControl.js       Windows 进程挂起 / 恢复（NtSuspendProcess）
│   │   ├── systemMonitor.js        CPU / GPU / 显存 / 内存 / 磁盘采样 + 历史落库
│   │   └── notifyService.js        通知 stub（log 优先）
│   ├── monitor/
│   │   ├── hub.js                  SSE 实时推送中心
│   │   └── logTailer.js            dsh.log 尾部采集 → logs 表
│   └── database/db.js              SQLite（node:sqlite）表结构 + 工具
├── frontend/
│   ├── src/                        React 源码（App / api / styles / pages / components）
│   ├── vite.config.js
│   └── package.json
├── monitor.js                      恢复守护进程（企业级健康检测 v2）
├── config/
│   └── config.example.json         配置模板（复制为 config.json 并填写）
├── scripts/                        启动 / NSSM 安装 / Cloudflare 辅助脚本
├── README.md                       英文 README（默认）
└── README.zh-CN.md                 中文 README
``

---

## 三、快速开始

### 前置条件
- Node.js ≥ 22.5（在 Node v24 上验证）
- DeepSeek Harness：`npx --yes @deepseek-ai/dsh web --no-open`（可先在另一个窗口启动）

### 1) 安装依赖（仅首次）
``bash
cd "你的项目目录"
cd backend  && npm install
cd ../frontend && npm install
cd ../frontend && npm run build     # 生成生产前端产物（后端直接托管）
``

### 2) 配置
把 `config/config.example.json` 复制为 `config/config.json`，按需填写（详见「配置说明」）。

### 3) 启动
``bash
cd backend
npm start        # 或 node server.js
``
- 控制中心: http://127.0.0.1:3081
- 首次启动会自动生成访问令牌并写入 `config/access-token.txt`；所有 `/api` 请求需带请求头 `X-Access-Token`（网页端在令牌页输入一次即可）。

### 4) 启动恢复守护进程（可选但推荐）
``bash
node monitor.js          # 每 30 秒巡检，DSH 挂了自动拉起
``

---

## 四、后台运行（开机自启，Windows 服务）

使用 **NSSM**（https://nssm.cc）把「后端」和「守护进程」注册为 Windows 服务。

1. 下载 nssm.exe，放到 `PATH` 或 `scripts/nssm.exe`（本仓库**不包含** nssm.exe 二进制）
2. 以**管理员**身份运行：
``bash
scripts\install-service.bat
``
3. 常用命令：
``bash
sc query DSHControlCenter        # 查看后端服务状态
sc query DSHControlMonitor       # 查看守护服务状态
nssm restart DSHControlCenter    # 重启服务
scripts\uninstall-service.bat    # 卸载
``

> 服务说明：
> - `DSHControlCenter`：运行 `node backend/server.js`，日志写入 `logs\backend-service.log`（LocalSystem）
> - `DSHControlMonitor`：运行 `node monitor.js`，日志写入 `logs\monitor-service.log`（LocalSystem）
> - DSH 本体建议用你的 `start-dsh.bat` 或另外的 NSSM 服务启动，注意命令里带 `--no-open` 并把输出重定向到 `dsh.log`（见「token 捕获」）。
>
> **DSH 服务化启停**：若 DSH 也用 NSSM 注册为 Windows 服务（如 `DeepSeekHarness`），在 `config.json` 的 `dsh` 段填 `"serviceName": "DeepSeekHarness"`，控制中心的启动 / 停止 / 重启按钮将自动改用 `net start` / `net stop`（而非 npx spawn）。`monitor.js` 恢复守护也会优先用 `net start` 拉起。留空则保持 npx 直接启动方式。

---

## 五、手机访问

### 方式 A：局域网（内网）
控制中心后端默认监听 `0.0.0.0:3081`，手机与电脑同一 WiFi 时，访问 `http://电脑局域网IP:3081` 即可。

### 方式 B：Cloudflare Tunnel（公网，推荐，无需公网 IP）
1. 在 Cloudflare Zero Trust 创建一个命名隧道，得到 tunnel token；
2. 编辑 `scripts\install-cloudflared.bat`，把 `YOUR_TUNNEL_TOKEN` 换成你的 token；
3. 运行脚本安装 `Cloudflared` 服务；
4. 在隧道里加一条 Public Hostname：子域名 `dsh` → `HTTP 127.0.0.1:3081`；
5. 浏览器访问 `https://dsh.YOUR_DOMAIN` 即可（控制中心会要求输入访问令牌）。

### 方式 C：DSH 原生 Web（3080）公网访问（受控制中心密码保护，推荐）
DSH 原生 Web 拥有全部操作能力（会话、工作区、智能体），**绝不能直接暴露到公网**（否则知道地址即可控制你的电脑）。正确做法是让 `dshui` 子域名先打到控制中心的**受保护代理**：

1. 在 Cloudflare 隧道里把子域名 `dshui` 指向 `HTTP 127.0.0.1:3081`（控制中心，**不是** 3080）；
2. 在 `config/config.json` 里配置：
   `dsh.proxyHosts` = [`dshui.YOUR_DOMAIN`]　(让该域名走代理)；
   `server.cookieDomain` = `.YOUR_DOMAIN`　(子域名共享登录 cookie)；
   `server.publicUrl` = `https://dsh.YOUR_DOMAIN`　(未登录时跳转控制中心登录页)；
3. 之后任何人访问 `https://dshui.YOUR_DOMAIN`，**必须先登录控制中心**（输入访问密钥），否则一律 302 跳转到登录页；DSH 本体保持只监听 127.0.0.1（无需 `--trusted-host` 公网域名）。

> 原理：控制中心收到 `dshui` 域名的请求后，校验控制中心登录 cookie（`cc_auth`），通过后以服务端 mint 的 DSH 认证 cookie 转发到 `127.0.0.1:3080`（Host 改写为 127.0.0.1 通过 DSH 浏览器信任墙）。DSH /api 只接受来自 127.0.0.1 的 Host，公网无法绕过控制中心直连。

---

## 六、控制中心 API 速览

所有 `/api` 请求需带 `X-Access-Token`（`/api/health` 除外）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 健康检查（免鉴权） |
| GET | /api/status | DSH + 系统综合状态 |
| GET | /api/dsh/status | DSH 详细状态（含 token、publicUrl） |
| POST | /api/dsh/start | 启动 DSH |
| POST | /api/dsh/stop | 停止 DSH |
| POST | /api/dsh/restart | 重启 DSH |
| POST | /api/dsh/control | 暂停 / 继续（pause / resume） |
| GET | /api/system/last | 最新系统指标 |
| GET | /api/system/history | 历史指标 |
| GET/POST | /api/tasks | 任务列表 / 创建任务 |
| POST | /api/tasks/:id/control | 暂停 / 继续 / 取消任务 |
| GET | /api/logs | 日志查询 |
| GET | /api/monitor/status | 恢复守护实时状态 |

---

## 七、配置说明（config/config.json）

⚠️ **部署前请务必把以下带 `YOUR_` 的占位符改成你自己的值。**

| 配置项 | 默认 / 占位 | 说明 |
|---|---|---|
| `server.port` | `3081` | 控制中心端口 |
| `server.host` | `0.0.0.0` | 监听地址（0.0.0.0 允许局域网访问） |
| `server.token` | 空 | 留空则自动生成并写入 access-token.txt |
| `dsh.port` | `3080` | DSH Web 端口 |
| `dsh.logFile` | `E:\YOUR_WORKSPACE\dsh.log` | ⚠️ DSH 日志文件绝对路径（token 解析依赖它） |
| `dsh.startCommand` | `npx --yes @deepseek-ai/dsh web --no-open` | ⚠️ 重启 / 守护拉起 DSH 的命令；公网暴露 DSH 时追加 `--trusted-host 你的域名` |
| `dsh.startCwd` | `E:\YOUR_WORKSPACE` | ⚠️ 启动 DSH 的工作目录 |
| `dsh.publicUrl` | 空 | 可选：DSH Web 的公网地址（手机直接开 DSH 用） |
| `dsh.userProfile` | `C:\Users\YOUR_USERNAME` | ⚠️ 你的 Windows 用户名目录（LocalSystem 拉起 DSH + 读取 DSH 凭证文件 `.dsh/.credentials.yaml` 提取 API Key 注入 headless 进程） |
| `tasks.defaultWorkspace` | `E:\YOUR_WORKSPACE` | ⚠️ 任务默认工作目录 |
| `server.cookieDomain` | 空 | ⚠️ 启用 DSH 代理时填 `.YOUR_DOMAIN`，让 dshui 子域名共享控制中心登录 cookie |
| `server.publicUrl` | 空 | ⚠️ 控制中心自身公网地址（未登录跳转用它，如 `https://dsh.YOUR_DOMAIN`） |
| `dsh.proxyHosts` | [] | ⚠️ 数组，填 DSH Web 公网子域名（如 [`"dshui.YOUR_DOMAIN"`]）即启用受保护代理；支持多个域名 |
| `dsh.serviceName` | 空 | 可选：NSSM 服务名（如 `DeepSeekHarness`）。填写后启停/恢复走 net start/stop，留空走 npx 直接启动 |
| `recovery.*` | 见模板 | 恢复策略（连续失败阈值 3、冷却 30/60/120s、熔断上限 3） |

---

## 八、数据与日志

| 路径 | 说明 |
|---|---|
| `logs\recovery.log` | 恢复守护结构化事件日志 |
| `logs\monitor-state.json` | 守护实时状态快照（/api/monitor/status 读取） |
| `logs\notify.log` | 熔断告警 |
| `backend\data\control-center.db` | SQLite 数据库（tasks / logs / system_stats / settings） |

---

## 九、自动恢复守护（v2 — 企业级健康检测）

### monitor.js 状态机
``text
OK ──(连续失败<3次)──→ DEGRADED（仅观察，不动作）
STARTING：进程存在但端口未就绪 = 启动中，绝不干预（宽限 90s）
ABNORMAL：连续失败 ≥3 次，才允许恢复
RECOVERING：指数冷却 30s/60s/120s 后再次尝试（上限 3 次）
HALTED：连续 3 次恢复失败 → 熔断，停止自动恢复 + CRITICAL 告警
``

### 健康检测（四项探测）
| 探测 | 说明 | 失败判定 |
|---|---|---|
| 进程 | node 进程匹配 dsh+web | 无进程 |
| 端口 | TCP 127.0.0.1:3080 | 连接失败 |
| HTTP | GET / 响应码 <500 | 超时/>=500 |
| 启动状态 | 进程存在但端口未就绪 | = STARTING（不处理） |

### 恢复策略（防暴力重启）
- 一次失败**不重启**：连续 3 次失败才判定 ABNORMAL
- 启动宽限 90s + 进程年轻(<30s)保护：**绝不 kill 刚拉起的进程**
- 指数冷却 30/60/120s + 熔断上限 3 次（HALTED 后等人工介入，DSH 恢复健康自动重新武装）

---

## 十、DSH token 捕获（重要）

DSH Web 的访问 token **每次启动随机生成、只打印到启动输出**，不落盘、无固定参数。控制中心靠解析 `dsh.log` 里的这一行拿到 token：
``text
dsh web: http://127.0.0.1:3080/?token=xxxx
``

> ⚠️ 经验教训：**不要用 Node `spawn` 的 stdio 流方式捕获子进程输出**（Windows 服务 LocalSystem 环境下会丢 token / 竞态报 `'stdio' is invalid`）。
> 正确做法是 **cmd 自身的文件重定向**（与 start-dsh.bat 一致）：
``js
const redirectCmd = startCommand + ' >> "' + logFile + '" 2>&1';
spawn('cmd.exe', ['/d', '/c', redirectCmd], { detached: true, stdio: 'ignore', env: buildSpawnEnv() });
``

**buildSpawnEnv()** 会注入用户环境（USERPROFILE / HOMEDRIVE / HOMEPATH / HOME / npm_config_cache / LOCALAPPDATA / APPDATA），来源是 `dsh.userProfile`。因为控制中心 / 监控服务跑在 LocalSystem，不注入的话 DSH 会去 systemprofile 找 .dsh（会话 / 历史「消失」）且 npx 缓存会重新下载。

---

## 十一、品牌署名

部署后的控制中心页面底部显示项目署名「© DSH AI Control Center · Open Source」。

- **保留署名**：无需任何操作（感谢支持 🙏）
- **去除 / 修改署名**：编辑 `frontend/src/App.jsx` 里的 `site-footer` 区块，然后 `npm run build` 重新构建前端

---

## 十二、许可证与作者

- License: [MIT](./LICENSE)
- 作者: **Jason**
- Blog: https://blog.20240606.xyz/
- GitHub: https://github.com/666su

---

## 附：部署前「需要自行更改」清单

1. ✅ `config/config.example.json` → 复制为 `config.json`，改 `dsh.logFile / startCwd / userProfile / defaultWorkspace`（所有 `YOUR_` 占位符）
2. ✅ `dsh.startCommand`：若公网暴露 DSH Web，追加 `--trusted-host 你的子域名.你的域名`
3. ✅ `scripts\install-cloudflared.bat`：替换 `YOUR_TUNNEL_TOKEN` 为你的 Cloudflare 隧道 token
4. ✅ 下载 `nssm.exe` 放到 `scripts`/（本仓库不含二进制）
5. ✅ （可选）`frontend/src/App.jsx` 页脚署名修改 / 去除
6. ✅ `dsh.proxyHosts`：若通过 DSH 子域名访问 DSH Web，填 `["dsh.YOUR_DOMAIN"]`（受控制中心密码保护）
7. ✅ `dsh.serviceName`：若 DSH 以 NSSM 服务运行，填 `"DeepSeekHarness"`（启停走 net start/stop）

## 模型选择

发送指令时可选择任意 DSH 支持的模型（免费/付费）：
- 不选 = 用 DSH 当前默认模型
- 选择后通过 `--patch` 临时覆盖 `agent-default-model`，任务结束后自动清理
- 免费模型标记 🆓，当前默认标记 ←
- 需设置 `dsh.userProfile` 才能读取 DSH 模型列表

