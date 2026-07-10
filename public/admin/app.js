/* Cursor2API Admin 前端（P6）— vanilla 单文件，无构建
   鉴权：admin_api_key 存 localStorage，所有 /api/admin/* 带 Authorization: Bearer */
'use strict';

const LS_KEY = 'cursor2api_admin_key';
let adminKey = localStorage.getItem(LS_KEY) || '';
let cache = { accounts: [], keys: [], groups: [] };

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Authorization': 'Bearer ' + adminKey }, opts.headers || {});
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api/admin' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 || r.status === 403) {
    // key 失效或被禁用 → 回登录
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

// ---------- toast ----------
let toastT;
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'on' + (isErr ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => (el.className = ''), 2600);
}

// ---------- login ----------
async function doLogin() {
  const v = document.getElementById('adminKeyIn').value.trim();
  const errEl = document.getElementById('loginErr');
  errEl.textContent = '';
  if (!v) return;
  adminKey = v;
  try {
    await api('/stats');               // 用 stats 做鉴权探针
    localStorage.setItem(LS_KEY, v);
    showApp();
  } catch (e) {
    adminKey = '';
    errEl.textContent = e.message === 'unauthorized' ? 'Key 无效或 Admin API 未启用' : e.message;
  }
}

function logout(msg) {
  localStorage.removeItem(LS_KEY);
  adminKey = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  if (msg) document.getElementById('loginErr').textContent = msg;
}

function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  reloadAll();
}

// ---------- tabs ----------
function switchTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + name));
  if (name === 'traces') loadTraces();
  if (name === 'stats') loadStats();
}

