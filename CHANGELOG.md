# 更新日志

所有重要变更记录于此文件。日期为本地时间（北京时间）。

---

## v1.3.0 — 2026-09-23

### 🆕 新功能

#### GPU / CPU 独立温度指标卡
- GPU 温度从「显存 VRAM」卡副标题中拆出，成为独立指标卡；新增 **CPU 温度** 卡（未接入时提示「需启动 LibreHardwareMonitor」）
- 温度卡按阈值分级着色：<阈值-10 绿、阈值-10~阈值 黄、≥阈值 红，一眼识别高温
- 显存卡不再兼任温度显示，只保留「已用 / 总量」

#### 温度历史入库与趋势曲线
- `system_stats` 表新增 `gpu_temp` / `cpu_temp` 两列（热迁移，旧数据对应字段为 NULL）
- `GET /api/system/history` 返回温度字段；前端新增 **零依赖内联 SVG 趋势图**（1h / 6h / 24h 切换），无需引入第三方图表库
- 采用**分桶取最大值**降采样：温度是尖峰指标，取平均会抹掉真正的高温瞬间，峰值保留才能定位问题

#### 高温告警（可走已有通知通道）
- 新增 `monitor.tempAlert` 配置：`enabled`、`gpuC`（默认 80）、`cpuC`（默认 90）、`hysteresisC`（默认 3）、`repeatMs`（默认 30 分钟）
- 告警策略：首次超阈值推 1 次 → 持续高温每 30 分钟最多提醒 1 次 → 降到「阈值 - 迟滞」以下再推 1 次恢复通知；3°C 迟滞防止阈值附近反复抖动刷屏
- 接入已有通知通道（Telegram / Server酱 / Webhook），事件 `temp.high` / `temp.recovered`
- 内存状态机：控制中心重启后重新武装，不补推历史告警

#### LibreHardwareMonitor 一键启用脚本
- 新增 `scripts/enable-temp-monitor.bat`（双击即可）：
  - 自动提权（非管理员时弹 UAC 重启自己，无需右键）
  - 配置 LHM 开启本地 Web Server（仅 `127.0.0.1:8085`，不暴露到网络）
  - 补 hosts 本机名条目（LHM 校验绑定 IP 是否属于本机，否则退化成监听全部网卡）
  - 注册开机自启计划任务（AtLogOn + 最高权限）并立即启动
  - 重启 `DSHControlCenter` 服务使新代码生效
  - 端到端自检并打印 LHM / 后端 / GPU 温度 / CPU 温度

### 🐛 Bug 修复

#### CPU 温度始终为 null
- **根因**：`cpuTemp.js` 依赖 LHM 的 `HardwareId` 判断「是否属于 CPU 硬件」，但实际输出的传感器节点 `HardwareId` 为空，导致全部 50 个温度传感器被跳过
- **修复**：改为按传感器名称启发式识别（`Core Max`、`Core Average`、`CPU Package`、`P-Core #N`、`E-Core #N` 为 CPU；排除 `GPU Core`、`DIMM #0`、`Temperature #1` 等非 CPU 传感器），`HardwareId` 保留作为兜底

#### 启用脚本双击闪退、零输出
- **根因**：`enable-temp-monitor.bat` 用 LF 换行，Windows `cmd.exe` 解析含括号块和 `^` 续行的批处理**必须 CRLF**，导致解析阶段直接失败
- **修复**：bat 精简为 3 行引导，全部逻辑移到 `enable-temp-monitor.ps1`（CRLF）；计划任务改用 PowerShell `Register-ScheduledTask`（比 `schtasks.exe` 可靠）；每步 `try/catch` 加状态输出，失败不中断

### 🔒 安全清理
- 移除 `enable-temp-monitor.ps1` 里硬编码的计算机名（`yangyang`），改用 `$env:COMPUTERNAME` 运行时获取，既通用也不泄露机器名
- 脚本里 `userId` 从运行时 `$env:USERDOMAIN\\$env:USERNAME` 获取，不留硬编码账户名

### 📝 配置变更
- `backend/config.js` / `config/config.example.json` 新增：`monitor.tempAlert`（告警阈值/迟滞/节流）、`lhm`（接口地址与超时）
- 升级建议：若使用 LHM 采集 CPU 温度，确保 `scripts/enable-temp-monitor.bat` 已运行（需管理员权限）

---


## v1.2.0 — 2026-09-22

### 🐛 Bug 修复

