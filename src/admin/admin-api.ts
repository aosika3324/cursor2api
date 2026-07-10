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
    setDisabled as setAccountDisabled, clearCooldown,
} from '../accounts/account.js';
import { poolStatus } from '../accounts/scheduler.js';
import {
    listClientKeys, getClientKey, addClientKey, updateClientKey, deleteClientKey,
    setDisabled as setKeyDisabled,
} from '../keys/client-key.js';
import { listGroups, addGroup, renameGroup, deleteGroup } from '../groups/group.js';
import { isDbInitialized, dbGetSummaries, dbGetStats } from '../logger-db.js';
import { apiGetConfig, apiSaveConfig } from '../config-api.js';
import { adminAuth } from './admin-auth.js';

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

    // 链路追踪：按 account/key/status 过滤（需启用 SQLite）
    r.get('/traces', (req: Request, res: Response) => {
        if (!isDbInitialized()) {
            res.status(400).json({ error: { message: '链路追踪需启用 SQLite（logging.db_enabled）', type: 'db_disabled' } });
            return;
        }
        const q = req.query;
        const limit = Math.min(Math.max(parseInt(String(q.limit ?? '50'), 10) || 50, 1), 500);
        const traces = dbGetSummaries({
            limit,
            accountId: typeof q.account_id === 'string' ? q.account_id : undefined,
            clientKeyId: typeof q.client_key_id === 'string' ? q.client_key_id : undefined,
            status: typeof q.status === 'string' ? q.status : undefined,
            keyword: typeof q.keyword === 'string' ? q.keyword : undefined,
        });
        res.json({ traces, count: traces.length });
    });
}
