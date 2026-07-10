/**
 * admin/admin-api.ts - Admin REST API（P5）
 *
 * 挂载在 /api/admin/*，全部经 adminAuth 保护。提供：
 *  - accounts    账号池 CRUD + 启停 / 清冷却
 *  - client-keys 下游 key CRUD + 启停（明文 key 仅创建时返回一次）
 *  - groups      分组 CRUD（改名/删除级联由 GroupManager 保证）
 *  - config      复用现有 apiGetConfig / apiSaveConfig
 *  - stats       池状态 + DB 统计
 *  - traces      链路追踪查询（按 account/key/status 过滤）
 *
 * 脱敏原则：列表/详情绝不回传完整 cookie 或完整 key（见 redact*）。
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { CursorAccount, ClientKey } from '../types.js';
import {
    listAccounts, getAccount, addAccount, updateAccount, deleteAccount,
    setDisabled as setAccountDisabled, clearCooldown, resetStats,
} from '../accounts/account.js';
import { poolStatus } from '../accounts/scheduler.js';
import {
    listClientKeys, getClientKey, addClientKey, updateClientKey, deleteClientKey,
    setDisabled as setKeyDisabled,
} from '../keys/client-key.js';
import { listGroups, addGroup, renameGroup, deleteGroup } from '../groups/group.js';
import {
    listProxies, addProxy, batchAddProxies, deleteProxy, setProxyEnabled,
    checkProxy, checkAllProxies, assignRoundRobin,
} from '../proxies/proxy.js';
import { isDbInitialized, dbGetStats } from '../logger-db.js';
import { getRequestSummariesPage, getRequestPayload } from '../logger.js';
import { apiGetConfig, apiSaveConfig } from '../config-api.js';
import { adminAuth } from './admin-auth.js';
import { probeAccount, probeAccounts, probeSystem } from './health.js';

// ==================== 脱敏 ====================

/** cookie → 只暴露长度与末 4 位，绝不回传明文 */
function redactCookie(cookie: string): string {
    if (!cookie) return '';
    const tail = cookie.length > 4 ? cookie.slice(-4) : '';
    return `***(${cookie.length})${tail}`;
}

/** csk_ key → csk_****末4，绝不回传明文 */
function redactKey(key: string): string {
    if (!key) return '';
    const tail = key.length > 4 ? key.slice(-4) : '';
    return `csk_****${tail}`;
}

function redactAccount(a: CursorAccount): Record<string, unknown> {
    return { ...a, cookie: redactCookie(a.cookie) };
}

function redactClientKey(k: ClientKey): Record<string, unknown> {
    return { ...k, key: redactKey(k.key) };
}

// ==================== Router ====================

export function createAdminRouter(): Router {
    const r = Router();
    r.use(adminAuth);
    registerAccountRoutes(r);
    registerClientKeyRoutes(r);
    registerGroupRoutes(r);
    registerProxyRoutes(r);
    registerMiscRoutes(r);
    return r;
}

// ==================== accounts ====================

