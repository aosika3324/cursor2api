/**
 * proxies/proxy.ts - 代理池管理器（S3）
 *
 * 独立于账号管理，存于 proxies.json（镜像 AccountManager 写法：原子落盘）。
 * 支持：CRUD、批量添加、健康探测（经代理 HEAD cursor.com 测连通/延迟）、
 *      轮询分配（把「启用且非 unhealthy」的代理 URL 依次写入账号的 proxy 字段）。
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from 'fs';
import type { ProxyEntry } from '../types.js';
import { getProxyFetchOptionsFor } from '../proxy-agent.js';
import { listAccounts, updateAccount } from '../accounts/account.js';

const PROXIES_FILE = process.env.PROXIES_FILE || './proxies.json';

let proxies: ProxyEntry[] = [];
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function genId(): string {
    return 'px_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function nowIso(): string { return new Date().toISOString(); }

function persist(): void {
    try {
        const tmp = PROXIES_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(proxies, null, 2), 'utf-8');
        renameSync(tmp, PROXIES_FILE);
    } catch (e) {
        console.error('[Proxies] 持久化失败:', e);
    }
}
function saveNow(): void { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } persist(); }
function saveDebounced(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 500);
}

function normalize(p: Partial<ProxyEntry>): ProxyEntry {
    return {
        id: p.id || genId(),
        url: (p.url || '').trim(),
        enabled: p.enabled !== false,
        health: p.health || 'unknown',
        latencyMs: p.latencyMs,
        lastCheckedAt: p.lastCheckedAt,
        note: p.note,
        createdAt: p.createdAt || nowIso(),
    };
}

export function loadProxies(): void {
    if (loaded) return;
    loaded = true;
    if (existsSync(PROXIES_FILE)) {
        try {
            const raw = JSON.parse(readFileSync(PROXIES_FILE, 'utf-8'));
            if (Array.isArray(raw)) proxies = raw.map(normalize);
        } catch (e) {
            console.error('[Proxies] 读取 proxies.json 失败，从空池启动:', e);
            proxies = [];
        }
    }
}

// ==================== 查询 ====================

export function listProxies(): ProxyEntry[] {
    if (!loaded) loadProxies();
    return proxies.map(p => ({ ...p }));
}
export function getProxy(id: string): ProxyEntry | undefined {
    if (!loaded) loadProxies();
    const p = proxies.find(x => x.id === id);
    return p ? { ...p } : undefined;
}
export function proxyCount(): number {
    if (!loaded) loadProxies();
    return proxies.length;
}

// ==================== 变更 ====================

export function addProxy(input: Partial<ProxyEntry>): ProxyEntry {
    if (!loaded) loadProxies();
    const p = normalize(input);
    proxies.push(p);
    saveNow();
    return { ...p };
}

/** 批量添加：多行文本，每行一个代理 URL（空行/#注释忽略，去重已有 URL） */
export function batchAddProxies(text: string): ProxyEntry[] {
    if (!loaded) loadProxies();
    const existing = new Set(proxies.map(p => p.url));
    const added: ProxyEntry[] = [];
    for (const raw of text.split('\n')) {
        const url = raw.trim();
        if (!url || url.startsWith('#') || existing.has(url)) continue;
        const p = normalize({ url });
        proxies.push(p);
        existing.add(url);
        added.push({ ...p });
    }
    if (added.length) saveNow();
    return added;
}

export function deleteProxy(id: string): boolean {
    if (!loaded) loadProxies();
    const n = proxies.length;
    proxies = proxies.filter(x => x.id !== id);
    if (proxies.length !== n) { saveNow(); return true; }
    return false;
}

export function setProxyEnabled(id: string, enabled: boolean): ProxyEntry | undefined {
    if (!loaded) loadProxies();
    const p = proxies.find(x => x.id === id);
    if (!p) return undefined;
    p.enabled = enabled;
    saveNow();
    return { ...p };
}

// ==================== 健康探测 ====================

/** 经该代理 HEAD cursor.com，测连通与延迟，写回 health/latency */
export async function checkProxy(id: string): Promise<ProxyEntry | undefined> {
    if (!loaded) loadProxies();
    const p = proxies.find(x => x.id === id);
    if (!p) return undefined;
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const resp = await fetch('https://cursor.com', {
            method: 'HEAD',
            signal: controller.signal,
            ...getProxyFetchOptionsFor(p.url),
        } as any);
        p.health = resp.status > 0 && resp.status < 500 ? 'healthy' : 'unhealthy';
        p.latencyMs = Date.now() - start;
    } catch {
        p.health = 'unhealthy';
        p.latencyMs = undefined;
    } finally {
        clearTimeout(timer);
        p.lastCheckedAt = nowIso();
        saveDebounced();
    }
    return { ...p };
}

/** 并发探测全部（限并发） */
export async function checkAllProxies(concurrency = 5): Promise<ProxyEntry[]> {
    if (!loaded) loadProxies();
    const ids = proxies.map(p => p.id);
    let idx = 0;
    async function worker(): Promise<void> {
        while (idx < ids.length) { await checkProxy(ids[idx++]); }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    return listProxies();
}

// ==================== 轮询分配 ====================

/**
 * 把「启用且非 unhealthy」的代理 URL 依次轮询分配到账号的 proxy 字段。
 * @param accountIds 目标账号（空则全部账号）
 * 返回 { assigned, proxiesUsed }
 */
export function assignRoundRobin(accountIds?: string[]): { assigned: number; proxiesUsed: number } {
    if (!loaded) loadProxies();
    const usable = proxies.filter(p => p.enabled && p.health !== 'unhealthy').map(p => p.url);
    if (usable.length === 0) return { assigned: 0, proxiesUsed: 0 };
    const all = listAccounts();
    const targets = accountIds && accountIds.length > 0 ? all.filter(a => accountIds.includes(a.id)) : all;
    let assigned = 0;
    targets.forEach((a, i) => {
        if (updateAccount(a.id, { proxy: usable[i % usable.length] })) assigned++;
    });
    return { assigned, proxiesUsed: usable.length };
}
