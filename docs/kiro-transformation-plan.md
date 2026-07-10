# cursor2api → kiro 化改造计划

把 cursor2api（单账号 TS 代理）改造成对齐 kiro.rs 的**生产级多账号 + API 分发网关**。
路线已定：**在现有 TypeScript/Express 项目上原地扩展**（不重写 Rust）。

---

## 0. 背景与账号单位分析（已确认）

- cursor2api 上游是**匿名**的 `https://cursor.com/api/chat`（文档页免费 AI），无 OAuth。
  唯一门槛是 Vercel bot challenge，靠 **`_vcrcs` cookie + Chrome 指纹(UA)** 通过。
- 因此一个「账号」= **`{cookie, fingerprint, proxy?, stealthProxyUrl?}` 元组**。
  - 横向扩容 = 多份 `_vcrcs` cookie（每份由 stealth 浏览器 challenge 产出）。
  - cookie 若共用同一出口 IP 会被 Cursor **按 IP** 一起限流 → 池条目应绑定各自 proxy。
- 与 kiro.rs 的差异：kiro 池的是有配额的 OAuth 凭据；我们池的是匿名 cookie。
  所以**没有余额/配额刷新**概念，取而代之的是 **429/403 冷却 + 健康探测**。

## 1. 目标能力（对齐 kiro.rs，四块全做）

1. **多账号池 + 负载均衡/故障转移**：优先级/均衡调度、每账号并发上限、429/403 冷却、自动故障转移。
2. **客户端 Key 分发 + 用量统计**：对外发 `csk_` Key，按 Key 记录调用次数/token/最后使用时间，可禁用/轮换。
3. **Admin 管理后台 (UI+API)**：增删账号、管理客户端 Key、看用量、改配置（热更新）。
4. **账号分组 + 请求链路追踪**：Key 绑定账号子集（隔离），SQLite 记录每请求链路。

## 2. 现状关键耦合点（改造难点）

- **`getConfig()` 全局单例**：`cursor-client.ts` 直接读 `config.cookie / fingerprint / stealthProxy / proxy / timeout`。
  → 多账号必须把「选中的账号对象」从 handler 一路**下传**到 `sendCursorRequest*`。这是核心重构。
- **HTTP 状态被吞**：客户端把 429 等拼成 `Error("HTTP 429...")` 字符串。
  → 需引入**结构化错误**（携带 status code），让调度器区分 429/403（冷却+换号）与普通失败。
- 调用点：`handler.ts`(9)、`openai-handler.ts`(2)、`converter.ts`(6) 读 `getConfig()`；
  `sendCursorRequest`/`sendCursorRequestFull` 在 handler/openai-handler/续写逻辑中被多处调用。

## 3. 目标架构（新增模块）

沿用 kiro.rs 的模块切分与命名习惯，落到 TS：

```
src/
  accounts/
    account.ts          # CursorAccount 类型 + AccountManager（加载/持久化 accounts.json）
    scheduler.ts        # 调度：priority/balanced 选号、并发槽、冷却、故障转移
  client-keys/
    client-key.ts       # ClientKey 类型 + ClientKeyManager（csk_ 生成/校验/用量累计, client-keys.json）
  groups/
    group.ts            # GroupManager（分组注册表 groups.json + 改名/删除级联）
  admin/
    admin-api.ts        # /api/admin/* REST 路由（账号/Key/分组/配置/用量/trace）
    admin-auth.ts       # adminApiKey 鉴权中间件（常量时间比较）
    admin-ui.ts         # 静态 Admin 页面服务（复用 log-viewer 的 serve 模式）
  usage/
    usage-recorder.ts   # 按 账号/Key 维度累计用量，写 SQLite（扩展 logger-db）
public/admin/           # Admin 前端（单页，vanilla 或复用现有 Vue 工具链）
```