function registerAccountRoutes(r: Router): void {
    // 列表（脱敏 cookie）
    r.get('/accounts', (_req: Request, res: Response) => {
        res.json({ accounts: listAccounts().map(redactAccount) });
    });

    // 新增（cookie 必填）
    r.post('/accounts', (req: Request, res: Response) => {
        const b = req.body as Partial<CursorAccount>;
        if (!b.cookie || typeof b.cookie !== 'string') {
            res.status(400).json({ error: { message: 'cookie 必填', type: 'validation_error' } });
            return;
        }
        const a = addAccount(b);
        res.status(201).json({ account: redactAccount(a) });
    });

    // 更新（白名单字段由 updateAccount 内部控制）
    r.patch('/accounts/:id', (req: Request, res: Response) => {
        const a = updateAccount(req.params.id as string, req.body as Partial<CursorAccount>);
        if (!a) { res.status(404).json({ error: { message: '账号不存在', type: 'not_found' } }); return; }
        res.json({ account: redactAccount(a) });
    });

    // 删除
    r.delete('/accounts/:id', (req: Request, res: Response) => {
        const ok = deleteAccount(req.params.id as string);
        if (!ok) { res.status(404).json({ error: { message: '账号不存在', type: 'not_found' } }); return; }
        res.json({ ok: true });
    });

    // 启停
    r.post('/accounts/:id/disabled', (req: Request, res: Response) => {
        const disabled = (req.body as { disabled?: boolean }).disabled === true;
        const a = setAccountDisabled(req.params.id as string, disabled);
        if (!a) { res.status(404).json({ error: { message: '账号不存在', type: 'not_found' } }); return; }
        res.json({ account: redactAccount(a) });
    });

    // 手动清冷却
    r.post('/accounts/:id/clear-cooldown', (req: Request, res: Response) => {
        const a = clearCooldown(req.params.id as string);
        if (!a) { res.status(404).json({ error: { message: '账号不存在', type: 'not_found' } }); return; }
        res.json({ account: redactAccount(a) });
    });

    // 单账号健康探测
    r.post('/accounts/:id/health', async (req: Request, res: Response) => {
        const a = getAccount(req.params.id as string);
        if (!a) { res.status(404).json({ error: { message: '账号不存在', type: 'not_found' } }); return; }
        const result = await probeAccount(a);
        res.json({ result });
    });

    // 批量健康探测（body.ids 为空则探测全部）
    r.post('/accounts/batch-health', async (req: Request, res: Response) => {
        const ids = (req.body as { ids?: string[] }).ids;
        const all = listAccounts();
        const targets = Array.isArray(ids) && ids.length > 0 ? all.filter(a => ids.includes(a.id)) : all;
        const results = await probeAccounts(targets);
        res.json({ results, probed: results.length });
    });

    // 批量导入：多行文本，每行一个 cookie（可统一 group/priority/proxy）
    // 行格式：整行即 cookie；或 "名称|cookie" 用竖线指定名称。空行/#注释忽略。
    r.post('/accounts/batch-import', (req: Request, res: Response) => {
        const b = req.body as { text?: string; group?: string; priority?: number; proxy?: string };
        if (!b.text || typeof b.text !== 'string') {
            res.status(400).json({ error: { message: 'text 必填（多行 cookie）', type: 'validation_error' } });
            return;
        }
        const lines = b.text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        const created: Array<Record<string, unknown>> = [];
        for (const line of lines) {
            let name: string | undefined;
            let cookie = line;
            const pipe = line.indexOf('|');
            if (pipe > 0) { name = line.slice(0, pipe).trim(); cookie = line.slice(pipe + 1).trim(); }
            if (!cookie) continue;
            const a = addAccount({ name, cookie, group: b.group, priority: b.priority, proxy: b.proxy });
            created.push(redactAccount(a));
        }
        res.status(201).json({ imported: created.length, accounts: created });
    });

    // 批量编辑：对 ids 统一应用 patch（group/proxy/disabled/priority）
    // 用 POST /batch-update 而非 PATCH /batch，避免被 PATCH /accounts/:id 捕获
    r.post('/accounts/batch-update', (req: Request, res: Response) => {
        const b = req.body as { ids?: string[]; patch?: Record<string, unknown> };
        if (!Array.isArray(b.ids) || !b.patch) {
            res.status(400).json({ error: { message: 'ids[] 与 patch 必填', type: 'validation_error' } });
            return;
        }
        let updated = 0;
        for (const id of b.ids) { if (updateAccount(id, b.patch as never)) updated++; }
        res.json({ updated });
    });

    // 批量删除
    r.post('/accounts/batch-delete', (req: Request, res: Response) => {
        const ids = (req.body as { ids?: string[] }).ids;
        if (!Array.isArray(ids)) { res.status(400).json({ error: { message: 'ids[] 必填', type: 'validation_error' } }); return; }
        let deleted = 0;
        for (const id of ids) { if (deleteAccount(id)) deleted++; }
        res.json({ deleted });
    });

    // 批量重置（清零用量/失败/冷却）；ids 为空则全部
    r.post('/accounts/batch-reset', (req: Request, res: Response) => {
        const ids = (req.body as { ids?: string[] }).ids;
        const targets = Array.isArray(ids) && ids.length > 0 ? ids : listAccounts().map(a => a.id);
        let reset = 0;
        for (const id of targets) { if (resetStats(id)) reset++; }
        res.json({ reset });
    });
}

