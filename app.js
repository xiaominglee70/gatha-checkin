'use strict';
// ============================================================
// 偈语背诵打卡 · 前端逻辑（单页应用）
// 双通道：Telegram 内打开 → initData 自动识别；浏览器打开 → 用户名登录
// ============================================================

const TG = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;

const state = {
  token: localStorage.getItem('gatha_token') || null,
  user: null,
  view: 'home',
  tgType: '偈语',
  q: '',
  picks: [],
  editingTeaching: null,
  pendingTeachingId: null,
  pendingTeachingTitle: null
};

// ---------------- 工具 ----------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(s) { return s || '—'; }
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(() => fn.apply(null, arguments), ms); }; }
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('toast-el');
  if (!el) { el = document.createElement('div'); el.id = 'toast-el'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------- API 封装 ----------------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (e) {
    throw new Error('网络错误，请确认服务器已启动');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || '请求失败'); err.status = res.status; throw err; }
  return data;
}

// ---------------- 初始化 ----------------
async function init() {
  if (TG) { TG.ready(); try { TG.expand(); } catch (e) {} }
  // 通道 1：Telegram 内打开 → 自动识别身份
  if (TG && TG.initData) {
    try {
      const d = await api('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: TG.initData }) });
      state.token = d.token; localStorage.setItem('gatha_token', d.token); state.user = d.user;
      enterApp(); return;
    } catch (e) {
      showLogin('Telegram 身份识别失败：' + e.message);
      return;
    }
  }
  // 通道 2：已有会话
  if (state.token) {
    try {
      const d = await api('/api/me');
      state.user = d.user;
      enterApp(); return;
    } catch (e) {
      state.token = null; localStorage.removeItem('gatha_token');
    }
  }
  showLogin('');
}

function showLogin(msg) {
  document.getElementById('view-login').classList.remove('hidden');
  document.getElementById('view-app').classList.add('hidden');
  if (msg) document.getElementById('login-msg').textContent = msg;
  if (TG && TG.initData) {
    document.getElementById('tg-tip').classList.remove('hidden');
    document.getElementById('login-username').disabled = true;
    document.getElementById('login-password').disabled = true;
  }
}

document.getElementById('btn-login').addEventListener('click', async () => {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const msgEl = document.getElementById('login-msg');
  if (!username) { msgEl.textContent = '请输入用户名（首次输入即注册）'; return; }
  try {
    const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    state.token = d.token; localStorage.setItem('gatha_token', d.token); state.user = d.user;
    enterApp();
  } catch (e) { msgEl.textContent = e.message; }
});
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-login').click(); });
document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-login').click(); });

// ---------------- 主框架 ----------------
function enterApp() {
  document.getElementById('view-login').classList.add('hidden');
  document.getElementById('view-app').classList.remove('hidden');
  if (TG && TG.setHeaderColor) { try { TG.setHeaderColor('#faf7f2'); TG.setBackgroundColor('#faf7f2'); } catch (e) {} }
  state.view = 'home';
  renderNav();
  renderView();
}

function renderNav() {
  const items = [
    ['home', '首页'], ['teachings', '偈语库'], ['kaishi', '开示库'], ['gooddeeds', '善叙述'], ['mine', '我的']
  ];
  if (state.user && state.user.role === 'admin') items.push(['admin', '管理']);
  document.getElementById('nav').innerHTML = items.map(([k, label]) =>
    `<button class="${state.view === k ? 'active' : ''}" onclick="switchView('${k}')">${label}</button>`).join('');
  const role = state.user.role === 'admin' ? '<span class="role">· 管理员</span>' : '';
  document.getElementById('user-chip').innerHTML = `${esc(state.user.username)}${role}`;
}

function switchView(v) {
  state.view = v;
  if (v === 'kaishi') state.tgType = '开示';
  if (v === 'teachings') state.tgType = '偈语';
  renderNav(); renderView();
}
window.switchView = switchView;

function renderView() {
  const c = document.getElementById('content');
  if (state.view === 'home') renderHome(c);
  else if (state.view === 'teachings' || state.view === 'kaishi') renderTeachings(c);
  else if (state.view === 'gooddeeds') renderGooddeeds(c);
  else if (state.view === 'mine') renderMine(c);
  else if (state.view === 'admin') renderAdmin(c);
}

// ================= 首页 =================
let homeData = null;
async function renderHome(c) {
  c.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const [daily, today] = await Promise.all([api('/api/daily'), api('/api/checkins/today')]);
    homeData = { daily: daily.teaching, note: daily.note, today };
    const me = today.roster.find(r => r.user.id === state.user.id);
    const doneCount = today.roster.filter(r => r.done).length;
    const total = today.roster.length;
    const undone = today.roster.filter(r => !r.done);
    c.innerHTML = `
      <div class="daily-card">
        <span class="tag">${esc(homeData.note)}</span>
        ${homeData.daily ? `
          <details style="margin-top:4px">
            <summary style="font-size:16px;font-weight:700;cursor:pointer;list-style:none">📖 ${esc(homeData.daily.title || '(今日内容)')} <span style="font-size:12px;color:#666">（点开展开）</span></summary>
            <div style="margin-top:10px;line-height:1.6;padding:10px;background:#f8f9fa;border-radius:8px">${esc(homeData.daily.content || '')}</div>
          </details>
          <div class="src" style="margin-top:8px;font-size:12px">${homeData.daily.source ? esc(homeData.daily.source) : ''}${homeData.daily.fileName ? ' · <a href="/uploads/' + encodeURIComponent(homeData.daily.fileName) + '" target="_blank">附件</a>' : ''}</div>` : '<div class="empty">还没有偈语/开示，等管理员发布</div>'}
      </div>
      <div class="card" style="padding:24px">
        <h3 style="font-size:18px">今日打卡</h3>
        <div class="small" style="margin-bottom:16px;font-size:14px">${me ? (me.count > 0 ? `今天已打卡 <b>${me.count}</b> 次` : '今天还没打卡') : ''}　可反复打卡</div>
        <button class="btn primary" style="padding:16px;font-size:17px" onclick="doCheckin()">打卡</button>
        <button class="btn ghost" style="margin-top:10px;width:100%" onclick="switchView('gooddeeds')">写善叙述</button>
      </div>
      <div class="section-title">今日名单（已完成 ${doneCount} / ${total}）</div>
      <div class="card">
        <div class="roster-row roster-head">
          <span class="roster-name" style="flex:2">名字</span>
          <span class="roster-title">今日标题</span>
          <span class="roster-time">打卡时间</span>
        </div>
        ${[...today.roster].sort((a, b) => (b.done - a.done)).map(r => `
          <div class="roster-row">
            <span class="dot ${r.done ? 'done' : 'pending'}"></span>
            <span class="roster-name" style="flex:2">${esc(r.user.username)}${r.user.role === 'admin' ? '（管理员）' : ''}</span>
            <span class="roster-title">${homeData.daily ? esc(homeData.daily.title || '(无标题)') : '—'}</span>
            <span class="roster-time">${r.done ? fmtTime(r.lastAt) : '未打卡'}</span>
          </div>`).join('')}
        ${undone.length ? `<div class="muted" style="margin-top:10px;font-size:12px">还差：${undone.map(r => esc(r.user.username)).join('、')}</div>` : ''}
      </div>
      <div class="card" style="text-align:center">
        <div style="font-size:15px;color:#1f4a6a;font-weight:600">工欲善其事，必先利其器！</div>
      </div>`;
  } catch (e) { c.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function doCheckin() {
  try {
    const d = await api('/api/checkins', { method: 'POST', body: JSON.stringify({}) });
    toast(`打卡成功（今日第 ${d.todayCount} 次）`);
    renderView();
  } catch (e) { toast(e.message); }
}
window.doCheckin = doCheckin;

// ================= 偈语库 / 开示库 =================
async function renderTeachings(c) {
  c.innerHTML = `
    <div class="card">
      <div class="field"><input id="tg-search" type="text" placeholder="搜索${state.tgType === '开示' ? '开示' : '偈语'}…" value="${esc(state.q || '')}"></div>
    </div>
    <div id="tg-list"><div class="empty">加载中…</div></div>`;
  const cyclesData = await api('/api/cycles');
  const loadList = async () => {
    const d = await api('/api/teachings?type=' + encodeURIComponent(state.tgType) + '&q=' + encodeURIComponent(state.q || ''));
    renderTeachingList(d.teachings, cyclesData.cycles || []);
  };
  document.getElementById('tg-search').addEventListener('input', debounce(async () => {
    state.q = document.getElementById('tg-search').value.trim();
    loadList();
  }, 300));
  loadList();
}

function tgTabSwitch(t) { state.tgType = t; state.q = ''; state.picks = []; renderView(); }
window.tgTabSwitch = tgTabSwitch;

function renderTeachingList(list, cycles) {
  const box = document.getElementById('tg-list');
  if (!list.length) { box.innerHTML = '<div class="empty">这个库里还没有内容</div>'; return; }
  // 每条内容所在进行中周期的日期区间（只取日期，去掉时间）
  const day = s => String(s || '').slice(0, 10);
  const rangeById = {};
  (cycles || []).forEach(cy => {
    if (cy.status !== 'active') return;
    const s = day(cy.startDate);
    const e = cy.endDate ? day(cy.endDate) : '';
    (cy.teachingIds || []).forEach(tid => {
      if (!rangeById[tid]) rangeById[tid] = e ? (s + ' ~ ' + e) : (s + ' ~ 长期');
    });
  });
  box.innerHTML = `
    <div class="section-title">${state.tgType === '开示' ? '开示' : '偈语'}（${list.length}）</div>
    <div class="card"><div class="section-title" style="margin:0 0 6px">选择内容开始背诵周期</div>
      <div class="checkbox-list" id="cycle-pick">
        ${list.map(t => `<label><input type="checkbox" value="${t.id}"><span>${esc(t.type)} · ${esc(t.title || '(无标题)')}${t.scheduledDate ? '（' + esc(day(t.scheduledDate)) + '）' : ''}</span></label>`).join('')}
      </div>
      <div class="form-actions" style="margin-top:10px">
        <input id="cycle-days" type="number" min="1" max="365" placeholder="天数（留空=长期）" style="padding:8px;border:1px solid #9ab0c8;border-radius:8px;font-family:inherit;font-size:13px;width:140px">
        <button class="btn primary" onclick="startCycle()">开始新周期</button>
      </div>
    </div>
    ${list.map(t => `
      <div class="item">
        <div class="head"><span class="title">${esc(t.type)} · ${esc(t.title || '(无标题)')}</span></div>
        <div class="meta">${rangeById[t.id] ? '周期：' + esc(rangeById[t.id]) + '　' : ''}${!rangeById[t.id] && t.scheduledDate ? '发布安排：' + esc(day(t.scheduledDate)) + '　' : ''}${t.source ? '来源：' + esc(t.source) + '　' : ''}${t.fileName ? '<a href="/uploads/' + encodeURIComponent(t.fileName) + '" target="_blank">附件</a>' : ''}</div>
        <div class="body">${esc(t.content)}</div>
        <div class="actions">
          <button class="btn small ghost" onclick="togglePick(this, '${t.id}')">${isPicked(t.id) ? '✓ 已选' : '加入周期'}</button>
          <button class="btn small primary" onclick="writeGooddeedFromTeaching('${t.id}','${esc(t.title || '(无标题)').replace(/'/g, "\\'")}','${esc(t.type)}')">写善叙述</button>
          <button class="btn small ghost" onclick="downloadTeaching('${t.id}')">下载</button>
          ${state.user && state.user.role === 'admin' ? `
            <button class="btn small ghost" onclick="editTeachingById('${t.id}')">修改</button>
            <button class="btn small danger" onclick="delTeaching('${t.id}')">删除</button>` : ''}
        </div>
      </div>`).join('')}`;
  // 普通成员隐藏周期规划
  if (state.user.role !== 'admin') {
    const cards = document.querySelectorAll('#tg-list .card');
    cards.forEach(c => c.style.display = 'none');
    document.querySelectorAll('#tg-list .item .actions .btn.ghost').forEach(btn => {
      if (btn.textContent.includes('加入周期') || btn.textContent.includes('已选')) btn.style.display = 'none';
    });
  }
}

function isPicked(id) { return state.picks && state.picks.includes(id); }

function togglePick(btn, id) {
  state.picks = state.picks || [];
  const i = state.picks.indexOf(id);
  if (i >= 0) { state.picks.splice(i, 1); btn.textContent = '加入周期'; }
  else { state.picks.push(id); btn.textContent = '✓ 已选'; }
  // 同步勾选框
  const cb = document.querySelector(`#cycle-pick input[value="${id}"]`);
  if (cb) cb.checked = i < 0;
}
window.togglePick = togglePick;

async function startCycle() {
  state.picks = state.picks || [];
  const ids = state.picks;
  const checked = Array.from(document.querySelectorAll('#cycle-pick input:checked')).map(x => x.value);
  const final = Array.from(new Set([...ids, ...checked]));
  if (!final.length) { toast('请至少选择一条内容'); return; }
  const daysSel = document.getElementById('cycle-days');
  const days = daysSel ? daysSel.value : '';
  try {
    await api('/api/cycles', { method: 'POST', body: JSON.stringify({ teachingIds: final, days: days || undefined }) });
    state.picks = [];
    toast(days ? `新背诵周期已开始（${days} 天）` : '新背诵周期已开始（长期）');
    switchView('mine');
  } catch (e) { toast(e.message); }
}
window.startCycle = startCycle;

// 从偈语/开示列表点"写善叙述"：带上 teachingId 跳到善叙述页
function writeGooddeedFromTeaching(id, title, type) {
  state.pendingTeachingId = id;
  state.pendingTeachingTitle = title;
  state.pendingTeachingType = type;
  switchView('gooddeeds');
  setTimeout(() => {
    const ta = document.getElementById('gd-new');
    if (ta) ta.focus();
    toast('正在为《' + title + '》写善叙述');
  }, 300);
}
window.writeGooddeedFromTeaching = writeGooddeedFromTeaching;

// ================= 善叙述 =================
// 附件工具
function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}
function readFileBase64(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}
function renderAtts(atts, isOwner, gdId) {
  if (!atts || !atts.length) return '';
  return `<div class="att-list">${atts.map(a => `
    <div class="att-item">
      <a class="att-name" href="/uploads/${encodeURIComponent(a.fileName)}" target="_blank">${esc(a.name)}（${fmtSize(a.size)}）</a>
      ${isOwner ? `<button class="btn small danger" onclick="delGooddeedAtt('${gdId}','${a.id}')">删除</button>` : ''}
    </div>`).join('')}</div>`;
}

