/* Cursor2API Admin v2 — vanilla 单页，无构建
   7 tab: 概览/账号池/客户端Key/代理池/分组/日志/设置
   鉴权: admin_api_key 存 localStorage，所有 /api/admin/* 带 Authorization: Bearer */
'use strict';

const LS_KEY = 'cursor2api_admin_key';
const LS_THEME = 'cursor2api_admin_theme';
let adminKey = localStorage.getItem(LS_KEY) || '';
let cache = { accounts: [], keys: [], groups: [], proxies: [] };
let selected = new Set(); // 账号批量选择

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Authorization': 'Bearer ' + adminKey }, opts.headers || {});
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api/admin' + path, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 || r.status === 403) {
    if (document.getElementById('app').style.display !== 'none') {
      const j = await r.json().catch(() => ({}));
      logout(j.error && j.error.message);
    }
    throw new Error('unauthorized');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- toast ----------
let toastT;
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'on' + (isErr ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (el.className = ''), 2800);
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const b = document.getElementById('themeBtn'); if (b) b.textContent = t === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem(LS_THEME, next); applyTheme(next);
}
applyTheme(localStorage.getItem(LS_THEME) || 'light');

// ---------- login ----------
async function doLogin() {
  const v = document.getElementById('adminKeyIn').value.trim();
  const errEl = document.getElementById('loginErr'); errEl.textContent = '';
  if (!v) return;
  adminKey = v;
  try { await api('/stats'); localStorage.setItem(LS_KEY, v); showApp(); }
  catch (e) { adminKey = ''; errEl.textContent = e.message === 'unauthorized' ? 'Key 无效或 Admin API 未启用' : e.message; }
}
function logout(msg) {
  localStorage.removeItem(LS_KEY); adminKey = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  if (msg) document.getElementById('loginErr').textContent = msg;
}
function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  loadOverview(); reloadAll();
}