// ==================== client-keys ====================

function registerClientKeyRoutes(r: Router): void {
    // 列表（脱敏 key）
    r.get('/client-keys', (_req: Request, res: Response) => {
        res.json({ keys: listClientKeys().map(redactClientKey) });
    });

    // 新增：明文 key 仅此一次返回（提示前端立即保存）
    r.post('/client-keys', (req: Request, res: Response) => {
        const b = req.body as Partial<ClientKey>;
        const k = addClientKey({ name: b.name, group: b.group, disabled: b.disabled });
        res.status(201).json({
            key: redactClientKey(k),
            plaintextKey: k.key, // ★ 仅创建时返回一次，之后不可再取
            notice: '请立即保存 plaintextKey，之后不会再次显示完整密钥',
        });
    });

    // 更新（name/group/disabled；key 不可改）
    r.patch('/client-keys/:id', (req: Request, res: Response) => {
        const k = updateClientKey(req.params.id as string, req.body as Partial<ClientKey>);
        if (!k) { res.status(404).json({ error: { message: 'key 不存在', type: 'not_found' } }); return; }
        res.json({ key: redactClientKey(k) });
    });

    // 删除
    r.delete('/client-keys/:id', (req: Request, res: Response) => {
        const ok = deleteClientKey(req.params.id as string);
        if (!ok) { res.status(404).json({ error: { message: 'key 不存在', type: 'not_found' } }); return; }
        res.json({ ok: true });
    });

    // 启停
    r.post('/client-keys/:id/disabled', (req: Request, res: Response) => {
        const disabled = (req.body as { disabled?: boolean }).disabled === true;
        const k = setKeyDisabled(req.params.id as string, disabled);
        if (!k) { res.status(404).json({ error: { message: 'key 不存在', type: 'not_found' } }); return; }
        res.json({ key: redactClientKey(k) });
    });
}

// ==================== groups ====================

function registerGroupRoutes(r: Router): void {
    r.get('/groups', (_req: Request, res: Response) => {
        res.json({ groups: listGroups() });
    });

    r.post('/groups', (req: Request, res: Response) => {
        const name = (req.body as { name?: string }).name;
        if (!name || typeof name !== 'string') {
            res.status(400).json({ error: { message: 'name 必填', type: 'validation_error' } });
            return;
        }
        res.status(201).json({ group: addGroup({ name }) });
    });

    // 改名（级联更新账号 / key 的 group 名）
    r.patch('/groups/:id', (req: Request, res: Response) => {
        const name = (req.body as { name?: string }).name;
        if (!name || typeof name !== 'string') {
            res.status(400).json({ error: { message: 'name 必填', type: 'validation_error' } });
            return;
        }
        const g = renameGroup(req.params.id as string, name);
        if (!g) { res.status(404).json({ error: { message: '分组不存在', type: 'not_found' } }); return; }
        res.json({ group: g });
    });

    // 删除（级联清空引用）
    r.delete('/groups/:id', (req: Request, res: Response) => {
        const ok = deleteGroup(req.params.id as string);
        if (!ok) { res.status(404).json({ error: { message: '分组不存在', type: 'not_found' } }); return; }
        res.json({ ok: true });
    });
}

// ==================== proxies ====================