**两层 Key 模型**（对齐 kiro 的 ksk_/csk_）：
- 上游 = `CursorAccount`（cookie 元组），存 `accounts.json`。
- 下游 = `ClientKey`（`csk_` 明文），存 `client-keys.json`，按 Key 计量。

**CursorAccount 字段**（借鉴 kiro `KiroCredentials` + `ClientKey` 统计）：
```
id, name, cookie, fingerprintUA?, proxy?, stealthProxyUrl?,
priority (数字, 越小越优先), disabled, group?,
maxConcurrency (默认取全局), // 运行时状态：
cooldownUntil?, consecutiveFailures, inFlight,
totalCalls, totalInputTokens, totalOutputTokens, lastUsedAt, createdAt
```

**ClientKey 字段**（直接照搬 kiro `ClientKey` 精简版）：
```
id, key(csk_明文), name, description?, disabled, group?,
createdAt, lastUsedAt, totalCalls, totalInputTokens, totalOutputTokens,
isSystem (由旧 authTokens/首启 bootstrap 生成, 不可删)
```

## 4. 调度器设计（scheduler.ts）

对齐 kiro `token_manager` 的核心语义（简化版，无余额）：
- **候选过滤**：`!disabled && (cooldownUntil==null || now>cooldownUntil) && group 匹配`（Key 绑定分组时严格隔离）。
- **选号策略**（config `load_balancing_mode`）：
  - `priority`：按 priority 升序，同级取 inFlight 最小。
  - `balanced`：取 inFlight 最小（P2C：随机两个取更空闲的）。
- **并发槽**：每账号 `inFlight < maxConcurrency` 才可选；满载时按 `account_acquire_blocking` 决定等待或快速失败。
- **故障转移**：调用抛出结构化错误时：
  - 429/403 → 该账号 `cooldownUntil = now + cooldown_secs`，换下一个候选重试。
  - 其它瞬态错误 → `consecutiveFailures++`，超阈值临时冷却；换号重试。
  - 全部候选耗尽 → 返回 503「池忙/全部冷却」。
- **重试预算**：新增 config `max_account_failover`（默认 = min(账号数, 3)）。

## 5. 请求生命周期改造

```
请求 → adminAuth?（/api/admin） 或 clientKeyAuth（/v1/*）
     → clientKeyAuth: 校验 csk_，拿到 keyId + group，挂到 req
     → handler: convertToCursorRequest（不变）
     → scheduler.acquire(group) → 选中 account + 占并发槽
     → sendCursorRequest(cursorReq, account, onChunk)   // ★ 新增 account 参数
        ├─ 成功 → 释放槽, usageRecorder.record(account, key, tokens)
        └─ 结构化错误 → 释放槽 + 冷却/失败计数 → scheduler 再选号重试
     → trace/usage 落库（扩展现有 logger）
```

- `getChromeHeaders()` 改为 `getChromeHeaders(account)`：cookie/UA/proxy 从 account 取，回退全局。
- `clientKeyAuth` 替换现有 `authTokens` 中间件；旧 `authTokens` 首启迁移为 `isSystem` 客户端 Key。

## 6. Admin API 面（对齐 kiro `/api/admin/*`，精简）

```
GET    /api/admin/accounts                 列表(脱敏 cookie)
POST   /api/admin/accounts                 新增(粘贴 cookie 或 触发 stealth 取号)
DELETE /api/admin/accounts/:id
POST   /api/admin/accounts/:id/disabled    启用/禁用
POST   /api/admin/accounts/:id/priority
POST   /api/admin/accounts/:id/clear-cooldown
POST   /api/admin/accounts/:id/proxy       绑定/换代理
GET    /api/admin/accounts/:id/health      主动探测(发一次轻量请求)

GET    /api/admin/client-keys              列表(脱敏)
POST   /api/admin/client-keys              新建(返回明文一次)
DELETE /api/admin/client-keys/:id
POST   /api/admin/client-keys/:id/disabled
POST   /api/admin/client-keys/:id/rotate
POST   /api/admin/client-keys/:id/reset-stats

GET/PUT /api/admin/groups                  分组增删改(级联改名/清空)
GET/PUT /api/admin/config                  负载均衡模式/冷却/并发等运行时配置(热更新)
GET     /api/admin/stats                   汇总用量
GET     /api/admin/traces                  请求链路(复用 logger-db)
```
- 鉴权：新增 config `admin_api_key`（空=禁用 Admin），常量时间比较。

