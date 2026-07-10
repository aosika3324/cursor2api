# Admin 后台 v2 —— 对齐 kiro.rs 完整度

在已上线的多账号版(P1–P6)基础上,补齐 kiro.rs 级别的运维能力。四块需求:
运维检测、批量账号管理、完整代理池、链路追踪+用量合并成「日志」。

已确认范围:**完整代理池(仿 kiro)** / **账号探测 + 系统探测** / **批量导入+校验+编辑+删除+重置** / **trace+用量合并**。

---

## 现状可复用点(已探明)

- `sendCursorRequest(req, onChunk, signal, account)` 的**显式账号路径**(`legacyAttempt`)天然适合健康探测:传入某账号连接、发一个最小请求、测活性/延迟。
- 每账号已有 `proxy` 字段;`proxy-agent.getProxyFetchOptionsFor(url)` 已支持按 URL 建 dispatcher。
- stealth-proxy `GET /health` 返回 `{status: ok|initializing, cookie, challengeCount, ...}` → 系统探测直接用。
- `getRequestSummariesPage({limit,before,status,keyword,since})` 已做**分页+过滤+statusCounts**;P4/P5 已给 trace 加 `account_id/client_key_id` 列 → 「日志」页直接复用。
- kiro 的 proxy 池持久化为 `proxy_pool.json`,`ProxyEntry{url,enabled,health,latency_ms,last_checked_at}` → 直接照搬形状。

---

## 后端改动

### A. 健康探测 `src/admin/health.ts`(新)
- `probeAccount(account)`:构造最小 `CursorChatRequest`(1 条 user "ping"、model 取 config.cursorModel),经显式账号路径发出,`Promise.race` 加 ~15s 超时;返回 `{ok, latencyMs, status?, error?}`。命中 429/403 → 标记限流;成功 → 可选顺带 `recordSuccess`。
- `probeSystem()`:① `GET {STEALTH_PROXY}/health` 读 stealth 就绪+challengeCount+cookie 状态;② 直连/经代理 `HEAD https://cursor.com` 测上游可达性+延迟;③ 汇总 `poolStatus()`(总/可用/冷却/满载)。
- 不改调度器;探测是旁路只读(除可选 recordSuccess/Failure)。

### B. 代理池 `src/proxies/proxy.ts`(新,镜像 AccountManager 写法)
- `proxies.json` 原子落盘(已在 .gitignore 规划内,补 `proxies.json`)。
- `ProxyEntry { id, url, enabled, health: 'unknown'|'healthy'|'unhealthy', latencyMs?, lastCheckedAt?, note? }`。
- API:list/add/batchAdd(多行粘贴)/delete/setEnabled/check(单个)/checkAll(并发探测)/assignRoundRobin(把启用且健康的代理轮询分配到账号的 `proxy` 字段)。
- `checkProxy`:经该代理 `HEAD https://cursor.com`(或 stealth /health)测延迟与连通,写回 health/latency。

### C. Admin API 扩展 `src/admin/admin-api.ts`
账号:
- `POST /accounts/:id/health` 单账号探测
- `POST /accounts/batch-health` 批量探测(body: ids[] 或全部)
- `POST /accounts/batch-import` 多行 cookie 导入(body: `{text, group?, priority?, proxy?}`,每行一账号)
- `PATCH /accounts/batch` 批量编辑(body: `{ids[], patch:{group?/proxy?/disabled?/priority?}}`)
- `POST /accounts/batch-delete`(body: ids[])
- `POST /accounts/batch-reset`(清零用量/失败计数/冷却)
代理池:
- `GET/POST /proxies`、`POST /proxies/batch`、`DELETE /proxies/:id`、`POST /proxies/:id/enabled`、`POST /proxies/:id/check`、`POST /proxies/check-all`、`POST /proxies/assign-round-robin`
系统:
- `GET /health/system` 系统探测汇总
日志(合并):
- `GET /logs`(复用 `getRequestSummariesPage` + 现有 `account_id/client_key_id` 过滤)返回分页 summaries(含 in/out token、账号、key、状态)、statusCounts、聚合用量。
- `GET /logs/:requestId` 单条 payload(复用 `dbGetPayload`)。
- 保留 `/stats`(概览卡片:池状态 + DB 聚合)。**移除 `/traces`**(并入 `/logs`)。

### D. 账号统计字段补充
- `probeAccount` 结果落到账号:新增 `lastProbeAt?/lastLatencyMs?/lastProbeOk?`(持久化,前端展示健康列)。

---

## 前端重构 `public/admin/`(vanilla 单页,不引框架)

Tab 结构改为:**概览 · 账号池 · 客户端 Key · 代理池 · 分组 · 日志 · 设置**
(把原「链路追踪」「用量」合并进「日志」+「概览」。)

- **概览**:系统探测卡片(stealth 就绪/上游可达/延迟)+ 池状态 + 今日用量聚合 + 一键「全部探测」。
- **账号池**:卡片增加健康徽章(健康/限流/冷却/未知 + 延迟);顶部批量工具条(全选、批量探测/编辑/删除/重置);「批量导入」弹窗(多行 cookie textarea);单账号「探测」「编辑(含 proxy 下拉/手填)」。
- **代理池**(新):表格(url/状态/延迟/启停),批量添加、检测全部、轮询分配到账号。
- **日志**(合并):分页表格(时间/模型/状态/下游 Key/上游账号/in-out token),状态+关键字过滤,点击展开单条 payload;顶部 statusCounts + 用量小计。
- **设置**:负载均衡模式、冷却/并发/故障转移阈值、全局代理(经 `/config` 热更新);Admin Key 说明。

---

## 分阶段(每阶段可编译+冒烟)

- **S1 健康探测**:health.ts + `/accounts/:id/health`、`/accounts/batch-health`、`/health/system`;账号加探测字段。前端:概览系统卡 + 账号健康徽章 + 单个探测。
- **S2 批量账号**:batch-import/batch(edit)/batch-delete/batch-reset 端点 + 前端批量工具条与导入弹窗。
- **S3 代理池**:proxy.ts + proxies.json + 全套 `/proxies/*` + 前端代理池 tab + round-robin 分配 + 每账号 proxy 编辑。
- **S4 日志合并**:`/logs` + `/logs/:id`,前端「日志」tab(替代 traces/stats 两个 tab),移除 `/traces`。
- **S5 前端整体重构**:七 tab 布局收敛、概览页、设置页热更新配置。

每阶段:本地 `npm run build` + 关键逻辑单测(健康探测超时、批量导入解析、代理轮询、日志分页过滤)进 `test:all`;完成后再走 fork→服务器 pull→rebuild 的既有部署链。

## 兼容与安全
- 全部新增端点在 `adminAuth` 之下;代理/cookie 在列表接口继续脱敏。
- `proxies.json` 加入 .gitignore(可能含带账密的代理 URL)。
- 探测为旁路,不改调度主链路;stealth 模式下账号池空时,账号探测无对象但系统探测正常。
- 部署沿用 `data/` 卷:`proxies.json` 也用 `PROXIES_FILE=/app/data/proxies.json` 持久化。
