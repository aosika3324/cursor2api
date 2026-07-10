/**
 * test/unit-client-key.mjs
 *
 * 单元测试：下游客户端 Key 管理器（P3）
 * 运行方式：node test/unit-client-key.mjs
 *
 * 直接测编译产物 dist/keys/client-key.js（纯逻辑，不触网）。
 * 覆盖：CRUD、csk_ 生成、findByKey(禁用/启用)、recordUsage 累计、count。
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TMP = join(tmpdir(), `c2a-keys-${process.pid}.json`);
process.env.CLIENT_KEYS_FILE = TMP;

const ck = await import('../dist/keys/client-key.js');

// ─── 测试框架 ─────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅  ${name}`); passed++; }
    catch (e) { console.error(`  ❌  ${name}\n      ${e.message}`); failed++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// 清空初始状态
for (const k of ck.listClientKeys()) ck.deleteClientKey(k.id);

console.log('\n🔑 客户端 Key 管理器\n');

test('addClientKey 自动生成 csk_ 密钥与缺省字段', () => {
    const k = ck.addClientKey({ name: 'A' });
    ok(k.id.startsWith('ck_'), 'id 前缀 ck_');
    ok(k.key.startsWith('csk_'), 'key 前缀 csk_');
    ok(k.key.length > 20, 'key 足够长');
    eq(k.disabled, false, 'disabled 默认 false');
    eq(k.totalCalls, 0, 'totalCalls 默认 0');
    eq(ck.clientKeyCount(), 1, 'count=1');
});

test('addClientKey 可指定自定义 key', () => {
    const k = ck.addClientKey({ name: 'B', key: 'csk_custom123' });
    eq(k.key, 'csk_custom123', '保留自定义 key');
});

test('findByKey 命中启用中的 key', () => {
    const created = ck.addClientKey({ name: 'C', key: 'csk_lookup' });
    const found = ck.findByKey('csk_lookup');
    ok(found, '应命中');
    eq(found.id, created.id, 'id 一致');
});

test('findByKey 对未知 key 返回 undefined', () => {
    eq(ck.findByKey('csk_nope'), undefined, '未知 key → undefined');
});

test('findByKey 对已禁用 key 返回 undefined', () => {
    const k = ck.addClientKey({ name: 'D', key: 'csk_disabled' });
    ck.setDisabled(k.id, true);
    eq(ck.findByKey('csk_disabled'), undefined, '禁用 key → undefined');
    // 重新启用后可命中
    ck.setDisabled(k.id, false);
    ok(ck.findByKey('csk_disabled'), '启用后可命中');
});

test('recordUsage 累计调用与 token', () => {
    const k = ck.addClientKey({ name: 'E', key: 'csk_usage' });
    ck.recordUsage(k.id, { inputTokens: 100, outputTokens: 30 });
    ck.recordUsage(k.id, { inputTokens: 50, outputTokens: 20 });
    const after = ck.getClientKey(k.id);
    eq(after.totalCalls, 2, 'totalCalls=2');
    eq(after.totalInputTokens, 150, 'inputTokens 累计');
    eq(after.totalOutputTokens, 50, 'outputTokens 累计');
    ok(after.lastUsedAt, 'lastUsedAt 已更新');
});

test('recordUsage 缺省 token 也累计调用次数', () => {
    const k = ck.addClientKey({ name: 'F', key: 'csk_notok' });
    ck.recordUsage(k.id);
    const after = ck.getClientKey(k.id);
    eq(after.totalCalls, 1, 'totalCalls=1');
    eq(after.totalInputTokens, 0, 'input=0');
});

test('updateClientKey 只改白名单字段', () => {
    const k = ck.addClientKey({ name: 'G', key: 'csk_upd' });
    const upd = ck.updateClientKey(k.id, { name: 'G2', group: 'team1', key: 'csk_HACK' });
    eq(upd.name, 'G2', 'name 已改');
    eq(upd.group, 'team1', 'group 已改');
    eq(upd.key, 'csk_upd', 'key 不可被 update 篡改');
});

test('deleteClientKey 生效', () => {
    const before = ck.clientKeyCount();
    const k = ck.addClientKey({ name: 'H' });
    eq(ck.clientKeyCount(), before + 1, '+1');
    ok(ck.deleteClientKey(k.id), '删除返回 true');
    eq(ck.clientKeyCount(), before, '回到原数量');
    eq(ck.deleteClientKey('ck_nonexist'), false, '删不存在返回 false');
});

test('listClientKeys 返回副本(外部改动不影响内存态)', () => {
    const k = ck.addClientKey({ name: 'I', key: 'csk_copy' });
    const list = ck.listClientKeys();
    const item = list.find(x => x.id === k.id);
    item.name = 'MUTATED';
    eq(ck.getClientKey(k.id).name, 'I', '内存态未被外部改动污染');
});

// ─── 汇总 ─────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
console.log('═══════════════════════════════════════\n');
try { rmSync(TMP, { force: true }); rmSync(TMP + '.tmp', { force: true }); } catch { /* ignore */ }
process.exit(failed > 0 ? 1 : 0);