// 计算善叙述剩余保留天数（30 天）
function daysLeft(createdAtIso) {
  const total = 30 * 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - new Date(createdAtIso).getTime();
  return Math.ceil((total - elapsed) / (24 * 60 * 60 * 1000));
}
function retentionHint(gd) {
  const left = daysLeft(gd.createdAt);
  if (left <= 0) return '<span style="color:#b23a2e;font-weight:600">⚠ 已过保留期，仅保留最终版，请及时下载保存</span>';
  if (left <= 7) return `<span style="color:#b23a2e;font-weight:600">⚠ 还剩 ${left} 天仅保留最终版，请及时下载保存</span>`;
  return '';
}

async function renderGooddeeds(c) {
  c.innerHTML = '<div class="empty">加载中…</div>';
  const mine = await api('/api/gooddeeds/mine');
  const all = await api('/api/gooddeeds');
  const myNewest = mine.gooddeeds.length ? mine.gooddeeds[0] : null;
  c.innerHTML = `
    <div class="card gd-box">
      <h3>我的善叙述（${mine.gooddeeds.length} 条）</h3>
      ${state.pendingTeachingId ? `
        <div style="background:#e8f0f8;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:14px;color:#1f4a6a">
          正在为 <b>${esc(state.pendingTeachingType)}《${esc(state.pendingTeachingTitle)}》</b> 写善叙述
          <button class="btn small ghost" style="margin-left:8px" onclick="cancelPendingTeaching()">取消关联</button>
        </div>` : ''}
      ${mine.gooddeeds.length ? mine.gooddeeds.map((g, i) => `
        <div class="item gd-box" style="border-top:1px solid #e5edf5;padding-top:10px">
          <div class="head"><span class="title">${i + 1}. ${g.title ? '《' + esc(g.title) + '》' : ''}</span><span class="meta">${fmtTime(g.updatedAt)} · ${g.versionCount} 版</span></div>
          <div style="margin-bottom:6px">${retentionHint(g)}</div>
          <div class="body" style="margin-bottom:6px">${esc(g.content)}</div>
          ${renderAtts(g.attachments, true, g.id)}
          <div class="actions">
            <button class="btn small ghost" onclick="openEditGooddeed('${g.id}','${esc(g.content.replace(/'/g, "\\'").replace(/\n/g, '\\n'))}',${g.updateLeft})">编辑</button>
            <button class="btn small danger" onclick="delGooddeed('${g.id}')">删除</button>
            <button class="btn small ghost" onclick="showGooddeedDetail('${g.id}')">查看反馈</button>
            <button class="btn small ghost" onclick="downloadGooddeed('${g.id}', '${esc(g.content.replace(/'/g, "\\'").replace(/\n/g, '\\n'))}', '${esc(state.user.username)}')">下载到本地</button>
          </div>
        </div>`).join('') : '<div class="small">今天还没写善叙述</div>'}
      <div class="field" style="margin-top:12px"><label>题目</label><input id="gd-title" type="text" placeholder="给你的善叙述起个题目…"></div>
      <div class="field"><label>字数不限</label><textarea id="gd-new" placeholder=""></textarea></div>
      <div class="field"><label>文档附件（PDF / Word，可选，单文件 ≤ 8MB）</label><input id="gd-files" type="file" accept=".pdf,.doc,.docx" multiple></div>
      <div class="att-file-hint" id="gd-file-preview"></div>
      <div class="form-actions" style="margin-top:8px"><button class="btn primary" onclick="submitGooddeed()">递交</button></div>
    </div>
    <div id="gd-list"></div>`;
  const fileInput = document.getElementById('gd-files');
  if (fileInput) fileInput.addEventListener('change', () => {
    const names = Array.from(fileInput.files || []).map(f => f.name).join('、');
    document.getElementById('gd-file-preview').textContent = names ? '已选择：' + names : '';
  });
  const box = document.getElementById('gd-list');
  if (!all.gooddeeds.length) { box.innerHTML = '<div class="empty">还没有人发表善叙述</div>'; return; }
  box.innerHTML = all.gooddeeds.map(g => `
    <div class="item gd-box">
      <div class="head"><span class="title">${esc(g.author.username)}</span><span class="meta">${fmtTime(g.updatedAt)} · ${g.versionCount} 版</span></div>
      ${g.teaching ? `<div style="font-size:13px;color:#1f4a6a;margin-bottom:6px">针对 ${esc(g.teaching.type)}《${esc(g.teaching.title)}》</div>` : ''}
      <div class="body">${esc(g.content)}</div>
      ${renderAtts(g.attachments, false, g.id)}
      <div class="actions">
        <button class="btn small danger" onclick="delGooddeed('${myNewest.id}')">删除</button>
          <button class="btn small ghost" onclick="showGooddeedDetail('${g.id}')">查看反馈（${g.feedbackCount}）</button>
      </div>
      <div class="field" style="margin-top:8px"><textarea id="fb-gooddeed-${g.id}" placeholder="写下你的反馈或建议（字数不限）…" style="min-height:80px"></textarea></div>
      <div class="form-actions"><button class="btn small primary" onclick="submitFeedback('gooddeed','${g.id}')">提交反馈</button></div>
    </div>`).join('');
}