function registerProxyRoutes(r: Router): void {
    r.get('/proxies', (_req: Request, res: Response) => {
        res.json({ proxies: listProxies() });
    });

    r.post('/proxies', (req: Request, res: Response) => {
        const url = (req.body as { url?: string }).url;
        if (!url || typeof url !== 'string') {
            res.status(400).json({ error: { message: 'url 必填', type: 'validation_error' } });
            return;
        }
        res.status(201).json({ proxy: addProxy({ url, note: (req.body as { note?: string }).note }) });
    });

    // 批量添加（多行 URL）
    r.post('/proxies/batch', (req: Request, res: Response) => {
        const text = (req.body as { text?: string }).text;
        if (!text || typeof text !== 'string') {
            res.status(400).json({ error: { message: 'text 必填（多行 URL）', type: 'validation_error' } });
            return;
        }
        const added = batchAddProxies(text);
        res.status(201).json({ added: added.length, proxies: added });
    });

    // 并发探测全部（放在 :id 之前，避免 check-all 被当成 id）
    r.post('/proxies/check-all', async (_req: Request, res: Response) => {
        const proxies = await checkAllProxies();
        res.json({ proxies, checked: proxies.length });
    });

    // 轮询分配到账号
    r.post('/proxies/assign-round-robin', (req: Request, res: Response) => {
        const ids = (req.body as { accountIds?: string[] }).accountIds;
        res.json(assignRoundRobin(ids));
    });

    r.delete('/proxies/:id', (req: Request, res: Response) => {
        const ok = deleteProxy(req.params.id as string);
        if (!ok) { res.status(404).json({ error: { message: '代理不存在', type: 'not_found' } }); return; }
        res.json({ ok: true });
    });

    r.post('/proxies/:id/enabled', (req: Request, res: Response) => {
        const enabled = (req.body as { enabled?: boolean }).enabled === true;
        const p = setProxyEnabled(req.params.id as string, enabled);
        if (!p) { res.status(404).json({ error: { message: '代理不存在', type: 'not_found' } }); return; }
        res.json({ proxy: p });
    });

    r.post('/proxies/:id/check', async (req: Request, res: Response) => {
        const p = await checkProxy(req.params.id as string);
        if (!p) { res.status(404).json({ error: { message: '代理不存在', type: 'not_found' } }); return; }
        res.json({ proxy: p });
    });
}

// ==================== config / stats / traces ====================

function registerMiscRoutes(r: Router): void {
    // 复用现有 config API（热重载写 config.yaml）
    r.get('/config', apiGetConfig);
    r.post('/config', apiSaveConfig);

    // 池状态 + DB 统计聚合
    r.get('/stats', (_req: Request, res: Response) => {
        const pool = poolStatus();
        const db = isDbInitialized() ? dbGetStats() : null;
        res.json({ pool, db });
    });

    // 系统健康探测：stealth 就绪 + 上游可达 + 池概览
    r.get('/health/system', async (_req: Request, res: Response) => {
        const health = await probeSystem();
        res.json(health);
    });

    // 日志（合并链路追踪+用量）：分页 + 状态/关键字/账号/Key 过滤 + 用量小计
    // SQLite 启用时走 DB 全量翻页；否则回退内存（近段历史）。
    r.get('/logs', (req: Request, res: Response) => {
        const q = req.query;
        const limit = Math.min(Math.max(parseInt(String(q.limit ?? '50'), 10) || 50, 1), 200);
        const page = getRequestSummariesPage({
            limit,
            before: q.before ? Number(q.before) : undefined,
            status: typeof q.status === 'string' ? q.status : undefined,
            keyword: typeof q.keyword === 'string' ? q.keyword : undefined,
            since: q.since ? Number(q.since) : undefined,
            accountId: typeof q.account_id === 'string' ? q.account_id : undefined,
            clientKeyId: typeof q.client_key_id === 'string' ? q.client_key_id : undefined,
        });
        // 当前页用量小计
        const usage = page.summaries.reduce((acc, s) => {
            acc.inputTokens += s.inputTokens || 0;
            acc.outputTokens += s.outputTokens || 0;
            return acc;
        }, { inputTokens: 0, outputTokens: 0 });
        res.json({ ...page, usage, dbEnabled: isDbInitialized() });
    });

    // 单条请求完整 payload（点击展开）
    r.get('/logs/:requestId', (req: Request, res: Response) => {
        const payload = getRequestPayload(req.params.requestId as string);
        if (!payload) { res.status(404).json({ error: { message: '日志不存在或已清理', type: 'not_found' } }); return; }
        res.json({ payload });
    });
}