## 7. 持久化与迁移（向后兼容，零破坏）

- 新增文件（与现有 config 同目录）：`accounts.json`、`client-keys.json`、`groups.json`。
- **首启迁移**（幂等，仿 kiro `ensure_system_key` / `bootstrap_from_existing`）：
  - `config.yaml` 里的 `cookie` → 迁移为 `accounts.json` 第一条账号（`priority=0`）。
  - `config.yaml` 里的 `authTokens[]` → 每条迁移为 `isSystem` 客户端 Key（不可删）。
  - 迁移后旧字段仍可读，老部署升级不需要改任何配置即可运行（单账号退化为 1 条池）。
- 用量/trace 复用现有 `logger-db.ts`（better-sqlite3），新增 `account_id`/`client_key_id` 列。

## 8. Admin 前端

- 最小可用单页（`public/admin/`），复用 `log-viewer.ts` 的静态服务 + `serveLogViewerLogin` 登录模式。
- 页面：账号池（卡片：状态/并发/冷却/用量）、客户端 Key、分组、配置、用量总览、trace。
- 技术选型：先做 vanilla/单文件版（最快落地）；后续可选升级到 Vue（项目已有 vue-ui 工具链）。

## 9. 分阶段实施顺序（每阶段可独立编译运行）

- **P1 客户端解耦**：`sendCursorRequest*` 加 `account` 参数；`getChromeHeaders(account)`；引入 `CursorError{status}` 结构化错误。account 暂用「从全局 config 造的单条」占位 → 保证行为不变、可编译。
- **P2 账号池 + 调度**：`account.ts`+`scheduler.ts`+`accounts.json`；handler 接入 acquire/release + 故障转移；首启迁移 cookie。
- **P3 客户端 Key 层**：`client-key.ts`+`client-keys.json`；`clientKeyAuth` 替换 authTokens；迁移旧 token；接 usage 累计。
- **P4 分组 + trace**：`group.ts`+`groups.json`；Key→账号子集隔离；trace 挂 account_id/key_id。
- **P5 Admin API**：`admin-api.ts`+`admin-auth.ts`，全部 REST 端点。
- **P6 Admin UI**：`public/admin/` 单页 + 路由挂载。

## 10. 测试与验收

- 每阶段：`npm run build` 通过 + 单账号回归（现有 Claude Code / OpenAI 流程不变）。
- P2 后：注入 2+ cookie，构造 429 验证冷却+故障转移；并发压测验证并发槽。
- P3 后：`csk_` 鉴权通过/拒绝；用量按 Key 正确累计。
- P5/P6：Admin 增删账号/Key、改配置热生效、脱敏正确、adminApiKey 鉴权。
- 安全：cookie/Key 列表接口脱敏；常量时间比较；Admin 与 /v1 鉴权隔离。

## 11. 待确认/风险

- **取号自动化**：P2 的「触发 stealth 取号」依赖现有 `stealth-proxy/`。是否要在 Admin 里一键起 stealth 容器取 cookie，还是先只支持手动粘贴 cookie？（建议 P2 先手动粘贴，取号自动化作为 P2.5 增量）
- **代理池**：kiro 有独立 proxy-pool + 轮询分配。是否需要？（建议先做「账号绑定单个 proxy」，代理池作为后续增量）
- **在线自更新 / OAuth 登录**：kiro 有，但对匿名 cursor 场景无意义，**不做**。