async function submitGooddeed() {
  const title = document.getElementById('gd-title').value.trim();
  const content = document.getElementById('gd-new').value.trim();
  if (!content) { toast('内容不能为空'); return; }
  const fileInput = document.getElementById('gd-files');
  const attachments = [];
  if (fileInput && fileInput.files && fileInput.files.length) {
    for (const f of Array.from(fileInput.files)) {
      attachments.push({ name: f.name, data: await readFileBase64(f) });
    }
  }
  try {
    const payload = { title, content, attachments };
    if (state.pendingTeachingId) payload.teachingId = state.pendingTeachingId;
    await api('/api/gooddeeds', { method: 'POST', body: JSON.stringify(payload) });
    state.pendingTeachingId = null;
    state.pendingTeachingTitle = null;
    toast('已发表'); renderView();
  }
  catch (e) { toast(e.message); }
}
window.submitGooddeed = submitGooddeed;

function cancelPendingTeaching() {
  state.pendingTeachingId = null;
  state.pendingTeachingTitle = null;
  state.pendingTeachingType = null;
  renderView();
}
window.cancelPendingTeaching = cancelPendingTeaching;

// 下载善叙述到本地（导出为 txt 文件）
function downloadGooddeed(id, content, username) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  const timeStr = `${p(d.getHours())}${p(d.getMinutes())}`;
  const header = `善叙述 · ${username}\n导出时间：${dateStr} ${timeStr}\n${'='.repeat(40)}\n\n`;
  const blob = new Blob([header + content], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `善叙述_${username}_${dateStr}_${timeStr}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  toast('已下载到本地');
}
window.downloadGooddeed = downloadGooddeed;
// 下载偈语/开示内容到本地
async function downloadTeaching(id) {
  const d = await api('/api/teachings');
  const t = d.teachings.find(x => x.id === id);
  if (!t) { toast('内容不存在'); return; }
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}`;
  const header = `${t.type} · ${t.title || '(无标题)'}\n${t.source ? '来源：' + t.source + '\n' : ''}${'='.repeat(40)}\n\n`;
  const blob = new Blob([header + t.content], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.type}_${t.title || '内容'}_${dateStr}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  toast('已下载到本地');
}
window.downloadTeaching = downloadTeaching;

