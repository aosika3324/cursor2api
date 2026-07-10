/**
 * test/unit-proxy-pool.mjs
 *
 * 单元测试：代理池管理器（S3）—— 纯逻辑（批量去重、轮询分配），不触网。
 * checkProxy/checkAllProxies 依赖网络，不在此测（由集成冒烟覆盖）。
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const P = join(tmpdir(), `c2a-px-${process.pid}`);
process.env.PROXIES_FILE = P + '-proxies.json';
process.env.ACCOUNTS_FILE = P + '-accounts.json';

const px = await import('../dist/proxies/proxy.js');
const acc = await import('../dist/accounts/account.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`  ✅  ${name}`); passed++; } catch (e) { console.error(`  ❌  ${name}\n      ${e.message}`); failed++; } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, m) { if (!v) throw new Error(m || 'expected truthy'); }

for (const p of px.listProxies()) px.deleteProxy(p.id);
for (const a of acc.listAccounts()) acc.deleteAccount(a.id);

console.log('\n🌐 代理池 + 轮询分配\n');

test('addProxy 生成缺省字段', () => {
    const p = px.addProxy({ url: 'http://h1:8080' });
    ok(p.id.startsWith('px_'), 'id 前缀');
    eq(p.enabled, true, 'enabled 默认');
    eq(p.health, 'unknown', 'health 默认');
    eq(px.proxyCount(), 1, 'count=1');
});

test('batchAddProxies 去重 + 跳过空行/注释', () => {
    // 已有 http://h1:8080；重复应被跳过
    const added = px.batchAddProxies('http://h1:8080\n# comment\n\nhttp://h2:8080\nsocks5://h3:1080');
    eq(added.length, 2, '仅 h2/h3 新增');
    eq(px.proxyCount(), 3, '总数 3');
});

test('assignRoundRobin: 无可用代理返回 0', () => {
    // 全部标记 unhealthy 或禁用 → 无可用
    for (const p of px.listProxies()) px.setProxyEnabled(p.id, false);
    const r = px.assignRoundRobin();
    eq(r.assigned, 0, 'assigned=0');
    eq(r.proxiesUsed, 0, 'proxiesUsed=0');
});

test('assignRoundRobin: 轮询把代理循环分配到账号', () => {
    // 启用 2 个代理（h1,h2），建 5 个账号 → 轮询 h1,h2,h1,h2,h1
    const all = px.listProxies();
    px.setProxyEnabled(all[0].id, true); // h1
    px.setProxyEnabled(all[1].id, true); // h2
    const urls = [all[0].url, all[1].url];
    for (let i = 0; i < 5; i++) acc.addAccount({ name: 'a' + i, cookie: 'c' + i });
    const r = px.assignRoundRobin();
    eq(r.proxiesUsed, 2, '2 个可用代理');
    eq(r.assigned, 5, '5 个账号被分配');
    const proxied = acc.listAccounts().map(a => a.proxy);
    // 每个账号的 proxy 必在 urls 集合内
    ok(proxied.every(p => urls.includes(p)), '所有账号 proxy 均来自可用集合');
    // 至少用到两个不同代理（轮询）
    ok(new Set(proxied).size === 2, '轮询用到 2 个不同代理');
});

test('deleteProxy 生效', () => {
    const first = px.listProxies()[0];
    ok(px.deleteProxy(first.id), '删除返回 true');
    eq(px.deleteProxy('px_nope'), false, '删不存在 false');
});

console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
console.log('═══════════════════════════════════════\n');
for (const s of ['-proxies.json', '-accounts.json']) { try { rmSync(P + s, { force: true }); rmSync(P + s + '.tmp', { force: true }); } catch { /* */ } }
process.exit(failed > 0 ? 1 : 0);
