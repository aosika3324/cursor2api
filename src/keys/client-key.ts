/**
 * keys/client-key.ts - 下游客户端 Key 管理器（P3）
 *
 * 结构与 accounts/account.ts 完全对称：
 *  - client-keys.json 原子持久化，结构性变更立即落盘，用量统计去抖落盘
 *  - CRUD（供 Admin API）
 *  - findByKey：鉴权中间件查表用
 *  - recordUsage：请求完成时累计调用次数与 token
 *
 * 与 config.authTokens 共存：两者都放行，但只有命中 client key 才 recordUsage。
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import type { ClientKey } from '../types.js';

const KEYS_FILE = process.env.CLIENT_KEYS_FILE || './client-keys.json';

let keys: ClientKey[] = [];
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function genId(): string {
    return 'ck_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 生成一个 csk_ 密钥串（24 字节 → 32 位 base64url） */
function genKey(): string {
    return 'csk_' + randomBytes(24).toString('base64url');
}

function nowIso(): string {
    return new Date().toISOString();
}

function persist(): void {
    try {
        const tmp = KEYS_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(keys, null, 2), 'utf-8');
        renameSync(tmp, KEYS_FILE);
    } catch (e) {
        console.error('[ClientKeys] 持久化失败:', e);
    }
}

function saveNow(): void {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    persist();
}

function saveDebounced(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 500);
}

function normalize(k: Partial<ClientKey>): ClientKey {
    return {
        id: k.id || genId(),
        key: k.key || genKey(),
        name: k.name || 'client-key',
        disabled: k.disabled === true,
        group: k.group,
        createdAt: k.createdAt || nowIso(),
        lastUsedAt: k.lastUsedAt,
        totalCalls: k.totalCalls || 0,
        totalInputTokens: k.totalInputTokens || 0,
        totalOutputTokens: k.totalOutputTokens || 0,
    };
}

export function loadClientKeys(): void {
    if (loaded) return;
    loaded = true;
    if (existsSync(KEYS_FILE)) {
        try {
            const raw = JSON.parse(readFileSync(KEYS_FILE, 'utf-8'));
            if (Array.isArray(raw)) keys = raw.map(normalize);
        } catch (e) {
            console.error('[ClientKeys] 读取 client-keys.json 失败，将从空表启动:', e);
            keys = [];
        }
    }
}

// ==================== 查询 ====================

export function listClientKeys(): ClientKey[] {
    if (!loaded) loadClientKeys();
    return keys.map(k => ({ ...k }));
}

export function getClientKey(id: string): ClientKey | undefined {
    if (!loaded) loadClientKeys();
    const k = keys.find(x => x.id === id);
    return k ? { ...k } : undefined;
}

export function clientKeyCount(): number {
    if (!loaded) loadClientKeys();
    return keys.length;
}

/** 鉴权查表：按密钥串精确匹配（返回内存态引用的副本），未命中/已禁用返回 undefined */
export function findByKey(key: string): ClientKey | undefined {
    if (!loaded) loadClientKeys();
    const k = keys.find(x => x.key === key);
    if (!k || k.disabled) return undefined;
    return { ...k };
}

// ==================== 变更（结构性，立即落盘） ====================

export function addClientKey(input: Partial<ClientKey>): ClientKey {
    if (!loaded) loadClientKeys();
    const k = normalize(input);
    keys.push(k);
    saveNow();
    return { ...k };
}

export function updateClientKey(id: string, patch: Partial<ClientKey>): ClientKey | undefined {
    if (!loaded) loadClientKeys();
    const k = keys.find(x => x.id === id);
    if (!k) return undefined;
    if (patch.name !== undefined) k.name = patch.name;
    if (patch.disabled !== undefined) k.disabled = patch.disabled;
    // group 用 'in' 判定：允许显式传 undefined 清空绑定（分组删除级联用）
    if ('group' in patch) k.group = patch.group;
    saveNow();
    return { ...k };
}

export function deleteClientKey(id: string): boolean {
    if (!loaded) loadClientKeys();
    const n = keys.length;
    keys = keys.filter(x => x.id !== id);
    if (keys.length !== n) { saveNow(); return true; }
    return false;
}

export function setDisabled(id: string, disabled: boolean): ClientKey | undefined {
    return updateClientKey(id, { disabled });
}

// ==================== 用量统计（高频，去抖落盘） ====================

/** 请求完成时累计一次调用与 token 用量 */
export function recordUsage(
    id: string,
    tokens?: { inputTokens?: number; outputTokens?: number },
): void {
    if (!loaded) loadClientKeys();
    const k = keys.find(x => x.id === id);
    if (!k) return;
    k.totalCalls += 1;
    k.totalInputTokens += tokens?.inputTokens || 0;
    k.totalOutputTokens += tokens?.outputTokens || 0;
    k.lastUsedAt = nowIso();
    saveDebounced();
}