async function openEditGooddeed(id, content, left) {
  const detail = await api('/api/gooddeeds/' + id);
  const atts = detail.gooddeed.attachments || [];
  const area = document.createElement('div');
  area.className = 'card gd-box gd-edit-area';
  area.innerHTML = `
    <h3>编辑善叙述</h3>
    <div class="field"><textarea id="gd-edit">${esc(content)}</textarea></div>
    ${renderAtts(atts, true, id)}
    <div class="field"><label>添加文档附件（PDF / Word，可选）</label><input id="gd-add-file-${id}" type="file" accept=".pdf,.doc,.docx" multiple></div>
    <div class="form-actions">
      <button class="btn primary small" onclick="saveEditGooddeed('${id}')">保存</button>
      <button class="btn ghost small" onclick="this.closest('.card').remove()">取消</button>
      <button class="btn small ghost" onclick="uploadGooddeedAtt('${id}')">上传附件</button>
    </div>`;
  document.querySelector('.gd-box').insertAdjacentElement('afterend', area);
  document.getElementById('gd-edit').focus();
}
window.openEditGooddeed = openEditGooddeed;

async function uploadGooddeedAtt(id) {
  const input = document.getElementById('gd-add-file-' + id);
  if (!input || !input.files || !input.files.length) { toast('请先选择文件'); return; }
  try {
    for (const f of Array.from(input.files)) {
      await api('/api/gooddeeds/' + id + '/attachments', { method: 'POST', body: JSON.stringify({ name: f.name, data: await readFileBase64(f) }) });
    }
    toast('附件已上传（不占用更新次数）');
    renderView();
  } catch (e) { toast(e.message); }
}
window.uploadGooddeedAtt = uploadGooddeedAtt;