#### 代理 POST 请求体丢失（核心修复）
- **现象**：DSH 界面能打开、工作区列表能显示，但会话列表为空、点击「添加对话」无反应，浏览器 Console 全是 `ERR_CONNECTION_CLOSED`
- **根因**：`server.js` 中 `express.json()` 注册在代理中间件**之前**，会把所有 `application/json` 的 POST 请求体消费掉；代理再 `req.pipe(proxyReq)` 转发时请求体已空，但 `content-length` 头仍是 184 → DSH 永远等不到 body → 不响应
- **修复**：代理中间件移到 `express.json()` **之前**注册；代理域名请求直接转发（请求体完整），其他请求照常走 body 解析。GET 请求无请求体所以一直正常——这正是「页面能显示但对话失效」的原因

#### WebSocket 升级 403 forbidden
- **现象**：DSH 前端左下角一直「连接中」，WS 升级返回 `403 forbidden`
- **根因**：DSH 的 `isTrustedApiRequest` 校验 `Origin` 头是否在 `--trusted-host` 白名单；公网域名不在列表即拒绝。代理转发时把浏览器原始 `Origin: https://公网域名` 原样带给 DSH
- **修复**：转发 WS 升级头时剥离 `origin`（DSH 在 `Origin` 缺失时视为可信）；HTTP 代理同步剥离 `origin`、`sec-fetch-site`

#### API 返回 400（content-length 被剥离）
- **根因**：`HOP_BY_HOP` 逐跳头集合里包含 `content-length`，转发请求时一并剥离，导致 POST 请求体长度信息丢失，DSH 收到不完整 body 返回 400
- **修复**：从 `HOP_BY_HOP` 移除 `content-length`（逐跳头不应包含它）

#### 响应头 keep-alive 导致 ERR_CONNECTION_CLOSED
- **根因**：代理把 DSH 响应的 `connection: keep-alive`、`keep-alive: timeout=5` 原样转发给浏览器，但代理自身在响应结束后关闭连接，浏览器按 keep-alive 等待后续数据 → `ERR_CONNECTION_CLOSED`
- **修复**：转发响应时仅剥离 `connection` 和 `keep-alive`（逐跳头），保留 `transfer-encoding` 让 Node 正确处理 chunked 流式响应

#### DSH 重启后代理用过期 cookie
- **根因**：`mintDshCookie()` 仅在 token 变化时重新 mint，DSH 重启（token 不变但 cookie 失效）后仍返回旧缓存 cookie
- **修复**：缓存加 5 秒 TTL（`CACHE_TTL_MS`）；未获取到新 cookie 时清空缓存

### 🔒 安全清理

- 代理调试日志不再输出 cookie 值：`mintDshCookie` 只记录 cookie 名；WS 转发头日志剥离 `cookie` 字段；HTTP 转发日志不再打印 cookie 片段
- 非代理域名检测改用 `config.server.cookieDomain`（运行时配置），不再硬编码任何域名

### 🚀 增强

#### NSSM 服务化启停（可选）
- 新增 `dsh.serviceName` 配置项（如 `DeepSeekHarness`）；填写后 `start()/stop()/restart()` 与 `monitor.js` 恢复拉起均走 `net start/stop`，彻底解决服务环境下 npx 重新下载 / 找不到用户主目录的问题
- 留空则保持原有 npx 直接启动方式，向后兼容
- `restart()` 在服务模式下执行 `net stop` → 等端口释放 → 5 秒缓冲（NSSM 完全停止需要时间）→ `net start`

#### 多代理域名支持
- 新增 `dsh.proxyHosts`（数组），与旧 `dsh.proxyHost`（单值）二选一；数组优先
- `server.js` 构建 `PROXY_HOSTS` Set，匹配任意配置的代理域名

#### WebSocket 升级代理增强
- `server.js` 改用 `http.createServer(app)` 显式持有 server 对象，确保 `upgrade` 事件被可靠捕获
- WS 代理新增非 101 响应处理（收集 body 用于诊断后关闭）、10 秒超时、详细日志

#### 调试端点
- 新增 `GET /api/debug/proxy` 返回代理配置（proxyHosts、accessToken 状态脱敏为 `***set***`），排查代理链路
- `/api` 鉴权放行 `/health` 与 `/debug/`

### 📝 配置变更

- `config.js` / `config.example.json` 新增：`dsh.proxyHosts`（数组）、`dsh.serviceName`（字符串）
- 升级建议：若以 NSSM 服务部署，在 `config.json` 的 `dsh` 段填 `"serviceName": "DeepSeekHarness"`

---

## v1.1.0 — 2026-09-21