// ---------- data load ----------
async function reloadAll() {
  try {
    const [a, k, g] = await Promise.all([api('/accounts'), api('/client-keys'), api('/groups')]);
    cache.accounts = a.accounts || [];
    cache.keys = k.keys || [];
    cache.groups = g.groups || [];
    renderAccounts();
    renderKeys();
    renderGroups();
  } catch (e) { if (e.message !== 'unauthorized') toast(e.message, true); }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- accounts ----------
function renderAccounts() {
  const wrap = document.getElementById('accountsWrap');
  if (!cache.accounts.length) { wrap.innerHTML = '<div class="empty">暂无账号，点击右上角新增</div>'; return; }
  wrap.innerHTML = cache.accounts.map(a => {
    const cooling = a.cooldownUntil && new Date(a.cooldownUntil).getTime() > Date.now();
    const pill = a.disabled ? '<span class="pill off">已禁用</span>'
      : cooling ? '<span class="pill cool">冷却中</span>' : '<span class="pill ok">正常</span>';
    return `<div class="card">
      <div class="nm">${esc(a.name || a.id)} ${pill}</div>
      <div class="row"><span class="k">分组</span><span>${esc(a.group || '—')}</span></div>
      <div class="row"><span class="k">优先级</span><span>${a.priority ?? 0}（越小越优先）</span></div>
      <div class="row"><span class="k">Cookie</span><span class="mono">${esc(a.cookie)}</span></div>
      <div class="row"><span class="k">调用总数</span><span>${a.totalCalls ?? 0}</span></div>
      <div class="row"><span class="k">连续失败</span><span>${a.consecutiveFailures ?? 0}</span></div>
      ${a.lastErrorReason ? `<div class="row"><span class="k">最近错误</span><span>${esc(a.lastErrorReason)}</span></div>` : ''}
      <div class="acts">
        <button onclick="toggleAccount('${a.id}',${!a.disabled})">${a.disabled ? '启用' : '禁用'}</button>
        ${cooling ? `<button onclick="clearCooldown('${a.id}')">清冷却</button>` : ''}
        <button onclick="editAccount('${a.id}')">编辑</button>
        <button class="danger" onclick="delAccount('${a.id}')">删除</button>
      </div></div>`;
  }).join('');
}

async function toggleAccount(id, disabled) {
  try { await api('/accounts/' + id + '/disabled', { method: 'POST', body: { disabled } }); toast('已更新'); reloadAll(); }
  catch (e) { toast(e.message, true); }
}
async function clearCooldown(id) {
  try { await api('/accounts/' + id + '/clear-cooldown', { method: 'POST', body: {} }); toast('已清除冷却'); reloadAll(); }
  catch (e) { toast(e.message, true); }
}
async function delAccount(id) {
  if (!confirm('确认删除该账号？')) return;
  try { await api('/accounts/' + id, { method: 'DELETE' }); toast('已删除'); reloadAll(); }
  catch (e) { toast(e.message, true); }
}

// ---------- client keys ----------
function renderKeys() {
  const wrap = document.getElementById('keysWrap');
  if (!cache.keys.length) { wrap.innerHTML = '<div class="empty">暂无客户端 Key</div>'; return; }
  const rows = cache.keys.map(k => `<tr>
    <td>${esc(k.name || '—')}</td>
    <td class="mono">${esc(k.key)}</td>
    <td>${esc(k.group || '—')}</td>
    <td>${k.disabled ? '<span class="pill off">禁用</span>' : '<span class="pill ok">启用</span>'}</td>
    <td>${k.totalCalls ?? 0}</td>
    <td>${k.totalInputTokens ?? 0} / ${k.totalOutputTokens ?? 0}</td>
    <td>
      <button onclick="toggleKey('${k.id}',${!k.disabled})">${k.disabled ? '启用' : '禁用'}</button>
      <button onclick="editKey('${k.id}')">编辑</button>
      <button class="danger" onclick="delKey('${k.id}')">删除</button>
    </td></tr>`).join('');
  wrap.innerHTML = `<table><thead><tr><th>名称</th><th>Key</th><th>分组</th><th>状态</th><th>调用</th><th>In/Out Tok</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}
async function toggleKey(id, disabled) {
  try { await api('/client-keys/' + id + '/disabled', { method: 'POST', body: { disabled } }); toast('已更新'); reloadAll(); }
  catch (e) { toast(e.message, true); }
}
async function delKey(id) {
  if (!confirm('确认删除该 Key？删除后使用该 Key 的客户端将立即失效。')) return;
  try { await api('/client-keys/' + id, { method: 'DELETE' }); toast('已删除'); reloadAll(); }
  catch (e) { toast(e.message, true); }
}

// ---------- groups ----------
function renderGroups() {
  const wrap = document.getElementById('groupsWrap');
  if (!cache.groups.length) { wrap.innerHTML = '<div class="empty">暂无分组。分组用于隔离「客户端 Key ↔ 账号」的路由范围。</div>'; return; }
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
  const name = prompt('新分组名（会级联更新引用它的账号与 Key）', cur);
  if (!name || name === cur) return;
  try { await api('/groups/' + id, { method: 'PATCH', body: { name } }); toast('已改名'); reloadAll(); }
  catch (e) { toast(e.message, true); }
}
async function delGroup(id) {
  if (!confirm('确认删除该分组？引用它的账号与 Key 将回落为「无分组」。')) return;
  try { await api('/groups/' + id, { method: 'DELETE' }); toast('已删除'); reloadAll(); }
  catch (e) { toast(e.message, true); }
}

// ---------- traces ----------
async function loadTraces() {
  const wrap = document.getElementById('tracesWrap');
  const status = document.getElementById('traceFilter').value.trim();
  try {
    const q = new URLSearchParams({ limit: '100' });
    if (status) q.set('status', status);
    const { traces } = await api('/traces?' + q.toString());
    if (!traces.length) { wrap.innerHTML = '<div class="empty">无追踪记录（需启用 SQLite 日志）</div>'; return; }
    const nameOfAcc = id => (cache.accounts.find(a => a.id === id) || {}).name || id || '—';
    const nameOfKey = id => (cache.keys.find(k => k.id === id) || {}).name || id || '—';
    const rows = traces.map(t => `<tr>
      <td>${new Date(t.startTime).toLocaleString()}</td>
      <td>${esc(t.model || '—')}</td>
      <td><span class="pill ${t.status === 'success' ? 'ok' : t.status === 'error' ? 'off' : 'cool'}">${esc(t.status)}</span></td>
      <td>${esc(nameOfKey(t.clientKeyId))}</td>
      <td>${esc(nameOfAcc(t.accountId))}</td>
      <td>${t.inputTokens ?? '—'} / ${t.outputTokens ?? '—'}</td>
    </tr>`).join('');
    wrap.innerHTML = `<table><thead><tr><th>时间</th><th>模型</th><th>状态</th><th>下游 Key</th><th>上游账号</th><th>In/Out Tok</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) { if (e.message !== 'unauthorized') wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ---------- stats ----------
async function loadStats() {
  const wrap = document.getElementById('statsWrap');
  try {
    const { pool, db } = await api('/stats');
    const box = (v, l) => `<div class="box"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    let html = '<div class="stat">' +
      box(pool.total, '账号总数') + box(pool.usable, '可用') + box(pool.busy, '满载') + box(pool.coolingDown, '冷却中') +
      '</div>';
    if (db) {
      html += '<div class="stat">' + box(db.totalRequests ?? 0, '请求总数') +
        box(db.successCount ?? 0, '成功') + box(db.degradedCount ?? 0, '降级') +
        box(db.errorCount ?? 0, '失败') + box(Math.round(db.avgResponseTime ?? 0) + 'ms', '平均耗时') + '</div>';
    } else {
      html += '<div class="empty">未启用 SQLite 日志，暂无请求统计</div>';
    }
    wrap.innerHTML = html;
  } catch (e) { if (e.message !== 'unauthorized') toast(e.message, true); }
}

// ---------- modal ----------
let modalSubmitFn = null;
function openModal(title, bodyHtml, submitFn) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalOk').textContent = '确定';
  modalSubmitFn = submitFn;
  document.getElementById('modal').classList.add('on');
}
function closeModal() { document.getElementById('modal').classList.remove('on'); modalSubmitFn = null; }
async function modalSubmit() { if (modalSubmitFn) { try { await modalSubmitFn(); } catch (e) { toast(e.message, true); } } }
function groupOptions(sel) {
  return '<option value="">（无分组）</option>' + cache.groups.map(g =>
    `<option value="${esc(g.name)}"${g.name === sel ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
}
function mval(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

// account create/edit
function openAccountModal() {
  openModal('新增账号',
    `<label>名称</label><input id="m_name" placeholder="可选" />
     <label>Cookie（必填）</label><input id="m_cookie" class="mono" placeholder="WorkosCursorSessionToken..." />
     <label>分组</label><select id="m_group">${groupOptions('')}</select>
     <label>优先级（数字，越大越优先）</label><input id="m_prio" type="number" value="0" />`,
    async () => {
      const cookie = mval('m_cookie'); if (!cookie) return toast('Cookie 必填', true);
      await api('/accounts', { method: 'POST', body: { name: mval('m_name'), cookie, group: mval('m_group') || undefined, priority: Number(mval('m_prio')) || 0 } });
      toast('已新增'); closeModal(); reloadAll();
    });
}
function editAccount(id) {
  const a = cache.accounts.find(x => x.id === id); if (!a) return;
  openModal('编辑账号：' + (a.name || a.id),
    `<label>名称</label><input id="m_name" value="${esc(a.name || '')}" />
     <label>分组</label><select id="m_group">${groupOptions(a.group)}</select>
     <label>优先级</label><input id="m_prio" type="number" value="${a.priority ?? 0}" />
     <label>Cookie（留空则不改）</label><input id="m_cookie" class="mono" placeholder="不修改请留空" />`,
    async () => {
      const patch = { name: mval('m_name'), group: mval('m_group') || undefined, priority: Number(mval('m_prio')) || 0 };
      const ck = mval('m_cookie'); if (ck) patch.cookie = ck;
      await api('/accounts/' + id, { method: 'PATCH', body: patch });
      toast('已保存'); closeModal(); reloadAll();
    });
}

// key create/edit
function openKeyModal() {
  openModal('新增客户端 Key',
    `<label>名称</label><input id="m_name" placeholder="如 团队A-生产" />
     <label>绑定分组（限定可路由账号；留空=全池）</label><select id="m_group">${groupOptions('')}</select>`,
    async () => {
      const res = await api('/client-keys', { method: 'POST', body: { name: mval('m_name'), group: mval('m_group') || undefined } });
      closeModal();
      openModal('Key 已创建 — 请立即保存',
        `<p style="color:var(--warn);font-size:13px">此完整密钥仅显示这一次，关闭后无法再次获取。</p>
         <input class="mono" readonly value="${esc(res.plaintextKey)}" onclick="this.select()" style="width:100%" />`,
        async () => { closeModal(); reloadAll(); });
      document.getElementById('modalOk').textContent = '我已保存';
      reloadAll();
    });
}
function editKey(id) {
  const k = cache.keys.find(x => x.id === id); if (!k) return;
  openModal('编辑 Key：' + (k.name || k.id),
    `<label>名称</label><input id="m_name" value="${esc(k.name || '')}" />
     <label>绑定分组</label><select id="m_group">${groupOptions(k.group)}</select>`,
    async () => {
      await api('/client-keys/' + id, { method: 'PATCH', body: { name: mval('m_name'), group: mval('m_group') || undefined } });
      toast('已保存'); closeModal(); reloadAll();
    });
}

// group create
function openGroupModal() {
  openModal('新增分组',
    `<label>分组名</label><input id="m_name" placeholder="如 team-a" />`,
    async () => {
      const name = mval('m_name'); if (!name) return toast('分组名必填', true);
      await api('/groups', { method: 'POST', body: { name } });
      toast('已新增'); closeModal(); reloadAll();
    });
}

// ---------- boot ----------
document.getElementById('adminKeyIn').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
if (adminKey) {
  api('/stats').then(showApp).catch(() => logout());
}
