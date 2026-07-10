/**
 * test/unit-account-scheduler.mjs
 *
 * 单元测试：账号池 (AccountManager) + 调度器 (Scheduler)
 * 运行方式：node test/unit-account-scheduler.mjs
 *
 * 直接测编译产物 dist/accounts/*.js（纯逻辑，不触网）。
 * 覆盖：CRUD、优先级选号、并发槽、429/403 冷却、连续失败冷却、
 *      故障转移 exclude、clearCooldown、用量累计、poolStatus。
 */

// 必须在 import 前设置 env：让账号管理器用临时文件、可控的冷却/并发参数
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TMP = join(tmpdir(), `c2a-accts-${process.pid}.json`);
process.env.ACCOUNTS_FILE = TMP;
process.env.ACCOUNT_MAX_CONCURRENCY = '2';
process.env.ACCOUNT_COOLDOWN_SECS = '1800';
process.env.ACCOUNT_FAILURE_THRESHOLD = '3';
process.env.ACCOUNT_FAILURE_COOLDOWN_SECS = '60';
process.env.LOAD_BALANCING_MODE = 'priority';
// 清掉可能干扰迁移的全局 cookie
delete process.env.CURSOR_COOKIE;

const acct = await import('../dist/accounts/account.js');
const sched = await import('../dist/accounts/scheduler.js');