async function delGooddeedAtt(id, attId) {
  if (!confirm('删除该附件？')) return;
  try { await api('/api/gooddeeds/' + id + '/attachments/' + attId, { method: 'DELETE' }); toast('已删除'); renderView(); }
  catch (e) { toast(e.message); }
}
window.delGooddeedAtt = delGooddeedAtt;

// 删除整条善叙述（作者本人或管理员）
async function delGooddeed(id) {
  if (!confirm('确定删除这条善叙述？所有版本和反馈都会一并删除。')) return;
  try {
    await api('/api/gooddeeds/' + id, { method: 'DELETE' });
    toast('已删除');
    renderView();
  } catch (e) { toast(e.message); }
}
window.delGooddeed = delGooddeed;

// 删除反馈（作者本人或管理员）
async function delFeedback(id) {
  if (!confirm('确定删除这条反馈？')) return;
  try {
    await api('/api/feedback/' + id, { method: 'DELETE' });
    toast('已删除');
    renderView();
  } catch (e) { toast(e.message); }
}
window.delFeedback = delFeedback;

// 编辑反馈
async function editFeedback(id, oldContent) {
  const newContent = prompt('修改反馈：', oldContent);
  if (newContent === null) return;
  const trimmed = newContent.trim();
  if (!trimmed) { toast('内容不能为空'); return; }
  try {
    await api('/api/feedback/' + id, { method: 'PUT', body: JSON.stringify({ content: trimmed }) });
    toast('反馈已修改');
    renderView();
  } catch (e) { toast(e.message); }
}
window.editFeedback = editFeedback;

async function saveEditGooddeed(id) {
  const content = document.getElementById('gd-edit').value.trim();
  if (!content) { toast('内容不能为空'); return; }
  try {
    const d = await api('/api/gooddeeds/' + id, { method: 'PUT', body: JSON.stringify({ content }) });
    toast(`已保存`);
    renderView();
  } catch (e) { toast(e.message); }
}
window.saveEditGooddeed = saveEditGooddeed;

async function showGooddeedDetail(id) {
  try {
    const d = await api('/api/gooddeeds/' + id);
    const gd = d.gooddeed;
    const html = `
      <div class="item gd-box">
        <div class="head"><span class="title">${esc(gd.author.username)} 的善叙述</span></div>
        <div class="body">${esc(gd.content)}</div>
        ${renderAtts(gd.attachments, false, id)}
        <div class="ver-list">${gd.versions.map((v, i) => `<div class="ver-item">版本 ${i + 1}（${fmtTime(v.updatedAt)}）：${esc(v.content)}</div>`).join('')}</div>
        <div class="section-title" style="margin-top:10px">反馈（${d.feedback.length}）</div>
        ${d.feedback.length ? d.feedback.map(f => `<div class="fb-item"><span class="who">${esc(f.author)}</span>：${esc(f.content)} <span class="muted">· ${fmtTime(f.createdAt)}</span></div>`).join('') : '<div class="muted small">暂无反馈</div>'}
      </div>`;
    const layer = document.createElement('div');
    layer.id = 'detail-layer';
    layer.innerHTML = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:50" onclick="this.parentElement.remove()"></div>
      <div style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(92vw,560px);max-height:80vh;overflow:auto;z-index:51">${html}</div>`;
    document.body.appendChild(layer);
  } catch (e) { toast(e.message); }
}
window.showGooddeedDetail = showGooddeedDetail;

