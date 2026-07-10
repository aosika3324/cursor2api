/**
 * cursor-error.ts - 上游 Cursor 请求的结构化错误
 *
 * 背景：原先 cursor-client 把上游失败拼成 `Error("Cursor API 错误: HTTP 429 ...")`
 * 字符串，调度器无法据此区分「限流(429/403)→冷却换号」与「普通瞬态错误→重试」。
 * 本类型携带 HTTP status 与错误种类，供 P2 调度器做故障转移决策。
 */

export type CursorErrorKind =
    | 'http'            // 上游返回非 2xx（携带 status）
    | 'no_body'         // 响应无 body
    | 'degenerate_loop' // 退化循环中止（不重试，已有内容有效）
    | 'html_repeat'     // HTML token 重复中止（可重试）
    | 'network';        // fetch/网络层错误（超时、连接失败等）

export class CursorError extends Error {
    /** HTTP 状态码；仅 kind==='http' 时有值 */
    readonly status?: number;
    /** 上游响应体片段（截断，便于日志排查） */
    readonly bodySnippet?: string;
    readonly kind: CursorErrorKind;

    constructor(kind: CursorErrorKind, message: string, opts?: { status?: number; bodySnippet?: string }) {
        super(message);
        this.name = 'CursorError';
        this.kind = kind;
        this.status = opts?.status;
        this.bodySnippet = opts?.bodySnippet;
    }

    /** 账号级限流：429（速率/风控）或 403（cookie 失效/被 Vercel 拦） → 冷却并换号 */
    get isRateLimited(): boolean {
        return this.status === 429 || this.status === 403;
    }

    /** 是否值得换个账号/重试（退化循环例外：已有内容有效，不重试） */
    get retryable(): boolean {
        if (this.kind === 'degenerate_loop') return false;
        if (this.kind === 'http') {
            // 4xx（除 429/403 限流外）多为请求本身问题，重试无益
            if (this.status && this.status >= 400 && this.status < 500) {
                return this.isRateLimited;
            }
            return true; // 5xx 等服务端错误可重试
        }
        return true; // html_repeat / network / no_body 可重试
    }
}

/** 类型守卫 */
export function isCursorError(e: unknown): e is CursorError {
    return e instanceof CursorError;
}
