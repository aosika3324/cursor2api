/**
 * proxy-agent.ts - 代理支持模块
 *
 * 职责：
 * 根据 config.proxy 或 PROXY 环境变量创建 undici ProxyAgent，
 * 让 Node.js 原生 fetch() 能通过 HTTP/HTTPS 代理发送请求。
 *
 * Node.js 内置的 fetch (基于 undici) 不会自动读取 HTTP_PROXY / HTTPS_PROXY
 * 环境变量，必须显式传入 dispatcher (ProxyAgent) 才能走代理。
 */

import { ProxyAgent } from 'undici';
import { getConfig } from './config.js';

let cachedAgent: ProxyAgent | undefined;
let cachedVisionAgent: ProxyAgent | undefined;
/** 按 proxy URL 缓存的 per-account dispatcher（避免每请求重建 ProxyAgent） */
const perProxyAgents = new Map<string, ProxyAgent>();

/**
 * 为指定 proxy URL 获取（或复用）dispatcher。
 * 传入 undefined/空串时回退到全局 proxy 行为（getProxyFetchOptions）。
 * 供账号池：每个账号可绑定各自出口代理，避免共用 IP 被 Cursor 级联限流。
 */
export function getProxyFetchOptionsFor(proxyUrl?: string): Record<string, unknown> {
    const url = proxyUrl?.trim();
    if (!url) return getProxyFetchOptions();
    let agent = perProxyAgents.get(url);
    if (!agent) {
        console.log(`[Proxy] 账号专用代理: ${url}`);
        agent = new ProxyAgent(url);
        perProxyAgents.set(url, agent);
    }
    return { dispatcher: agent };
}

/**
 * 获取代理 dispatcher（如果配置了 proxy）
 * 返回 undefined 表示不使用代理（直连）
 */
export function getProxyDispatcher(): ProxyAgent | undefined {
    const config = getConfig();
    const proxyUrl = config.proxy;

    if (!proxyUrl) return undefined;

    if (!cachedAgent) {
        console.log(`[Proxy] 使用全局代理: ${proxyUrl}`);
        cachedAgent = new ProxyAgent(proxyUrl);
    }

    return cachedAgent;
}

/**
 * 构建 fetch 的额外选项（包含 dispatcher）
 * 用法: fetch(url, { ...options, ...getProxyFetchOptions() })
 */
export function getProxyFetchOptions(): Record<string, unknown> {
    const dispatcher = getProxyDispatcher();
    return dispatcher ? { dispatcher } : {};
}

/**
 * ★ Vision 独立代理：优先使用 vision.proxy，否则回退到全局 proxy
 * Cursor API 国内可直连不需要代理，但图片分析 API 可能需要
 */
export function getVisionProxyFetchOptions(): Record<string, unknown> {
    const config = getConfig();
    const visionProxy = config.vision?.proxy;

    if (visionProxy) {
        if (!cachedVisionAgent) {
            console.log(`[Proxy] Vision 独立代理: ${visionProxy}`);
            cachedVisionAgent = new ProxyAgent(visionProxy);
        }
        return { dispatcher: cachedVisionAgent };
    }

    // 回退到全局代理
    return getProxyFetchOptions();
}
