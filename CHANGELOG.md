# 更新日志

所有重要变更记录于此文件。日期为本地时间（北京时间）。

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