// ================= 我的 =================
async function renderMine(c) {
  c.innerHTML = '<div class="empty">加载中…</div>';
  const [checkins, mine, teachings, cycles] = await Promise.all([
    api('/api/checkins/mine'),
    api('/api/gooddeeds/mine'),
    api('/api/teachings'),
    api('/api/cycles')
  ]);
  // 按日期统计打卡次数
  const byDate = {};
  (checkins.checkins || []).forEach(ck => { byDate[ck.date] = (byDate[ck.date] || 0) + 1; });
  // 题目索引：安排日期 -> 偈语/开示题目
  const titleByDate = {};
  (teachings.teachings || []).forEach(t => {
    if (t.scheduledDate && !titleByDate[t.scheduledDate]) titleByDate[t.scheduledDate] = t.title || '(无标题)';
  });
  // 周期题目：当天处于某个进行中周期内时，延续显示该周期安排的题目
  const dayKey = d => String(d).slice(0, 10);
  const activeCycles = (cycles.cycles || []).filter(cy => cy.status === 'active');
  function cycleTitle(d) {
    for (const cy of activeCycles) {
      const s = dayKey(cy.startDate);
      const e = cy.endDate ? dayKey(cy.endDate) : null;
      if (d >= s && (!e || d <= e)) {
        const t = (cy.teachings || []).find(x => x && x.title);
        if (t) return t.title;
      }
    }
    return '';
  }
  const dates = Object.keys(byDate).sort().reverse();
  const gdList = mine.gooddeeds || [];
  c.innerHTML = `
    <div class="card">
      <h3>我的账号</h3>
      <div class="small" style="margin-bottom:8px">当前昵称：<b>${esc(state.user.username)}</b>${state.user.role === 'admin' ? '（管理员）' : ''}</div>
      <div class="row2">
        <div class="field"><input id="edit-nickname" type="text" value="${esc(state.user.username)}" placeholder="输入新昵称"></div>
        <div class="form-actions" style="align-self:end"><button class="btn small primary" onclick="saveNickname()">保存昵称</button></div>
      </div>
    </div>
    <div class="card">
      <h3>打卡记录（${dates.length} 天）</h3>
      ${dates.length ? dates.map(d => `
        <div class="roster-row">
          <span class="dot done"></span>
          <span class="roster-name">${fmtDate(d)} · ${esc(titleByDate[d] || cycleTitle(d) || '（当日无安排）')} · ${byDate[d]} 次</span>
        </div>`).join('') : '<div class="empty">还没有打卡记录</div>'}
    </div>
    <div class="card">
      <h3>善叙述（${gdList.length} 条）</h3>
      ${gdList.length ? gdList.map((g, i) => `
        <div class="item">
          <div class="head"><span class="title">${i + 1}. ${g.title ? '《' + esc(g.title) + '》' : '（未命名）'}</span><span class="meta">${fmtTime(g.updatedAt)}</span></div>
        </div>`).join('') : '<div class="empty">还没有善叙述</div>'}
    </div>`;
}

async function saveNickname() {
  const name = document.getElementById('edit-nickname').value.trim();
  if (!name) { toast('昵称不能为空'); return; }
  try {
    const d = await api('/api/me', { method: 'PUT', body: JSON.stringify({ username: name }) });
    state.user = d.user;
    renderNav();
    toast('昵称已更新');
  } catch (e) { toast(e.message); }
}
window.saveNickname = saveNickname;

// ================= 反馈通用 =================
async function submitFeedback(type, id) {
  const input = document.getElementById('fb-' + type + '-' + id);
  const content = input.value.trim();
  if (!content) { toast('反馈内容不能为空'); return; }
  try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ targetType: type, targetId: id, content }) }); toast('已反馈'); input.value = ''; renderView(); }
  catch (e) { toast(e.message); }
}
window.submitFeedback = submitFeedback;

async function viewFeedback(type, id) {
  try {
    const d = await api('/api/feedback?targetType=' + type + '&targetId=' + id);
    const html = `<div class="card">
      <h3>反馈</h3>
      ${d.feedback.length ? d.feedback.map(f => `<div class="fb-item"><span class="who">${esc(f.author)}</span>：${esc(f.content)} <span class="muted">· ${fmtTime(f.createdAt)}</span></div>`).join('') : '<div class="empty">暂无反馈</div>'}
      <div class="field"><label>写下你的反馈（字数不限）</label><textarea id="fb-pop-${type}-${id}" placeholder="" style="min-height:100px"></textarea></div>
      <div class="form-actions"><button class="btn small primary" onclick="popSubmit('${type}','${id}')">提交</button></div>
    </div>`;
    const layer = document.createElement('div');
    layer.id = 'fb-layer';
    layer.innerHTML = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:50" onclick="this.parentElement.remove()"></div>
      <div style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(92vw,560px);z-index:51">${html}</div>`;
    document.body.appendChild(layer);
  } catch (e) { toast(e.message); }
}
window.viewFeedback = viewFeedback;

async function popSubmit(type, id) {
  const input = document.getElementById('fb-pop-' + type + '-' + id);
  const content = input.value.trim();
  if (!content) { toast('反馈内容不能为空'); return; }
  try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ targetType: type, targetId: id, content }) }); toast('已反馈'); document.getElementById('fb-layer').remove(); renderView(); }
  catch (e) { toast(e.message); }
}
window.popSubmit = popSubmit;

