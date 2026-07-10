/**
 * test/unit-group-cascade.mjs
 *
 * 单元测试：账号分组管理器 + 级联（P4）
 * 运行方式：node test/unit-group-cascade.mjs
 *
 * 直接测编译产物 dist/groups/group.js（纯逻辑，不触网）。
 * 覆盖：CRUD、renameGroup 级联账号+key、deleteGroup 清空引用、count。
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const P = join(tmpdir(), `c2a-grp-${process.pid}`);
process.env.GROUPS_FILE = P + '-groups.json';
process.env.ACCOUNTS_FILE = P + '-accounts.json';
process.env.CLIENT_KEYS_FILE = P + '-keys.json';

const grp = await import('../dist/groups/group.js');
const acc = await import('../dist/accounts/account.js');
const ck = await import('../dist/keys/client-key.js');

// ─── 测试框架 ─────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅  ${name}`); passed++; }
    catch (e) { console.error(`  ❌  ${name}\n      ${e.message}`); failed++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// 清空初始
for (const g of grp.listGroups()) grp.deleteGroup(g.id);
for (const a of acc.listAccounts()) acc.deleteAccount?.(a.id);
for (const k of ck.listClientKeys()) ck.deleteClientKey(k.id);

console.log('\n👥 分组管理器 + 级联\n');

test('addGroup 生成 id 与缺省字段', () => {
    const g = grp.addGroup({ name: 'team-a' });
    ok(g.id.startsWith('grp_'), 'id 前缀 grp_');
    eq(g.name, 'team-a', 'name 保留');
    ok(g.createdAt, 'createdAt 有值');
    eq(grp.groupCount(), 1, 'count=1');
});

test('getGroup / listGroups 返回副本', () => {
    const g = grp.addGroup({ name: 'team-b' });
    const got = grp.getGroup(g.id);
    eq(got.name, 'team-b', 'getGroup 命中');
    const list = grp.listGroups();
    const item = list.find(x => x.id === g.id);
    item.name = 'MUT';
    eq(grp.getGroup(g.id).name, 'team-b', '内存态未被污染');
});

test('renameGroup 级联更新引用该组的账号与 client key', () => {
    const g = grp.addGroup({ name: 'oldname' });
    const a = acc.addAccount({ name: 'acc1', cookie: 'c', group: 'oldname' });
    const k = ck.addClientKey({ name: 'key1', group: 'oldname' });
    // 无关引用（不同组）不应被动到
    const a2 = acc.addAccount({ name: 'acc2', cookie: 'c', group: 'other' });

    grp.renameGroup(g.id, 'newname');

    eq(grp.getGroup(g.id).name, 'newname', '组名已改');
    eq(acc.getAccount(a.id).group, 'newname', '账号 group 级联改名');
    eq(ck.getClientKey(k.id).group, 'newname', 'client key group 级联改名');
    eq(acc.getAccount(a2.id).group, 'other', '无关账号不受影响');
});

test('deleteGroup 清空引用该组的账号与 client key 的 group', () => {
    const g = grp.addGroup({ name: 'todelete' });
    const a = acc.addAccount({ name: 'acc3', cookie: 'c', group: 'todelete' });
    const k = ck.addClientKey({ name: 'key2', group: 'todelete' });

    ok(grp.deleteGroup(g.id), '删除返回 true');
    eq(grp.getGroup(g.id), undefined, '组已删除');
    eq(acc.getAccount(a.id).group, undefined, '账号 group 被清空（回落全池）');
    eq(ck.getClientKey(k.id).group, undefined, 'client key group 被清空');
});

test('deleteGroup 对不存在的 id 返回 false', () => {
    eq(grp.deleteGroup('grp_nonexist'), false, '删不存在返回 false');
});

test('renameGroup 对不存在的 id 返回 undefined', () => {
    eq(grp.renameGroup('grp_nonexist', 'x'), undefined, '改不存在返回 undefined');
});

// ─── 汇总 ─────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
console.log('═══════════════════════════════════════\n');
for (const suffix of ['-groups.json', '-accounts.json', '-keys.json']) {
    try { rmSync(P + suffix, { force: true }); rmSync(P + suffix + '.tmp', { force: true }); } catch { /* ignore */ }
}
process.exit(failed > 0 ? 1 : 0);
