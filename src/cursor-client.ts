/**
 * cursor-client.ts - Cursor API 客户端
 *
 * 职责：
 * 1. 发送请求到 https://cursor.com/api/chat（带 Chrome TLS 指纹模拟 headers）
 * 2. 流式解析 SSE 响应
 * 3. 自动重试（最多 2 次）
 *
 * 注：x-is-human token 验证已被 Cursor 停用，直接发送空字符串即可。
 */

import type { CursorChatRequest, CursorSSEEvent, AccountConnection } from './types.js';
import { getConfig } from './config.js';
import { getProxyFetchOptionsFor } from './proxy-agent.js';
import { CursorError } from './cursor-error.js';
import { accountCount, toConnection, recordSuccess, recordFailure } from './accounts/account.js';
import { acquire, poolStatus } from './accounts/scheduler.js';
import { getContext, setAccountId } from './request-context.js';

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

/**
 * 把「连接所需的账号信息」归一化：调用方未显式传 account 时，从全局 config 合成一个，
 * 使 P1 行为与改造前完全一致（单账号 = 全局 cookie/fingerprint/proxy/stealthProxy）。
 */
function resolveConnection(account?: AccountConnection): Required<Pick<AccountConnection, never>> & {
    cookie?: string;
    fingerprintUA: string;
    proxy?: string;
    stealthProxyUrl?: string;
} {
    const config = getConfig();
    return {
        cookie: account?.cookie ?? config.cookie,
        fingerprintUA: account?.fingerprintUA ?? config.fingerprint.userAgent,
        proxy: account?.proxy, // undefined → 走全局 proxy（getProxyFetchOptions）
        stealthProxyUrl: account?.stealthProxyUrl ?? config.stealthProxy,
    };
}

// Chrome 浏览器请求头模拟
function getChromeHeaders(conn: ReturnType<typeof resolveConnection>): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'accept': '*/*',
        'sec-ch-ua-platform': '"macOS"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"arm"',
        'sec-ch-ua-platform-version': '"14.6.1"',
        'dnt': '1',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/cn/docs',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': conn.fingerprintUA,
        'x-is-human': '',  // Cursor 不再校验此字段
    };

    // 携带 Cookie 通过 Vercel 安全验证
    if (conn.cookie) {
        headers['cookie'] = conn.cookie;
    }

    return headers;
}

// ==================== API 请求 ====================

/**
 * 发送请求到 Cursor /api/chat 并以流式方式处理响应（带重试）
 */
/**
 * 发送流式请求。
 *
 * 调度分两条路径：
 *  1. 显式传入 account（Admin 健康探测等）或账号池为空 → 走 legacy 路径（旧式 2 次重试，
 *     account 为空时用全局 config，行为与改造前完全一致，零回归）。
 *  2. 账号池非空且未指定 account → 走池化故障转移：跨账号重试，429/403 冷却并换号。
 */
export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
    account?: AccountConnection,
): Promise<void> {
    if (account || accountCount() === 0) {
        return legacyAttempt(req, onChunk, externalSignal, account);
    }
    return pooledAttempt(req, onChunk, externalSignal);
}

/** 旧式重试路径：固定连接（显式 account 或全局 config），最多 2 次。 */
async function legacyAttempt(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal: AbortSignal | undefined,
    account: AccountConnection | undefined,
): Promise<void> {
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sendCursorRequestInner(req, onChunk, externalSignal, account);
            return;
        } catch (err) {
            if (externalSignal?.aborted) throw err;
            if (err instanceof CursorError && err.kind === 'degenerate_loop') return;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries}): ${msg.substring(0, 100)}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw err;
            }
        }
    }
}

/**
 * 池化故障转移路径：依次从调度器取账号执行。
 * - 成功 → recordSuccess（累计用量），返回。
 * - 退化循环 → 视为成功（已有内容有效），recordSuccess 后返回。
 * - CursorError 且 retryable → recordFailure（限流则冷却换号），换下一账号。
 * - CursorError 且 !retryable（如 4xx 非限流）→ 直接抛出。
 * - 无可用账号 → 抛出池忙/全冷却错误。
 */