// ================= 管理 =================
let adminTab = 'teachings';
function renderAdmin(c) {
  c = c || document.getElementById('content');
  c.innerHTML = `
    <div class="tabs">
      <button class="${adminTab === 'teachings' ? 'active' : ''}" onclick="adminTabSwitch('teachings')">内容管理</button>
      <button class="${adminTab === 'users' ? 'active' : ''}" onclick="adminTabSwitch('users')">成员</button>
      <button class="${adminTab === 'checkins' ? 'active' : ''}" onclick="adminTabSwitch('checkins')">打卡内容</button>
      <button class="${adminTab === 'settings' ? 'active' : ''}" onclick="adminTabSwitch('settings')">设置</button>
    </div>
    <div id="admin-body"><div class="empty">加载中…</div></div>`;
  renderAdminBody();
}
window.adminTabSwitch = function (t) { adminTab = t; renderAdmin(document.getElementById('content')); };

async function renderAdminBody() {
  const box = document.getElementById('admin-body');
  try {
    if (adminTab === 'teachings') {
      const d = await api('/api/teachings');
      box.innerHTML = `
        <div class="card">
          <h3>${state.editingTeaching ? '编辑内容' : '新增偈语 / 开示'}</h3>
          <div class="form">
            <div class="row2">
              <div class="field"><label>类型</label><select id="a-type"><option value="偈语">偈语</option><option value="开示">开示</option></select></div>
              <div class="field"><label>标题</label><input id="a-title" placeholder="如：七佛通诫偈"></div>
            </div>
            <div class="field"><label>内容（必填）</label><textarea id="a-content"></textarea></div>
            <div class="field"><label>从 Word 文档自动填入（.docx 自动提取文字；PDF 请手动复制）</label><input id="a-file" type="file" accept=".doc,.docx,.pdf"></div>
            <div class="a-file-preview hidden" id="a-file-preview"></div>
            <div class="form-actions">
              <button class="btn primary" onclick="saveTeaching()">${state.editingTeaching ? '保存修改' : '发布'}</button>
              ${state.editingTeaching ? '<button class="btn ghost" onclick="cancelEditTeaching()">取消编辑</button>' : ''}
            </div>
          </div>
        </div>
        <div class="section-title">内容列表（${d.teachings.length}）</div>
        ${d.teachings.map(t => `
          <div class="item">
            <div class="head"><span class="title">${esc(t.type)} · ${esc(t.title || '(无标题)')}</span><span class="meta">${t.type}</span></div>
            <div class="body">${esc(t.content)}</div>
            <div class="actions">
              <button class="btn small ghost" onclick="editTeachingById('${t.id}')">编辑</button>
              <button class="btn small danger" onclick="delTeaching('${t.id}')">删除</button>
            </div>
          </div>`).join('')}`;
      // 日期输入框默认填今天
      const aDate = document.getElementById('a-date');
      if (aDate && !aDate.value) {
        const today = new Date();
        const p = n => String(n).padStart(2, '0');
        aDate.value = `-`-``;
      }
      // 绑定：选择 Word 文档后自动提取文字填入内容框
      const aFile = document.getElementById('a-file');
      if (aFile) aFile.addEventListener('change', async () => {
        const f = aFile.files && aFile.files[0];
        const preview = document.getElementById('a-file-preview');
        if (!f) { preview.classList.add('hidden'); preview.innerHTML = ''; return; }
        preview.classList.remove('hidden');
        preview.innerHTML = `<div class="fname">已选：${esc(f.name)} — 正在提取文字…</div>`;
        try {
          const data = await readFileBase64(f);
          const d = await api('/api/admin/extract-doc', { method: 'POST', body: JSON.stringify({ name: f.name, data }) });
          if (d.text) {
            document.getElementById('a-content').value = d.text;
            preview.innerHTML = `<div class="fname">✓ 已从 ${esc(f.name)} 提取文字（${d.text.length} 字），可在上方修改</div><button class="btn small danger" onclick="clearAdminFile()">取消</button>`;
            toast('文字已自动填入');
          } else {
            preview.innerHTML = `<div class="fname">${esc(d.note || '未提取到文字')}</div><button class="btn small danger" onclick="clearAdminFile()">取消</button>`;
          }
        } catch (e) {
          preview.innerHTML = `<div class="fname">提取失败：${esc(e.message)}</div><button class="btn small danger" onclick="clearAdminFile()">取消</button>`;
        }
      });
    } else if (adminTab === 'users') {
      const d = await api('/api/admin/users');
      box.innerHTML = `
        <div class="card">
          <h3>成员管理（${d.users.length} / ${d.memberLimit} 人）</h3>
          ${d.users.map(u => `
            <div class="admin-row">
              <span class="name">${esc(u.username)}<span class="badge ${u.role}">${u.role === 'admin' ? '管理员' : '成员'}</span></span>
              <span class="muted">${u.todayDone ? '今日已打卡' : '今日未打卡'}${u.telegramId ? ' · Telegram' : ''}${u.isSelf ? ' · 你' : ''}</span>
              ${!u.isSelf ? `
                <button class="btn small ghost" onclick="setRole('${u.id}','${u.role === 'admin' ? 'member' : 'admin'}')">${u.role === 'admin' ? '撤销管理员' : '设为管理员'}</button>
                <button class="btn small danger" onclick="delUser('${u.id}','${esc(u.username)}')">移除</button>` : ''}
            </div>`).join('')}
        </div>`;
    } else if (adminTab === 'checkins') {
      const d = await api('/api/admin/checkins');
      box.innerHTML = `
        <div class="card">
          <h3>全部打卡记录（${d.checkins.length} 条）</h3>
          ${d.checkins.length ? d.checkins.map(ck => `
            <div class="admin-row">
              <span class="name">${esc(ck.username)}</span>
              <span class="muted">${fmtDate(ck.date)}${ck.note ? ' · ' + esc(ck.note) : ''} · ${fmtTime(ck.createdAt)}</span>
              <button class="btn small danger" onclick="delCheckin('${ck.id}')">删除</button>
            </div>`).join('') : '<div class="empty">暂无打卡记录</div>'}
        </div>`;
    } else if (adminTab === 'settings') {
      const me = await api('/api/me');
      box.innerHTML = `
        <div class="card">
          <h3>小组设置</h3>
          <div class="field"><label>成员人数上限（当前 ${me.settings.memberLimit} 人）</label><input id="a-limit" type="number" min="1" max="500" value="${me.settings.memberLimit}"></div>
          <div class="form-actions"><button class="btn primary" onclick="saveLimit()">保存上限</button></div>
          <div class="muted small" style="margin-top:8px">小组初始 15 人，人数可随时增加。</div>
        </div>`;
    }
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function saveTeaching() {
  const content = document.getElementById('a-content').value.trim();
  if (!content) { toast('内容不能为空'); return; }
  const payload = {
    type: document.getElementById('a-type').value,
    title: document.getElementById('a-title').value.trim(),
    content
  };
  try {
    if (state.editingTeaching) {
      await api('/api/teachings/' + state.editingTeaching, { method: 'PUT', body: JSON.stringify(payload) });
      state.editingTeaching = null; toast('已保存修改');
    } else {
      await api('/api/teachings', { method: 'POST', body: JSON.stringify(payload) });
      toast('已发布');
    }
    renderAdmin();
  } catch (e) { toast(e.message); }
}
window.saveTeaching = saveTeaching;

function clearAdminFile() {
  const fi = document.getElementById('a-file'); if (fi) fi.value = '';
  const pv = document.getElementById('a-file-preview'); if (pv) { pv.classList.add('hidden'); pv.innerHTML = ''; }
}
window.clearAdminFile = clearAdminFile;

// 按 id 拉取内容并进入编辑（避免内容里有引号导致参数断裂）
async function editTeachingById(id) {
  try {
    const d = await api('/api/teachings');
    const t = d.teachings.find(x => x.id === id);
    if (!t) { toast('内容不存在'); return; }
    state.editingTeaching = id;
    state.view = 'admin';
    renderNav();
    await renderAdmin(document.getElementById('content'));
    setTimeout(() => {
      const sel = document.getElementById('a-type'); if (sel) sel.value = t.type;
      const ti = document.getElementById('a-title'); if (ti) ti.value = t.title || '';
      const co = document.getElementById('a-content'); if (co) co.value = t.content || '';
      window.scrollTo(0, 0);
    }, 300);
  } catch (e) { toast(e.message); }
}
window.editTeachingById = editTeachingById;

function editTeaching(id, type, title, content, source, date) {
  state.editingTeaching = id;
  renderAdmin();
  // 渲染后填充（renderAdmin 异步加载列表，需要等待——用 setTimeout）
  setTimeout(() => {
    const sel = document.getElementById('a-type'); if (sel) sel.value = type;
    const t = document.getElementById('a-title'); if (t) t.value = title;
    const c = document.getElementById('a-content'); if (c) c.value = content;
    window.scrollTo(0, 0);
  }, 200);
}
window.editTeaching = editTeaching;

function cancelEditTeaching() { state.editingTeaching = null; renderAdmin(); }
window.cancelEditTeaching = cancelEditTeaching;

async function delTeaching(id) {
  if (!confirm('确定删除这条内容？')) return;
  try { await api('/api/teachings/' + id, { method: 'DELETE' }); toast('已删除'); renderAdmin(); }
  catch (e) { toast(e.message); }
}
window.delTeaching = delTeaching;

async function setRole(id, role) {
  try { await api('/api/admin/users/' + id + '/role', { method: 'PUT', body: JSON.stringify({ role }) }); toast(role === 'admin' ? '已设为管理员' : '已撤销管理员'); renderAdmin(); }
  catch (e) { toast(e.message); }
}
window.setRole = setRole;

async function delUser(id, name) {
  if (!confirm(`确定移除成员「${name}」？其打卡、善叙述等记录将一并删除。`)) return;
  try { await api('/api/admin/users/' + id, { method: 'DELETE' }); toast('已移除'); renderAdmin(); }
  catch (e) { toast(e.message); }
}
window.delUser = delUser;

async function delCheckin(id) {
  if (!confirm('确定删除这条打卡记录？')) return;
  try { await api('/api/admin/checkins/' + id, { method: 'DELETE' }); toast('已删除'); renderAdmin(); }
  catch (e) { toast(e.message); }
}
window.delCheckin = delCheckin;

async function saveLimit() {
  const v = parseInt(document.getElementById('a-limit').value, 10);
  if (!v) { toast('请输入有效人数'); return; }
  try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ memberLimit: v }) }); toast('已保存'); renderAdmin(); }
  catch (e) { toast(e.message); }
}
window.saveLimit = saveLimit;

// ---------------- 启动 ----------------
init();

async function openDailyContent() {
  if (!homeData.daily) return;
  state.tgType = homeData.daily.type;
  state.q = '';
  state.picks = [];
  await renderView();
  // 等列表加载完再滚动
  setTimeout(() => {
    const items = document.querySelectorAll('#tg-list .item');
    items.forEach(item => {
      const titleEl = item.querySelector('.title');
      if (titleEl && titleEl.textContent.includes(homeData.daily.title)) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.style.background = '#e8f0f8';
        setTimeout(() => item.style.background = '', 3000);
      }
    });
  }, 500);
}
window.openDailyContent = openDailyContent;