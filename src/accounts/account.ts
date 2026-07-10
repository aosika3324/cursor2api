/**
 * accounts/account.ts - 上游账号池管理器（AccountManager）
 *
 * 职责：
 * 1. 加载/持久化 accounts.json（与 config.yaml 同目录，即进程 cwd）
 * 2. 账号 CRUD（供 Admin API）
 * 3. 运行时状态：成功/失败计数、429/403 冷却、用量累计
 * 4. 首启迁移：把全局 config.cookie 迁移为池中第一条账号（幂等）
 *
 * 设计：内存持有全量账号，结构性变更（增删禁用）立即落盘，
 * 高频运行时统计（用量/失败计数）走去抖落盘，避免每请求一次磁盘 IO。
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from 'fs';
import type { CursorAccount, AccountConnection } from '../types.js';
import { getConfig } from '../config.js';

const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || './accounts.json';

let accounts: CursorAccount[] = [];
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function genId(): string {
    return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function nowIso(): string {
    return new Date().toISOString();
}

/** 原子落盘：写临时文件再 rename，避免半写文件 */
function persist(): void {
    try {
        const tmp = ACCOUNTS_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(accounts, null, 2), 'utf-8');
        renameSync(tmp, ACCOUNTS_FILE);
    } catch (e) {
        console.error('[Accounts] 持久化失败:', e);
    }
}

/** 结构性变更：立即落盘 */
function saveNow(): void {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    persist();
}

/** 高频运行时变更：去抖落盘（500ms） */
function saveDebounced(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 500);
}

/** 补全一条账号的缺省字段（兼容手写/旧版 accounts.json） */
function normalize(a: Partial<CursorAccount>): CursorAccount {
    return {
        id: a.id || genId(),
        name: a.name || 'account',
        cookie: a.cookie || '',
        fingerprintUA: a.fingerprintUA,
        proxy: a.proxy,
        stealthProxyUrl: a.stealthProxyUrl,
        priority: typeof a.priority === 'number' ? a.priority : 0,
        disabled: a.disabled === true,
        group: a.group,
        maxConcurrency: a.maxConcurrency,
        createdAt: a.createdAt || nowIso(),
        lastUsedAt: a.lastUsedAt,
        totalCalls: a.totalCalls || 0,
        totalInputTokens: a.totalInputTokens || 0,
        totalOutputTokens: a.totalOutputTokens || 0,
        consecutiveFailures: a.consecutiveFailures || 0,
        cooldownUntil: a.cooldownUntil,
        lastErrorReason: a.lastErrorReason,
        lastProbeAt: a.lastProbeAt,
        lastProbeLatencyMs: a.lastProbeLatencyMs,
        lastProbeOk: a.lastProbeOk,
    };
}

/** 从磁盘加载（仅首次）。必须在 getConfig 可用之后调用。 */
export function loadAccounts(): void {
    if (loaded) return;
    loaded = true;
    if (existsSync(ACCOUNTS_FILE)) {
        try {
            const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
            if (Array.isArray(raw)) accounts = raw.map(normalize);
        } catch (e) {
            console.error('[Accounts] 读取 accounts.json 失败，将从空池启动:', e);
            accounts = [];
        }
    }
    migrateFromGlobalCookie();
}

/**
 * 首启迁移（幂等）：若池为空且全局配置有 cookie，则把它迁移为第一条账号。
 * 保证老部署（仅配了 config.yaml 的 cookie）升级后零改动即可运行。
 */
function migrateFromGlobalCookie(): void {
    if (accounts.length > 0) return;
    const cfg = getConfig();
    if (!cfg.cookie) return;
    accounts.push(normalize({
        name: '默认账号(迁移自 config.cookie)',
        cookie: cfg.cookie,
        fingerprintUA: cfg.fingerprint?.userAgent,
        priority: 0,
    }));
    saveNow();
    console.log('[Accounts] 已从 config.cookie 迁移生成默认账号');
}

// ==================== 查询 ====================

/** 全部账号（返回副本，防外部误改内存态） */
export function listAccounts(): CursorAccount[] {
    if (!loaded) loadAccounts();
    return accounts.map(a => ({ ...a }));
}

export function getAccount(id: string): CursorAccount | undefined {
    if (!loaded) loadAccounts();
    const a = accounts.find(x => x.id === id);
    return a ? { ...a } : undefined;
}

export function accountCount(): number {
    if (!loaded) loadAccounts();
    return accounts.length;
}

/** 提取「连接子集」，供 cursor-client 使用 */
export function toConnection(a: CursorAccount): AccountConnection {
    return {
        cookie: a.cookie,
        fingerprintUA: a.fingerprintUA,
        proxy: a.proxy,
        stealthProxyUrl: a.stealthProxyUrl,
    };
}

// ==================== 变更（结构性，立即落盘） ====================

export function addAccount(input: Partial<CursorAccount>): CursorAccount {
    if (!loaded) loadAccounts();
    const a = normalize(input);
    accounts.push(a);
    saveNow();
    return { ...a };
}

