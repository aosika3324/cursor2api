/**
 * accounts/scheduler.ts - 账号调度器
 *
 * 职责：从账号池中按策略选一个「当前可用」账号并占用一个并发槽。
 *  - 候选过滤：未禁用 && 未冷却 && 未超单账号并发上限 && 分组匹配 && 未在本次已试列表
 *  - 策略：priority（优先级升序，同级取 inFlight 最小）| balanced（P2C 取更空闲者）
 *  - 并发槽：inFlight 计数在内存维护，acquire 原子占用，release 归还
 *
 * acquire() 同步执行（pick+reserve 之间无 await），故在单线程事件循环中是原子的。
 */

import type { CursorAccount } from '../types.js';
import { getConfig } from '../config.js';
import { _liveAccounts, isCoolingDown } from './account.js';

export interface AcquireResult {
    account: CursorAccount;
    release: () => void;
}

/** 每账号在途请求数（内存态） */
const inFlight = new Map<string, number>();

function count(id: string): number {
    return inFlight.get(id) || 0;
}

function maxConc(a: CursorAccount): number {
    return a.maxConcurrency ?? getConfig().accountMaxConcurrency ?? 2;
}

/** balanced 策略：Power-of-Two-Choices，随机取两个候选中 inFlight 较小者 */
function pickBalanced(candidates: CursorAccount[]): CursorAccount {
    if (candidates.length === 1) return candidates[0];
    const i = Math.floor(Math.random() * candidates.length);
    let j = Math.floor(Math.random() * candidates.length);
    if (j === i) j = (j + 1) % candidates.length;
    return count(candidates[i].id) <= count(candidates[j].id) ? candidates[i] : candidates[j];
}

/**
 * 选一个可用账号并占用并发槽。无可用时返回 null。
 * @param opts.group   仅在该分组内选（P4 分组隔离用；P2 传 undefined = 全池）
 * @param opts.exclude 本次请求已试过的账号 id（故障转移时排除）
 */
export function acquire(opts?: { group?: string; exclude?: Set<string> }): AcquireResult | null {
    const live = _liveAccounts();
    let candidates = live.filter(a =>
        !a.disabled &&
        !isCoolingDown(a) &&
        count(a.id) < maxConc(a),
    );
    if (opts?.group) candidates = candidates.filter(a => a.group === opts.group);
    if (opts?.exclude) candidates = candidates.filter(a => !opts.exclude!.has(a.id));
    if (candidates.length === 0) return null;

    const mode = getConfig().loadBalancingMode ?? 'priority';
    let chosen: CursorAccount;
    if (mode === 'balanced') {
        chosen = pickBalanced(candidates);
    } else {
        candidates.sort((a, b) => a.priority - b.priority || count(a.id) - count(b.id));
        chosen = candidates[0];
    }

    inFlight.set(chosen.id, count(chosen.id) + 1);
    let released = false;
    return {
        account: chosen,
        release: () => {
            if (released) return;
            released = true;
            inFlight.set(chosen.id, Math.max(0, count(chosen.id) - 1));
        },
    };
}

/** 当前在途数（供 Admin 并发监控） */
export function getInFlight(id: string): number {
    return count(id);
}

/**
 * 池概览（供 Admin / 排障）：区分「全部冷却」与「全部满载」。
 */
export function poolStatus(group?: string): { total: number; usable: number; busy: number; coolingDown: number } {
    const live = _liveAccounts().filter(a => !group || a.group === group);
    let usable = 0, busy = 0, cooling = 0;
    for (const a of live) {
        if (a.disabled) continue;
        if (isCoolingDown(a)) { cooling++; continue; }
        if (count(a.id) >= maxConc(a)) { busy++; continue; }
        usable++;
    }
    return { total: live.length, usable, busy, coolingDown: cooling };
}
