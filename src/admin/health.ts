/**
 * admin/health.ts - 运维健康探测（S1）
 *
 * 两类探测，均为旁路只读（不改调度器状态）：
 *  - probeAccount：用指定账号连接发一个最小请求，测活性与延迟。首个 token 到达即判活，
 *    立刻中止（省流量、快）。429/403 → 限流；超时/网络错 → 不健康。
 *  - probeSystem：stealth-proxy 就绪状态 + 上游 cursor.com 可达性 + 账号池概览。
 */

import type { CursorAccount, CursorChatRequest } from '../types.js';
import { getConfig } from '../config.js';
import { sendCursorRequest } from '../cursor-client.js';
import { CursorError } from '../cursor-error.js';
import { toConnection, recordProbe } from '../accounts/account.js';
import { poolStatus } from '../accounts/scheduler.js';
import { getProxyFetchOptionsFor } from '../proxy-agent.js';

const PROBE_TIMEOUT_MS = 15000;

export interface AccountProbeResult {
    id: string;
    name: string;
    ok: boolean;
    latencyMs?: number;
    rateLimited?: boolean;
    error?: string;
}

/** 构造最小探测请求 */
function buildPingRequest(): CursorChatRequest {
    return {
        model: getConfig().cursorModel,
        id: 'health-' + Date.now().toString(36),
        messages: [{ id: 'm0', role: 'user', parts: [{ type: 'text', text: 'ping' }] }],
        trigger: 'submit-message',
    };
}

/**
 * 探测单个账号：发最小请求，首 token 即判活并中止。
 * 显式传 account → 走 legacyAttempt，不触碰账号池调度/冷却。
 */
export async function probeAccount(account: CursorAccount): Promise<AccountProbeResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let gotResponse = false;
    let latencyMs: number | undefined;

    const onChunk = (event: { type: string; delta?: string }): void => {
        if (!gotResponse && (event.type === 'text-delta' || event.type === 'finish')) {
            gotResponse = true;
            latencyMs = Date.now() - start;
            controller.abort(); // 判活即止，无需读完整流
        }
    };

    try {
        await sendCursorRequest(buildPingRequest(), onChunk, controller.signal, toConnection(account));
        // 正常读完（很短的响应）也算成功
        if (!gotResponse) latencyMs = Date.now() - start;
        const r: AccountProbeResult = { id: account.id, name: account.name, ok: true, latencyMs };
        recordProbe(account.id, { ok: true, latencyMs });
        return r;
    } catch (err) {
        // 我们主动中止（已拿到响应）→ 判健康
        if (gotResponse) {
            const r: AccountProbeResult = { id: account.id, name: account.name, ok: true, latencyMs };
            recordProbe(account.id, { ok: true, latencyMs });
            return r;
        }
        const rateLimited = err instanceof CursorError && err.isRateLimited;
        const error = err instanceof Error ? err.message.slice(0, 200) : String(err);
        recordProbe(account.id, { ok: false, rateLimited, reason: error });
        return { id: account.id, name: account.name, ok: false, rateLimited, error };
    } finally {
        clearTimeout(timer);
    }
}

/** 并发探测多个账号（限并发，避免同时打爆上游/代理） */
export async function probeAccounts(accounts: CursorAccount[], concurrency = 5): Promise<AccountProbeResult[]> {
    const results: AccountProbeResult[] = [];
    let idx = 0;
    async function worker(): Promise<void> {
        while (idx < accounts.length) {
            const cur = accounts[idx++];
            results.push(await probeAccount(cur));
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker));
    return results;
}

export interface SystemHealth {
    stealth: { enabled: boolean; ok: boolean; status?: string; challengeCount?: number; hasCookie?: boolean; error?: string };
    upstream: { ok: boolean; latencyMs?: number; error?: string };
    pool: { total: number; usable: number; busy: number; coolingDown: number };
    timestamp: string;
}

/** 带超时的 fetch */
async function fetchWithTimeout(url: string, opts: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: c.signal } as any);
    } finally {
        clearTimeout(t);
    }
}

/** 系统探测：stealth 就绪 + 上游可达 + 池概览 */
export async function probeSystem(): Promise<SystemHealth> {
    const cfg = getConfig();
    const stealthUrl = cfg.stealthProxy;

    // ① stealth-proxy /health
    const stealth: SystemHealth['stealth'] = { enabled: !!stealthUrl, ok: false };
    if (stealthUrl) {
        try {
            const resp = await fetchWithTimeout(`${stealthUrl.replace(/\/$/, '')}/health`, {}, 5000);
            const j = await resp.json().catch(() => ({})) as Record<string, unknown>;
            stealth.ok = resp.ok && j.status === 'ok';
            stealth.status = typeof j.status === 'string' ? j.status : undefined;
            stealth.challengeCount = typeof j.challengeCount === 'number' ? j.challengeCount : undefined;
            stealth.hasCookie = !!j.cookie;
        } catch (e) {
            stealth.error = e instanceof Error ? e.message.slice(0, 150) : String(e);
        }
    }

    // ② 上游 cursor.com 可达性（HEAD，走全局代理）
    const upstream: SystemHealth['upstream'] = { ok: false };
    const t0 = Date.now();
    try {
        const resp = await fetchWithTimeout('https://cursor.com', {
            method: 'HEAD',
            ...getProxyFetchOptionsFor(undefined),
        }, 8000);
        upstream.ok = resp.status > 0 && resp.status < 500;
        upstream.latencyMs = Date.now() - t0;
    } catch (e) {
        upstream.error = e instanceof Error ? e.message.slice(0, 150) : String(e);
    }

    return { stealth, upstream, pool: poolStatus(), timestamp: new Date().toISOString() };
}