### 🆕 新功能

#### 任务级模型选择
- 新增 `GET /api/tasks/models` 端点，从 DSH 设置文件（`~/.dsh/settings.yaml`）实时读取全部可用模型
- 任务页新增**两级模型选择器**：先选 API 提供商，再选该提供商下的具体模型
- 模型列表自动标记 🆓 免费 / 💰 付费 / ← 当前默认，方便区分计费方式
- 选择模型后通过 `--patch` 临时覆盖 DSH 的 `agent-default-model`，任务结束自动清理临时文件
- 不选则使用 DSH 当前默认模型
- `tasks` 表新增 `model` / `provider` 列，任务详情显示所用模型

#### 凭证注入修复（headless 任务）
- 控制中心以 LocalSystem 身份派发 headless 任务时，DSH 找不到用户目录下的 `.credentials.yaml`，报 `MISSING_CREDENTIAL`
- 新增 `credentials.js`：读取 `~/.dsh/.credentials.yaml` 提取全部 API Key + 注入用户环境变量（HOME / USERPROFILE 等），headless 进程不再缺失凭证

### 🐛 Bug 修复

#### 内存显示 0.0GB
- `fmtGb()` 设计用于 MB 值（`mb / 1024`），但内存 API 返回的 `usedGb` 已经是 GB，重复除以 1024 导致显示 0.0GB
- 新增 `fmtGbVal()` 直接格式化 GB 值，内存用量与总量恢复正常显示

#### 移动端打不开 DSH
- `Dashboard.jsx` 的 `openUrlFor()` 缺少 `proxyUrl`，按钮回退到 `http://127.0.0.1:3080`，手机无法访问
- `App.jsx` 登录 cookie 只在重新登录时种下，已登录设备（localStorage 令牌）无 cookie，被代理 302 弹回
- 修复：`openUrlFor` 优先 `proxyUrl`；应用加载时调用 `authSession()` 刷新 cookie

#### 恢复守护熔断（连续失败 19 次）
- DSH 冷启动约需 64 秒，但恢复守护启动等待超时仅 60 秒 → 每次等到 60 秒判失败、杀掉、重启 → 循环 19 次触发熔断
- 修复：`dshService.js` 启动等待循环 60s → **180s**；`config` 的 `launchWaitMs` 60s→180s、`bootGraceMs` 90s→180s、`maxAttempts` 3→5
- 熔断状态文件 `logs/monitor-state.json` 可手动重置

#### dsh.log 时间不一致
- 控制中心写 dsh.log 的行用 `nowIso()`（UTC ISO，带 Z），与本地时间差 8 小时
- 新增 `localTs()` 输出本地实时时间（`YYYY-MM-DD HH:mm:ss`），与 DSH 自身输出对齐

### 🔒 安全清理（开源版）
- 移除所有个人信息：API Key、Access Token、DSH Token、域名、用户名
- 配置文件全占位符（`YOUR_DOMAIN` / `YOUR_USERNAME`）
- 保留作者署名：Jason ｜ GitHub: https://github.com/666su ｜ Blog: https://blog.20240606.xyz/

---

## v1.0.0 — 2026-09-20

### 初始发布

#### 核心功能
- 🛰️ **DSH 状态监控** — 运行/停止、PID、端口、运行时长、token 自动解析
- 📊 **系统资源监控** — CPU / GPU 利用率、显存、内存、磁盘（systeminformation + nvidia-smi）
- 📝 **任务管理** — 发送指令（`dsh --profile headless`）、暂停/继续/取消、日志查看、结果保存
- 📋 **日志系统** — 实时日志流、分级筛选、WebSocket 推送
- 📱 **移动端适配** — 响应式布局，手机/PC 自适应

#### 运维能力
- 🔄 **自动恢复** — `monitor.js` 每 30 秒巡检，DSH 掉线自动重启，指数冷却
- 🛡️ **安全反向代理** — DSH 不直接暴露公网，经控制中心校验登录后转发（`dshProxy.js`）
- 🔔 **通知推送** — Telegram / Server酱(微信) / Webhook 三通道：任务完成/失败、会话异常自动通知
- 🏷️ **会话异常识别** — 上下文超限、API Key 失效、速率限制等自动归类并推送
- ⚙️ **NSSM 服务化** — 一键安装为 Windows 服务（DeepSeekHarness / DSHControlCenter / DSHControlMonitor）

---

> 维护者：Jason ｜ [GitHub](https://github.com/666su) ｜ [Blog](https://blog.20240606.xyz/)