async function pooledAttempt(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
): Promise<void> {
    const cfg = getConfig();
    const ctx = getContext();
    const group = ctx?.group;
    const budget = Math.min(cfg.maxAccountFailover ?? 3, Math.max(1, accountCount()));
    const tried = new Set<string>();
    let lastErr: unknown;

    for (let i = 0; i < budget; i++) {
        const acq = acquire({ group, exclude: tried });
        if (!acq) break; // 无更多可用账号（或该分组内无可用）
        tried.add(acq.account.id);
        setAccountId(acq.account.id); // ★ 链路追踪：回填最终命中账号

        // 嗅探 usage 以做账号级用量统计（不影响业务 onChunk）
        let usage: { inputTokens?: number; outputTokens?: number } | undefined;
        const wrapped = (event: CursorSSEEvent): void => {
            if (event.messageMetadata?.usage) usage = event.messageMetadata.usage;
            onChunk(event);
        };

        try {
            await sendCursorRequestInner(req, wrapped, externalSignal, toConnection(acq.account));
            recordSuccess(acq.account.id, usage);
            acq.release();
            return;
        } catch (err) {
            acq.release();
            if (externalSignal?.aborted) throw err;
            // 退化循环：已有内容有效，按成功处理，不换号
            if (err instanceof CursorError && err.kind === 'degenerate_loop') {
                recordSuccess(acq.account.id, usage);
                return;
            }
            lastErr = err;
            if (err instanceof CursorError) {
                recordFailure(acq.account.id, { rateLimited: err.isRateLimited, reason: err.message });
                console.error(`[Cursor] 账号 ${acq.account.name} 失败(${err.kind}/${err.status ?? '-'})，${err.retryable ? '尝试换号' : '不可重试'}`);
                if (!err.retryable) throw err;
            } else {
                recordFailure(acq.account.id, { rateLimited: false, reason: String(err) });
            }
            // 换号前短暂退避
            await new Promise(r => setTimeout(r, 500));
        }
    }

    if (lastErr) throw lastErr;
    const st = poolStatus();
    throw new CursorError('network',
        `账号池无可用账号（total=${st.total} 冷却=${st.coolingDown} 满载=${st.busy}）`);
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
    account?: AccountConnection,
): Promise<void> {
    const config = getConfig();
    const conn = resolveConnection(account);

    // ★ 选择请求目标：stealth proxy 或直连 Cursor API
    const useStealthProxy = !!conn.stealthProxyUrl;
    const targetUrl = useStealthProxy
        ? `${conn.stealthProxyUrl!.replace(/\/$/, '')}/proxy/chat`
        : CURSOR_CHAT_API;
    // stealth proxy 内部自带浏览器指纹，不需要 Chrome headers
    const headers = useStealthProxy
        ? { 'Content-Type': 'application/json' }
        : getChromeHeaders(conn);

    // 详细日志记录在 handler 层

    const controller = new AbortController();
    // 链接外部信号：外部中止时同步中止内部 controller
    if (externalSignal) {
        if (externalSignal.aborted) { controller.abort(); }
        else { externalSignal.addEventListener('abort', () => controller.abort(), { once: true }); }
    }

    // ★ 空闲超时（Idle Timeout）：用读取活动检测替换固定总时长超时。
    // 每次收到新数据时重置计时器，只有在指定时间内完全无数据到达时才中断。
    // 这样长输出（如写长文章、大量工具调用）不会因总时长超限被误杀。
    const IDLE_TIMEOUT_MS = config.timeout * 1000; // 复用 timeout 配置作为空闲超时阈值
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            console.warn(`[Cursor] 空闲超时（${config.timeout}s 无新数据），中止请求`);
            controller.abort();
        }, IDLE_TIMEOUT_MS);
    };

    // 启动初始计时（等待服务器开始响应）
    resetIdleTimer();

    try {
        // stealth proxy 时不需要额外的 proxy dispatcher（它自己就是代理）
        // 否则用账号绑定的出口代理（留空回退全局 proxy）
        const fetchOptions = useStealthProxy ? {} : getProxyFetchOptionsFor(conn.proxy);
        let resp: Response;
        try {
            resp = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(req),
                signal: controller.signal,
                ...fetchOptions,
            } as any);
        } catch (netErr) {
            // fetch 层错误（超时中止、连接失败、DNS 等）→ network 类，可重试/换号
            const m = netErr instanceof Error ? netErr.message : String(netErr);
            throw new CursorError('network', `Cursor 网络错误: ${m}`);
        }

        if (!resp.ok) {
            const body = await resp.text();
            throw new CursorError('http', `Cursor API 错误: HTTP ${resp.status} - ${body}`, {
                status: resp.status,
                bodySnippet: body.slice(0, 500),
            });
        }

        if (!resp.body) {
            throw new CursorError('no_body', 'Cursor API 响应无 body');
        }

        // 流式读取 SSE 响应
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // ★ 退化重复检测器 (#66)
        // 模型有时会陷入循环，不断输出 </s>、</br> 等无意义标记
        // 检测原理：跟踪最近的连续相同 delta，超过阈值则中止流
        let lastDelta = '';
        let repeatCount = 0;
        const REPEAT_THRESHOLD = 8;       // 同一 delta 连续出现 8 次 → 退化
        let degenerateAborted = false;

        // ★ HTML token 重复检测：历史消息较多时模型偶发连续输出 <br>、</s> 等 HTML token 的 bug
        // 用 tagBuffer 跨 delta 拼接，提取完整 token 后检测连续重复，不依赖换行
        let tagBuffer = '';
        let htmlRepeatAborted = false;
        const HTML_TOKEN_RE = /(<\/?[a-z][a-z0-9]*\s*\/?>|&[a-z]+;)/gi;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // 每次收到数据就重置空闲计时器
            resetIdleTimer();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event: CursorSSEEvent = JSON.parse(data);

                    // ★ 退化重复检测：当模型重复输出同一短文本片段时中止
                    if (event.type === 'text-delta' && event.delta) {
                        const trimmedDelta = event.delta.trim();
                        // 只检测短 token（长文本重复是正常的，比如重复的代码行）
                        if (trimmedDelta.length > 0 && trimmedDelta.length <= 20) {
                            if (trimmedDelta === lastDelta) {
                                repeatCount++;
                                if (repeatCount >= REPEAT_THRESHOLD) {
                                    console.warn(`[Cursor] ⚠️ 检测到退化循环: "${trimmedDelta}" 已连续重复 ${repeatCount} 次，中止流`);
                                    degenerateAborted = true;
                                    reader.cancel();
                                    break;
                                }
                            } else {
                                lastDelta = trimmedDelta;
                                repeatCount = 1;
                            }
                        } else {
                            // 长文本或空白 → 重置计数
                            lastDelta = '';
                            repeatCount = 0;
                        }

                        // ★ HTML token 重复检测：跨 delta 拼接，提取完整 HTML token 后检测连续重复
                        // 解决 <br>、</s>、&nbsp; 等被拆散发送或无换行导致退化检测失效的 bug
                        tagBuffer += event.delta;
                        const tagMatches = [...tagBuffer.matchAll(new RegExp(HTML_TOKEN_RE.source, 'gi'))];
                        if (tagMatches.length > 0) {
                            const lastTagMatch = tagMatches[tagMatches.length - 1];
                            tagBuffer = tagBuffer.slice(lastTagMatch.index! + lastTagMatch[0].length);
                            for (const m of tagMatches) {
                                const token = m[0].toLowerCase();
                                if (token === lastDelta) {
                                    repeatCount++;
                                    if (repeatCount >= REPEAT_THRESHOLD) {
                                        console.warn(`[Cursor] ⚠️ 检测到 HTML token 重复: "${token}" 已连续重复 ${repeatCount} 次，中止流`);
                                        htmlRepeatAborted = true;
                                        reader.cancel();
                                        break;
                                    }
                                } else {
                                    lastDelta = token;
                                    repeatCount = 1;
                                }
                            }
                            if (htmlRepeatAborted) break;
                        } else if (tagBuffer.length > 20) {
                            // 超过 20 字符还没有完整 HTML token，不是 HTML 序列，清空避免内存累积
                            tagBuffer = '';
                        }
                    }

                    onChunk(event);
                } catch {
                    // 非 JSON 数据，忽略
                }
            }

            if (degenerateAborted || htmlRepeatAborted) break;
        }

        // ★ 退化循环中止后，抛出特殊错误让外层 sendCursorRequest 不再重试
        if (degenerateAborted) {
            throw new CursorError('degenerate_loop', 'DEGENERATE_LOOP_ABORTED');
        }
        // ★ HTML token 重复中止后，抛出普通错误让外层 sendCursorRequest 走正常重试
        if (htmlRepeatAborted) {
            throw new CursorError('html_repeat', 'HTML_REPEAT_ABORTED');
        }

        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data) {
                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch { /* ignore */ }
            }
        }
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

/**
 * 发送非流式请求，收集完整响应及 usage 信息
 */
export async function sendCursorRequestFull(
    req: CursorChatRequest,
    account?: AccountConnection,
): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }> {
    let fullText = '';
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
        if (event.messageMetadata?.usage) {
            usage = event.messageMetadata.usage;
        }
    }, undefined, account);
    return { text: fullText, usage };
}
