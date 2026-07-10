/**
 * admin/admin-auth.ts - Admin API 鉴权（P5）
 *
 * 独立于业务鉴权（authTokens / client key）：Admin 端点用 config.adminApiKey。
 *  - adminApiKey 为空 → Admin API 整体禁用（返回 403，避免裸奔管理面）
 *  - 提供 Bearer / x-admin-key / ?admin_key= 三种传入
 *  - 常量时间比较，避免计时侧信道
 */

import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config.js';

/** 常量时间字符串比较（长度不等直接 false，但仍走一次比较以稳定耗时） */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
        // 长度不同必不相等；用自比较消耗对等时间，避免因提前返回泄露长度信息
        timingSafeEqual(ab, ab);
        return false;
    }
    return timingSafeEqual(ab, bb);
}

function extractKey(req: Request): string | undefined {
    const q = req.query.admin_key;
    if (typeof q === 'string' && q) return q;
    const h = req.headers['x-admin-key'] || req.headers['authorization'];
    if (!h) return undefined;
    return String(h).replace(/^Bearer\s+/i, '').trim() || undefined;
}

/** Express 中间件：校验 Admin API Key */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
    const adminKey = getConfig().adminApiKey;
    if (!adminKey) {
        res.status(403).json({ error: { message: 'Admin API 未启用（未配置 admin_api_key）', type: 'admin_disabled' } });
        return;
    }
    const provided = extractKey(req);
    if (!provided || !safeEqual(provided, adminKey)) {
        res.status(401).json({ error: { message: 'Admin 鉴权失败', type: 'admin_auth_error' } });
        return;
    }
    next();
}