export function updateAccount(id: string, patch: Partial<CursorAccount>): CursorAccount | undefined {
    if (!loaded) loadAccounts();
    const a = accounts.find(x => x.id === id);
    if (!a) return undefined;
    // 白名单可改字段（不允许外部直接改统计/内存态之外的东西）
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.cookie !== undefined) a.cookie = patch.cookie;
    if (patch.fingerprintUA !== undefined) a.fingerprintUA = patch.fingerprintUA;
    if (patch.proxy !== undefined) a.proxy = patch.proxy;
    if (patch.stealthProxyUrl !== undefined) a.stealthProxyUrl = patch.stealthProxyUrl;
    if (patch.priority !== undefined) a.priority = patch.priority;
    if (patch.disabled !== undefined) a.disabled = patch.disabled;
    // group 用 'in' 判定：允许显式传 undefined 清空归属（分组删除级联用）
    if ('group' in patch) a.group = patch.group;
    if (patch.maxConcurrency !== undefined) a.maxConcurrency = patch.maxConcurrency;
    saveNow();
    return { ...a };
}

export function deleteAccount(id: string): boolean {
    if (!loaded) loadAccounts();
    const n = accounts.length;
    accounts = accounts.filter(x => x.id !== id);
    if (accounts.length !== n) { saveNow(); return true; }
    return false;
}

export function setDisabled(id: string, disabled: boolean): CursorAccount | undefined {
    return updateAccount(id, { disabled });
}

export function setPriority(id: string, priority: number): CursorAccount | undefined {
    return updateAccount(id, { priority });
}

/** 手动清除冷却（Admin） */
export function clearCooldown(id: string): CursorAccount | undefined {
    if (!loaded) loadAccounts();
    const a = accounts.find(x => x.id === id);
    if (!a) return undefined;
    a.cooldownUntil = undefined;
    a.consecutiveFailures = 0;
    a.lastErrorReason = undefined;
    saveNow();
    return { ...a };
}

/** 重置统计：清零用量 + 失败计数 + 冷却（Admin 批量重置用） */
export function resetStats(id: string): CursorAccount | undefined {
    if (!loaded) loadAccounts();
    const a = accounts.find(x => x.id === id);
    if (!a) return undefined;
    a.totalCalls = 0;
    a.totalInputTokens = 0;
    a.totalOutputTokens = 0;
    a.consecutiveFailures = 0;
    a.cooldownUntil = undefined;
    a.lastErrorReason = undefined;
    saveNow();
    return { ...a };
}

// ==================== 运行时状态（高频，去抖落盘） ====================

/** 调用成功：清零失败计数、累计用量、更新最近使用时间 */
export function recordSuccess(
    id: string,
    tokens?: { inputTokens?: number; outputTokens?: number },
): void {
    const a = accounts.find(x => x.id === id);
    if (!a) return;
    a.consecutiveFailures = 0;
    a.lastErrorReason = undefined;
    a.totalCalls += 1;
    a.totalInputTokens += tokens?.inputTokens || 0;
    a.totalOutputTokens += tokens?.outputTokens || 0;
    a.lastUsedAt = nowIso();
    saveDebounced();
}

/**
 * 记录一次主动健康探测结果（旁路，不动调度/冷却状态，只更新展示字段）。
 * 探测限流(429/403)可选地写入冷却，交由调用方决定是否传 cooldownOnRateLimit。
 */
export function recordProbe(
    id: string,
    result: { ok: boolean; latencyMs?: number; rateLimited?: boolean; reason?: string },
): void {
    const a = accounts.find(x => x.id === id);
    if (!a) return;
    a.lastProbeAt = nowIso();
    a.lastProbeOk = result.ok;
    a.lastProbeLatencyMs = result.latencyMs;
    if (!result.ok && result.reason) a.lastErrorReason = result.reason.slice(0, 200);
    saveDebounced();
}

/**
 * 调用失败。
 * - rateLimited (429/403)：立即进入限流冷却（cooldownSecs）。
 * - 其它：连续失败计数 +1，达阈值则进入较短的失败冷却。
 */
export function recordFailure(id: string, opts: { rateLimited: boolean; reason?: string }): void {
    const a = accounts.find(x => x.id === id);
    if (!a) return;
    const cfg = getConfig();
    a.lastErrorReason = opts.reason?.slice(0, 200);
    if (opts.rateLimited) {
        const secs = cfg.accountCooldownSecs ?? 1800;
        a.cooldownUntil = new Date(Date.now() + secs * 1000).toISOString();
        console.warn(`[Accounts] 账号 ${a.name} 触发限流(429/403)，冷却 ${secs}s`);
    } else {
        a.consecutiveFailures += 1;
        const threshold = cfg.accountFailureThreshold ?? 3;
        if (a.consecutiveFailures >= threshold) {
            const secs = cfg.accountFailureCooldownSecs ?? 60;
            a.cooldownUntil = new Date(Date.now() + secs * 1000).toISOString();
            console.warn(`[Accounts] 账号 ${a.name} 连续失败 ${a.consecutiveFailures} 次，临时冷却 ${secs}s`);
        }
    }
    saveDebounced();
}

/** 是否处于冷却中 */
export function isCoolingDown(a: CursorAccount): boolean {
    return !!a.cooldownUntil && Date.parse(a.cooldownUntil) > Date.now();
}

/** 内部：供调度器读取活的内存态账号（非副本），只读使用 */
export function _liveAccounts(): CursorAccount[] {
    if (!loaded) loadAccounts();
    return accounts;
}