// ---------- tabs ----------
function switchTab(name) {
  document.querySelectorAll('nav button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + name));
  if (name === 'overview') loadOverview();
  if (name === 'proxies') renderProxies();
  if (name === 'logs') loadLogs();
  if (name === 'settings') loadSettings();
}

// ---------- data load ----------
async function reloadAll() {
  try {
    const [a, k, g, p] = await Promise.all([api('/accounts'), api('/client-keys'), api('/groups'), api('/proxies')]);
    cache.accounts = a.accounts || []; cache.keys = k.keys || [];
    cache.groups = g.groups || []; cache.proxies = p.proxies || [];
    renderAccounts(); renderKeys(); renderGroups(); renderProxies();
  } catch (e) { if (e.message !== 'unauthorized') toast(e.message, true); }
}

// ---------- overview ----------
async function loadOverview() {
  const wrap = document.getElementById('overviewWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const [sys, stats] = await Promise.all([api('/health/system'), api('/stats')]);
    const box = (v, l, cls) => `<div class="box"><div class="v ${cls || ''}">${v}</div><div class="l">${l}</div></div>`;
    const st = sys.stealth, up = sys.upstream, pool = sys.pool;
    const db = stats.db;
    const yn = b => b ? '<span class="pill ok">正常</span>' : '<span class="pill off">异常</span>';
    let html = '<h3 class="sec">系统状态</h3><div class="stat">';
    html += box(st.enabled ? (st.ok ? '就绪' : '未就绪') : '未启用', 'Stealth 代理', st.ok ? 'ok' : 'warn');
    html += box(up.ok ? (up.latencyMs + 'ms') : '不可达', '上游 cursor.com', up.ok ? 'ok' : 'err');
    html += box(pool.total, '账号总数') + box(pool.usable, '可用账号', 'ok') + box(pool.coolingDown, '冷却中', pool.coolingDown ? 'warn' : '');
    html += '</div>';
    if (db) {
      html += '<h3 class="sec">请求统计</h3><div class="stat">';
      html += box(db.totalRequests ?? 0, '总请求') + box(db.successCount ?? 0, '成功', 'ok') + box(db.degradedCount ?? 0, '降级', 'warn') + box(db.errorCount ?? 0, '失败', 'err') + box(Math.round(db.avgResponseTime ?? 0) + 'ms', '平均耗时');
      html += '</div>';
    } else {
      html += '<div class="hint">未启用 SQLite 日志（LOG_DB_ENABLED），请求统计仅内存近段。</div>';
    }
    wrap.innerHTML = html;
  } catch (e) { if (e.message !== 'unauthorized') wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ---------- accounts ----------
function healthBadge(a) {
  if (a.disabled) return '<span class="pill off">已禁用</span>';
  if (a.cooldownUntil && new Date(a.cooldownUntil).getTime() > Date.now()) return '<span class="pill cool">冷却中</span>';
  if (a.lastProbeOk === true) return `<span class="pill ok">健康${a.lastProbeLatencyMs ? ' ' + a.lastProbeLatencyMs + 'ms' : ''}</span>`;
  if (a.lastProbeOk === false) return '<span class="pill err">探测失败</span>';
  return '<span class="pill">未探测</span>';
}
function renderAccounts() {
  const wrap = document.getElementById('accountsWrap');
  updateBatchBar();
  if (!cache.accounts.length) { wrap.innerHTML = '<div class="empty">暂无账号，点击「新增」或「批量导入」</div>'; return; }
  wrap.innerHTML = cache.accounts.map(a => {
    const checked = selected.has(a.id) ? 'checked' : '';
    return `<div class="card${selected.has(a.id) ? ' sel' : ''}">
      <div class="nm"><input type="checkbox" ${checked} onchange="toggleSel('${a.id}',this.checked)" /> ${esc(a.name || a.id)} ${healthBadge(a)}</div>
      <div class="row"><span class="k">分组</span><span>${esc(a.group || '—')}</span></div>
      <div class="row"><span class="k">优先级</span><span>${a.priority ?? 0}（越小越优先）</span></div>
      <div class="row"><span class="k">代理</span><span class="mono sm">${esc(a.proxy || '（全局）')}</span></div>
      <div class="row"><span class="k">Cookie</span><span class="mono sm">${esc(a.cookie)}</span></div>
      <div class="row"><span class="k">调用/连续失败</span><span>${a.totalCalls ?? 0} / ${a.consecutiveFailures ?? 0}</span></div>
      ${a.lastErrorReason ? `<div class="row"><span class="k">最近错误</span><span class="sm">${esc(a.lastErrorReason)}</span></div>` : ''}
      <div class="acts">
        <button onclick="probeOne('${a.id}')">探测</button>
        <button onclick="toggleAccount('${a.id}',${!a.disabled})">${a.disabled ? '启用' : '禁用'}</button>
        <button onclick="editAccount('${a.id}')">编辑</button>
        <button class="danger" onclick="delAccount('${a.id}')">删除</button>
      </div></div>`;
  }).join('');
}
function toggleSel(id, on) { if (on) selected.add(id); else selected.delete(id); renderAccounts(); }
function selectAll(on) { if (on) cache.accounts.forEach(a => selected.add(a.id)); else selected.clear(); renderAccounts(); }
function updateBatchBar() {
  const bar = document.getElementById('batchBar'); if (!bar) return;
  bar.style.display = selected.size > 0 ? 'flex' : 'none';
  const c = document.getElementById('selCount'); if (c) c.textContent = selected.size;
}
async function probeOne(id) {
  toast('探测中…');
  try { const r = await api('/accounts/' + id + '/health', { method: 'POST' }); toast(r.result.ok ? `健康 ${r.result.latencyMs}ms` : `失败: ${r.result.error || ''}`, !r.result.ok); await reloadAll(); }
  catch (e) { toast(e.message, true); }
}
async function toggleAccount(id, disabled) { try { await api('/accounts/' + id + '/disabled', { method: 'POST', body: { disabled } }); toast('已更新'); reloadAll(); } catch (e) { toast(e.message, true); } }
async function delAccount(id) { if (!confirm('确认删除该账号？')) return; try { await api('/accounts/' + id, { method: 'DELETE' }); selected.delete(id); toast('已删除'); reloadAll(); } catch (e) { toast(e.message, true); } }

// ---------- account batch ----------
function selIds() { return Array.from(selected); }
async function batchProbeAll() {
  toast('全部探测中…');
  try { const r = await api('/accounts/batch-health', { method: 'POST', body: {} }); toast(`探测 ${r.probed} 个`); await reloadAll(); await loadOverview(); }
  catch (e) { toast(e.message, true); }
}
async function batchProbe() {
  toast('批量探测中…');
  try { const r = await api('/accounts/batch-health', { method: 'POST', body: { ids: selIds() } }); toast(`探测 ${r.probed} 个`); await reloadAll(); }
  catch (e) { toast(e.message, true); }
}
async function batchDelete() {
  if (!confirm(`确认删除选中的 ${selected.size} 个账号？`)) return;
  try { const r = await api('/accounts/batch-delete', { method: 'POST', body: { ids: selIds() } }); selected.clear(); toast(`已删除 ${r.deleted}`); reloadAll(); }
  catch (e) { toast(e.message, true); }
}
async function batchReset() {
  if (!confirm(`确认重置选中 ${selected.size} 个账号的用量/失败/冷却？`)) return;
  try { const r = await api('/accounts/batch-reset', { method: 'POST', body: { ids: selIds() } }); toast(`已重置 ${r.reset}`); reloadAll(); }
  catch (e) { toast(e.message, true); }
}
function openBatchEdit() {
  openModal('批量编辑 ' + selected.size + ' 个账号',
    `<label>分组（留空=不改）</label><select id="m_group">${groupOptions('')}</select>
     <label>启停</label><select id="m_disabled"><option value="">不改</option><option value="false">启用</option><option value="true">禁用</option></select>
     <label>优先级（留空=不改）</label><input id="m_prio" type="number" placeholder="不改" />`,
    async () => {
      const patch = {};
      const g = mval('m_group'); if (g) patch.group = g;
      const d = mval('m_disabled'); if (d) patch.disabled = d === 'true';
      const p = mval('m_prio'); if (p !== '') patch.priority = Number(p);
      if (Object.keys(patch).length === 0) { toast('未指定任何修改', true); return; }
      const r = await api('/accounts/batch-update', { method: 'POST', body: { ids: selIds(), patch } });
      toast(`已更新 ${r.updated}`); closeModal(); reloadAll();
    });
}

// ---------- client keys ----------
function renderKeys() {
  const wrap = document.getElementById('keysWrap');
  if (!cache.keys.length) { wrap.innerHTML = '<div class="empty">暂无客户端 Key</div>'; return; }
  const rows = cache.keys.map(k => `<tr>
    <td>${esc(k.name || '—')}</td><td class="mono sm">${esc(k.key)}</td><td>${esc(k.group || '—')}</td>
    <td>${k.disabled ? '<span class="pill off">禁用</span>' : '<span class="pill ok">启用</span>'}</td>
    <td>${k.totalCalls ?? 0}</td><td>${k.totalInputTokens ?? 0} / ${k.totalOutputTokens ?? 0}</td>
    <td><button onclick="toggleKey('${k.id}',${!k.disabled})">${k.disabled ? '启用' : '禁用'}</button>
    <button onclick="editKey('${k.id}')">编辑</button><button class="danger" onclick="delKey('${k.id}')">删除</button></td></tr>`).join('');
  wrap.innerHTML = `<table><thead><tr><th>名称</th><th>Key</th><th>分组</th><th>状态</th><th>调用</th><th>In/Out Tok</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}
async function toggleKey(id, disabled) { try { await api('/client-keys/' + id + '/disabled', { method: 'POST', body: { disabled } }); toast('已更新'); reloadAll(); } catch (e) { toast(e.message, true); } }
async function delKey(id) { if (!confirm('确认删除该 Key？使用它的客户端将立即失效。')) return; try { await api('/client-keys/' + id, { method: 'DELETE' }); toast('已删除'); reloadAll(); } catch (e) { toast(e.message, true); } }

// ---------- groups ----------
function renderGroups() {
  const wrap = document.getElementById('groupsWrap');
  if (!cache.groups.length) { wrap.innerHTML = '<div class="empty">暂无分组。分组隔离「客户端 Key ↔ 账号」路由范围。</div>'; return; }
  const rows = cache.groups.map(g => {
    const accN = cache.accounts.filter(a => a.group === g.name).length;
    const keyN = cache.keys.filter(k => k.group === g.name).length;
    return `<tr><td>${esc(g.name)}</td><td>${accN} 账号</td><td>${keyN} Key</td>
      <td><button onclick="renameGroup('${g.id}','${esc(g.name)}')">改名</button>
      <button class="danger" onclick="delGroup('${g.id}')">删除</button></td></tr>`;
  }).join('');
  wrap.innerHTML = `<table><thead><tr><th>分组名</th><th>账号数</th><th>Key 数</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}
async function renameGroup(id, cur) {
  const name = prompt('新分组名（级联更新引用它的账号与 Key）', cur);
  if (!name || name === cur) return;
  try { await api('/groups/' + id, { method: 'PATCH', body: { name } }); toast('已改名'); reloadAll(); } catch (e) { toast(e.message, true); }
}
async function delGroup(id) { if (!confirm('删除分组？引用它的账号与 Key 回落为无分组。')) return; try { await api('/groups/' + id, { method: 'DELETE' }); toast('已删除'); reloadAll(); } catch (e) { toast(e.message, true); } }

// ---------- proxies ----------
function renderProxies() {
  const wrap = document.getElementById('proxiesWrap'); if (!wrap) return;
  if (!cache.proxies.length) { wrap.innerHTML = '<div class="empty">暂无代理。添加后可健康探测、轮询分配到账号。</div>'; return; }
  const hp = { healthy: '<span class="pill ok">健康</span>', unhealthy: '<span class="pill err">不可用</span>', unknown: '<span class="pill">未知</span>' };
  const rows = cache.proxies.map(p => `<tr>
    <td class="mono sm">${esc(p.url)}</td>
    <td>${p.enabled ? '<span class="pill ok">启用</span>' : '<span class="pill off">停用</span>'}</td>
    <td>${hp[p.health] || hp.unknown}</td><td>${p.latencyMs != null ? p.latencyMs + 'ms' : '—'}</td>
    <td class="sm">${p.lastCheckedAt ? new Date(p.lastCheckedAt).toLocaleString() : '—'}</td>
    <td><button onclick="checkProxy('${p.id}')">检测</button>
    <button onclick="toggleProxy('${p.id}',${!p.enabled})">${p.enabled ? '停用' : '启用'}</button>
    <button class="danger" onclick="delProxy('${p.id}')">删除</button></td></tr>`).join('');
  wrap.innerHTML = `<table><thead><tr><th>URL</th><th>启停</th><th>健康</th><th>延迟</th><th>最近检测</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}
async function checkProxy(id) { toast('检测中…'); try { await api('/proxies/' + id + '/check', { method: 'POST' }); const p = await api('/proxies'); cache.proxies = p.proxies || []; renderProxies(); toast('已检测'); } catch (e) { toast(e.message, true); } }
async function checkAllProxies() { toast('全部检测中…'); try { const r = await api('/proxies/check-all', { method: 'POST' }); cache.proxies = r.proxies || []; renderProxies(); toast(`已检测 ${r.checked}`); } catch (e) { toast(e.message, true); } }
async function toggleProxy(id, enabled) { try { await api('/proxies/' + id + '/enabled', { method: 'POST', body: { enabled } }); const p = await api('/proxies'); cache.proxies = p.proxies || []; renderProxies(); } catch (e) { toast(e.message, true); } }
async function delProxy(id) { if (!confirm('删除该代理？')) return; try { await api('/proxies/' + id, { method: 'DELETE' }); const p = await api('/proxies'); cache.proxies = p.proxies || []; renderProxies(); toast('已删除'); } catch (e) { toast(e.message, true); } }
async function assignRoundRobin() {
  if (!confirm('把「启用且健康」的代理轮询分配到所有账号的代理字段？')) return;
  try { const r = await api('/proxies/assign-round-robin', { method: 'POST', body: {} }); toast(`已分配 ${r.assigned} 账号（用 ${r.proxiesUsed} 代理）`); reloadAll(); } catch (e) { toast(e.message, true); }
}
function openProxyBatchModal() {
  openModal('批量添加代理', `<label>每行一个代理 URL（# 注释/空行忽略，已存在的去重）</label>
    <textarea id="m_text" rows="8" placeholder="http://user:pass@host:port&#10;socks5://host:1080"></textarea>`,
    async () => { const text = mval('m_text'); if (!text) { toast('请输入', true); return; } const r = await api('/proxies/batch', { method: 'POST', body: { text } }); toast(`新增 ${r.added} 个`); closeModal(); const p = await api('/proxies'); cache.proxies = p.proxies || []; renderProxies(); });
}

// ---------- logs (链路追踪+用量 合并) ----------
let logState = { status: '', keyword: '' };
async function loadLogs() {
  const wrap = document.getElementById('logsWrap'); if (!wrap) return;
  wrap.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const q = new URLSearchParams({ limit: '100' });
    if (logState.status) q.set('status', logState.status);
    if (logState.keyword) q.set('keyword', logState.keyword);
    const r = await api('/logs?' + q.toString());
    const nameAcc = id => (cache.accounts.find(a => a.id === id) || {}).name || (id ? id.slice(0, 8) : '—');
    const nameKey = id => (cache.keys.find(k => k.id === id) || {}).name || (id ? id.slice(0, 8) : '—');
    const sc = r.statusCounts || {};
    let head = `<div class="logbar">
      <span class="pill">总 ${r.total ?? 0}</span>
      <span class="pill ok">成功 ${sc.success || 0}</span>
      <span class="pill warn">降级 ${sc.degraded || 0}</span>
      <span class="pill err">失败 ${sc.error || 0}</span>
      <span class="sp"></span>
      <span class="hint">本页用量 in/out: ${r.usage?.inputTokens || 0} / ${r.usage?.outputTokens || 0}${r.dbEnabled ? '' : '（内存模式）'}</span>
    </div>`;
    if (!r.summaries.length) { wrap.innerHTML = head + '<div class="empty">无日志记录</div>'; return; }
    const rows = r.summaries.map(s => `<tr class="clk" onclick="showPayload('${s.requestId}')">
      <td class="sm">${new Date(s.startTime).toLocaleString()}</td>
      <td class="sm">${esc(s.model || '—')}</td>
      <td><span class="pill ${s.status === 'success' ? 'ok' : s.status === 'error' ? 'err' : s.status === 'degraded' ? 'warn' : ''}">${esc(s.status)}</span></td>
      <td class="sm">${esc(nameKey(s.clientKeyId))}</td><td class="sm">${esc(nameAcc(s.accountId))}</td>
      <td class="sm">${s.inputTokens ?? '—'} / ${s.outputTokens ?? '—'}</td>
      <td class="sm">${s.endTime ? (s.endTime - s.startTime) + 'ms' : (s.ttft != null ? s.ttft + 'ms' : '—')}</td></tr>`).join('');
    wrap.innerHTML = head + `<table><thead><tr><th>时间</th><th>模型</th><th>状态</th><th>下游 Key</th><th>上游账号</th><th>In/Out</th><th>耗时</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) { if (e.message !== 'unauthorized') wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function applyLogFilter() { logState.status = document.getElementById('logStatus').value.trim(); logState.keyword = document.getElementById('logKeyword').value.trim(); loadLogs(); }
async function showPayload(id) {
  try {
    const r = await api('/logs/' + id);
    openModal('请求详情 ' + id, `<pre class="payload">${esc(JSON.stringify(r.payload, null, 2))}</pre>`, null);
    document.getElementById('modalOk').style.display = 'none';
  } catch (e) { toast(e.message, true); }
}

// ---------- settings ----------
async function loadSettings() {
  const wrap = document.getElementById('settingsWrap'); if (!wrap) return;
  try {
    const cfg = await api('/config');
    wrap.innerHTML = `
      <div class="card">
        <div class="nm">运行配置（热重载写入 config.yaml）</div>
        <label>Cursor 模型</label><input id="s_model" value="${esc(cfg.cursor_model || '')}" />
        <label>超时（秒）</label><input id="s_timeout" type="number" value="${cfg.timeout ?? 120}" />
        <label>最大自动续写</label><input id="s_cont" type="number" value="${cfg.max_auto_continue ?? 0}" />
        <div class="acts"><button class="pri" onclick="saveSettings()">保存</button></div>
      </div>
      <div class="card">
        <div class="nm">代理批量分配</div>
        <div class="hint">把代理池中「启用且健康」的代理轮询分配到所有账号。</div>
        <div class="acts"><button onclick="assignRoundRobin()">轮询分配到账号</button></div>
      </div>`;
  } catch (e) { if (e.message !== 'unauthorized') wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function saveSettings() {
  try {
    await api('/config', { method: 'POST', body: {
      cursor_model: mval('s_model'), timeout: Number(mval('s_timeout')) || 120, max_auto_continue: Number(mval('s_cont')) || 0,
    } });
    toast('已保存（热重载生效）');
  } catch (e) { toast(e.message, true); }
}

// ---------- modal ----------
let modalSubmitFn = null;
function openModal(title, bodyHtml, submitFn) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  const ok = document.getElementById('modalOk'); ok.textContent = '确定'; ok.style.display = submitFn ? '' : 'none';
  modalSubmitFn = submitFn;
  document.getElementById('modal').classList.add('on');
}
function closeModal() { document.getElementById('modal').classList.remove('on'); modalSubmitFn = null; }
async function modalSubmit() { if (modalSubmitFn) { try { await modalSubmitFn(); } catch (e) { toast(e.message, true); } } }
function groupOptions(sel) { return '<option value="">（无分组）</option>' + cache.groups.map(g => `<option value="${esc(g.name)}"${g.name === sel ? ' selected' : ''}>${esc(g.name)}</option>`).join(''); }
function mval(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

// account create/edit + batch import
function openAccountModal() {
  openModal('新增账号',
    `<label>名称</label><input id="m_name" placeholder="可选" />
     <label>Cookie（必填）</label><input id="m_cookie" class="mono" placeholder="WorkosCursorSessionToken..." />
     <label>分组</label><select id="m_group">${groupOptions('')}</select>
     <label>代理（留空=全局）</label><input id="m_proxy" class="mono" placeholder="http://... 可选" />
     <label>优先级（越小越优先）</label><input id="m_prio" type="number" value="0" />`,
    async () => {
      const cookie = mval('m_cookie'); if (!cookie) { toast('Cookie 必填', true); return; }
      await api('/accounts', { method: 'POST', body: { name: mval('m_name'), cookie, group: mval('m_group') || undefined, proxy: mval('m_proxy') || undefined, priority: Number(mval('m_prio')) || 0 } });
      toast('已新增'); closeModal(); reloadAll();
    });
}
function editAccount(id) {
  const a = cache.accounts.find(x => x.id === id); if (!a) return;
  openModal('编辑账号：' + (a.name || a.id),
    `<label>名称</label><input id="m_name" value="${esc(a.name || '')}" />
     <label>分组</label><select id="m_group">${groupOptions(a.group)}</select>
     <label>代理（留空=全局）</label><input id="m_proxy" class="mono" value="${esc(a.proxy || '')}" />
     <label>优先级</label><input id="m_prio" type="number" value="${a.priority ?? 0}" />
     <label>Cookie（留空不改）</label><input id="m_cookie" class="mono" placeholder="不修改请留空" />`,
    async () => {
      const patch = { name: mval('m_name'), group: mval('m_group') || undefined, proxy: mval('m_proxy') || undefined, priority: Number(mval('m_prio')) || 0 };
      const ck = mval('m_cookie'); if (ck) patch.cookie = ck;
      await api('/accounts/' + id, { method: 'PATCH', body: patch });
      toast('已保存'); closeModal(); reloadAll();
    });
}
function openImportModal() {
  openModal('批量导入账号',
    `<label>每行一个 cookie（可用「名称|cookie」；# 注释/空行忽略）</label>
     <textarea id="m_text" rows="7" placeholder="cookieA&#10;团队A|cookieB"></textarea>
     <label>统一分组（可选）</label><select id="m_group">${groupOptions('')}</select>
     <label>统一优先级（可选）</label><input id="m_prio" type="number" placeholder="0" />`,
    async () => {
      const text = mval('m_text'); if (!text) { toast('请输入', true); return; }
      const body = { text }; const g = mval('m_group'); if (g) body.group = g; const p = mval('m_prio'); if (p) body.priority = Number(p);
      const r = await api('/accounts/batch-import', { method: 'POST', body });
      toast(`导入 ${r.imported} 个`); closeModal(); reloadAll();
    });
}
function openKeyModal() {
  openModal('新增客户端 Key',
    `<label>名称</label><input id="m_name" placeholder="如 团队A-生产" />
     <label>绑定分组（限定可路由账号；留空=全池）</label><select id="m_group">${groupOptions('')}</select>`,
    async () => {
      const res = await api('/client-keys', { method: 'POST', body: { name: mval('m_name'), group: mval('m_group') || undefined } });
      closeModal();
      openModal('Key 已创建 — 请立即保存',
        `<p class="warn-txt">此完整密钥仅显示一次，关闭后无法再取。</p>
         <input class="mono" readonly value="${esc(res.plaintextKey)}" onclick="this.select()" style="width:100%" />`, null);
      reloadAll();
    });
}
function editKey(id) {
  const k = cache.keys.find(x => x.id === id); if (!k) return;
  openModal('编辑 Key：' + (k.name || k.id),
    `<label>名称</label><input id="m_name" value="${esc(k.name || '')}" />
     <label>绑定分组</label><select id="m_group">${groupOptions(k.group)}</select>`,
    async () => { await api('/client-keys/' + id, { method: 'PATCH', body: { name: mval('m_name'), group: mval('m_group') || undefined } }); toast('已保存'); closeModal(); reloadAll(); });
}
function openGroupModal() {
  openModal('新增分组', `<label>分组名</label><input id="m_name" placeholder="如 team-a" />`,
    async () => { const name = mval('m_name'); if (!name) { toast('分组名必填', true); return; } await api('/groups', { method: 'POST', body: { name } }); toast('已新增'); closeModal(); reloadAll(); });
}
function openProxyModal() {
  openModal('新增代理', `<label>代理 URL</label><input id="m_url" class="mono" placeholder="http://user:pass@host:port" />`,
    async () => { const url = mval('m_url'); if (!url) { toast('URL 必填', true); return; } await api('/proxies', { method: 'POST', body: { url } }); toast('已新增'); closeModal(); const p = await api('/proxies'); cache.proxies = p.proxies || []; renderProxies(); });
}

// ---------- boot ----------
document.getElementById('adminKeyIn').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
if (adminKey) { api('/stats').then(showApp).catch(() => logout()); }
