/**
 * groups/group.ts - 账号分组管理器（P4）
 *
 * 分组是「客户端 Key ↔ 上游账号」的隔离边界：
 *  - 账号可归入某组（CursorAccount.group）
 *  - client key 可绑定某组（ClientKey.group）→ 只能路由到同组账号（调度器 acquire({group})）
 *
 * 结构与其它 manager 对称（groups.json 原子落盘）。
 * 改名/删除做级联，避免悬挂引用：
 *  - renameGroup：把引用旧名的账号与 key 一并改到新名
 *  - deleteGroup：把引用该组的账号与 key 的 group 清空（回落到全池）
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from 'fs';
import type { Group } from '../types.js';
import { listAccounts, updateAccount } from '../accounts/account.js';
import { listClientKeys, updateClientKey } from '../keys/client-key.js';

const GROUPS_FILE = process.env.GROUPS_FILE || './groups.json';

let groups: Group[] = [];
let loaded = false;

function genId(): string {
    return 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function nowIso(): string {
    return new Date().toISOString();
}

function persist(): void {
    try {
        const tmp = GROUPS_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(groups, null, 2), 'utf-8');
        renameSync(tmp, GROUPS_FILE);
    } catch (e) {
        console.error('[Groups] 持久化失败:', e);
    }
}

function normalize(g: Partial<Group>): Group {
    return {
        id: g.id || genId(),
        name: g.name || 'group',
        createdAt: g.createdAt || nowIso(),
    };
}

export function loadGroups(): void {
    if (loaded) return;
    loaded = true;
    if (existsSync(GROUPS_FILE)) {
        try {
            const raw = JSON.parse(readFileSync(GROUPS_FILE, 'utf-8'));
            if (Array.isArray(raw)) groups = raw.map(normalize);
        } catch (e) {
            console.error('[Groups] 读取 groups.json 失败，将从空表启动:', e);
            groups = [];
        }
    }
}

// ==================== 查询 ====================

export function listGroups(): Group[] {
    if (!loaded) loadGroups();
    return groups.map(g => ({ ...g }));
}

export function getGroup(id: string): Group | undefined {
    if (!loaded) loadGroups();
    const g = groups.find(x => x.id === id);
    return g ? { ...g } : undefined;
}

export function groupCount(): number {
    if (!loaded) loadGroups();
    return groups.length;
}

// ==================== 变更（含级联） ====================

export function addGroup(input: Partial<Group>): Group {
    if (!loaded) loadGroups();
    const g = normalize(input);
    groups.push(g);
    persist();
    return { ...g };
}

/**
 * 改名并级联：把所有引用旧名的账号 / client key 一并改到新名。
 * 分组的引用以「名字」为准（账号/key 存的是 group 名，非 id），故改名必须级联。
 */
export function renameGroup(id: string, newName: string): Group | undefined {
    if (!loaded) loadGroups();
    const g = groups.find(x => x.id === id);
    if (!g) return undefined;
    const oldName = g.name;
    g.name = newName;
    persist();
    if (oldName !== newName) {
        for (const a of listAccounts()) {
            if (a.group === oldName) updateAccount(a.id, { group: newName });
        }
        for (const k of listClientKeys()) {
            if (k.group === oldName) updateClientKey(k.id, { group: newName });
        }
    }
    return { ...g };
}

/**
 * 删除并级联：把引用该组的账号 / client key 的 group 清空（回落到全池 / 无隔离）。
 */
export function deleteGroup(id: string): boolean {
    if (!loaded) loadGroups();
    const g = groups.find(x => x.id === id);
    if (!g) return false;
    const name = g.name;
    groups = groups.filter(x => x.id !== id);
    persist();
    for (const a of listAccounts()) {
        if (a.group === name) updateAccount(a.id, { group: undefined });
    }
    for (const k of listClientKeys()) {
        if (k.group === name) updateClientKey(k.id, { group: undefined });
    }
    return true;
}