// ─── 测试框架 ─────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅  ${name}`); passed++; }
    catch (e) { console.error(`  ❌  ${name}\n      ${e.message}`); failed++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// 清空初始状态（防迁移/残留）
for (const a of acct.listAccounts()) acct.deleteAccount(a.id);

console.log('\n📦 账号池 + 调度器\n');

test('addAccount / listAccounts 补全缺省字段', () => {
    const a = acct.addAccount({ name: 'A', cookie: 'ck-A', priority: 1 });
    ok(a.id.startsWith('acc_'), 'id 前缀');
    eq(a.disabled, false, 'disabled 默认');
    eq(a.totalCalls, 0, 'totalCalls 默认');
    eq(a.consecutiveFailures, 0, 'consecutiveFailures 默认');
    eq(acct.accountCount(), 1, 'count');
});

test('priority 选号：低 priority 优先', () => {
    acct.addAccount({ name: 'B', cookie: 'ck-B', priority: 0 }); // 更优先
    const acq = sched.acquire();
    ok(acq, '应取到账号');
    eq(acq.account.name, 'B', '应选 priority=0 的 B');
    acq.release();
});

test('并发槽：单账号超 maxConcurrency(2) 后不可再取', () => {
    // 只保留一个账号，逼近并发上限
    for (const a of acct.listAccounts()) acct.deleteAccount(a.id);
    const solo = acct.addAccount({ name: 'Solo', cookie: 'ck', priority: 0 });
    const a1 = sched.acquire(); ok(a1, '第1次可取');
    const a2 = sched.acquire(); ok(a2, '第2次可取');
    eq(sched.getInFlight(solo.id), 2, 'inFlight=2');
    const a3 = sched.acquire(); eq(a3, null, '第3次应满载返回 null');
    a1.release();
    eq(sched.getInFlight(solo.id), 1, 'release 后 inFlight=1');
    const a4 = sched.acquire(); ok(a4, 'release 后又可取');
    a2.release(); a4.release();
    eq(sched.getInFlight(solo.id), 0, '全部归还');
});

test('429/403 限流 → 立即冷却，调度器跳过', () => {
    for (const a of acct.listAccounts()) acct.deleteAccount(a.id);
    const hot = acct.addAccount({ name: 'Hot', cookie: 'ck', priority: 0 });
    acct.recordFailure(hot.id, { rateLimited: true, reason: 'HTTP 429' });
    const after = acct.getAccount(hot.id);
    ok(after.cooldownUntil, '应设置 cooldownUntil');
    ok(acct.isCoolingDown(after), 'isCoolingDown=true');
    eq(sched.acquire(), null, '冷却中不可调度');
});

test('clearCooldown 恢复可调度', () => {
    const [hot] = acct.listAccounts();
    acct.clearCooldown(hot.id);
    const after = acct.getAccount(hot.id);
    eq(after.cooldownUntil, undefined, 'cooldown 已清');
    eq(after.consecutiveFailures, 0, '失败计数已清');
    const acq = sched.acquire(); ok(acq, '恢复后可取'); acq.release();
});

test('连续失败达阈值(3) → 临时冷却', () => {
    for (const a of acct.listAccounts()) acct.deleteAccount(a.id);
    const f = acct.addAccount({ name: 'Flaky', cookie: 'ck', priority: 0 });
    acct.recordFailure(f.id, { rateLimited: false, reason: 'net1' });
    acct.recordFailure(f.id, { rateLimited: false, reason: 'net2' });
    ok(!acct.isCoolingDown(acct.getAccount(f.id)), '2 次尚未冷却');
    acct.recordFailure(f.id, { rateLimited: false, reason: 'net3' });
    ok(acct.isCoolingDown(acct.getAccount(f.id)), '第3次触发临时冷却');
});

test('recordSuccess 清零失败计数并累计用量', () => {
    for (const a of acct.listAccounts()) acct.deleteAccount(a.id);
    const s = acct.addAccount({ name: 'Succ', cookie: 'ck', priority: 0 });
    acct.recordFailure(s.id, { rateLimited: false, reason: 'x' });
    acct.recordSuccess(s.id, { inputTokens: 100, outputTokens: 40 });
    const after = acct.getAccount(s.id);
    eq(after.consecutiveFailures, 0, '失败计数清零');
    eq(after.totalCalls, 1, 'totalCalls');
    eq(after.totalInputTokens, 100, 'inputTokens');
    eq(after.totalOutputTokens, 40, 'outputTokens');
    ok(after.lastUsedAt, 'lastUsedAt 已更新');
});

test('故障转移 exclude：排除已试账号', () => {
    for (const a of acct.listAccounts()) acct.deleteAccount(a.id);
    const a1 = acct.addAccount({ name: 'X1', cookie: 'ck', priority: 0 });
    const a2 = acct.addAccount({ name: 'X2', cookie: 'ck', priority: 1 });
    const first = sched.acquire(); eq(first.account.id, a1.id, '首选 priority=0');
    first.release();
    const second = sched.acquire({ exclude: new Set([a1.id]) });
    eq(second.account.id, a2.id, 'exclude 后取 X2');
    second.release();
    const none = sched.acquire({ exclude: new Set([a1.id, a2.id]) });
    eq(none, null, '全部 exclude → null');
});

test('disabled 账号不参与调度', () => {
    for (const a of acct.listAccounts()) acct.deleteAccount(a.id);
    const d = acct.addAccount({ name: 'Dis', cookie: 'ck', priority: 0, disabled: true });
    eq(sched.acquire(), null, 'disabled → 不可取');
    acct.setDisabled(d.id, false);
    const acq = sched.acquire(); ok(acq, '启用后可取'); acq.release();
});

test('poolStatus 统计正确', () => {
    for (const a of acct.listAccounts()) acct.deleteAccount(a.id);
    const ok1 = acct.addAccount({ name: 'ok1', cookie: 'ck', priority: 0 });
    acct.addAccount({ name: 'dis', cookie: 'ck', priority: 0, disabled: true });
    const cool = acct.addAccount({ name: 'cool', cookie: 'ck', priority: 0 });
    acct.recordFailure(cool.id, { rateLimited: true });
    const st = sched.poolStatus();
    eq(st.total, 3, 'total=3');
    eq(st.coolingDown, 1, 'coolingDown=1');
    ok(st.usable >= 1, 'usable≥1');
    void ok1;
});

// ─── 汇总 ─────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
console.log('═══════════════════════════════════════\n');
try { rmSync(TMP, { force: true }); rmSync(TMP + '.tmp', { force: true }); } catch { /* ignore */ }
process.exit(failed > 0 ? 1 : 0);
