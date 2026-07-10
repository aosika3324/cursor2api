/**
 * request-context.ts - 请求级上下文（P4）
 *
 * 用 AsyncLocalStorage 携带「本次请求」的下游 key / 分组 / 最终账号，
 * 避免把这些参数穿透 18 个 sendCursorRequest* 调用点（P1/P2 一直刻意避免的侵入）。
 *
 * 写入方：
 *  - 鉴权中间件 run() 包裹整条请求链，注入 clientKeyId + group
 *  - pooledAttempt 命中账号后 setAccountId()，供链路追踪回填
 * 读取方：
 *  - cursor-client.pooledAttempt 读 group 做分组隔离路由
 *  - logger.complete 读 clientKeyId/accountId 落进 trace
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface RequestCtx {
    clientKeyId?: string;
    /** 下游 key 绑定的分组（限定只能路由到同组账号）；空 = 不限制 */
    group?: string;
    /** 本请求最终使用的上游账号 id（由调度器命中后回填） */
    accountId?: string;
}

const als = new AsyncLocalStorage<RequestCtx>();

/** 在给定上下文内运行 fn（中间件包裹请求链用） */
export function runWithContext<T>(ctx: RequestCtx, fn: () => T): T {
    return als.run(ctx, fn);
}

/** 取当前请求上下文（不在请求链内则 undefined） */
export function getContext(): RequestCtx | undefined {
    return als.getStore();
}

/** 回填本请求最终命中的账号 id（链路追踪用） */
export function setAccountId(accountId: string): void {
    const ctx = als.getStore();
    if (ctx) ctx.accountId = accountId;
}
