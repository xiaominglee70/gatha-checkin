'use strict';
// ============================================================
// 偈语背诵打卡小程序 · Supabase 版
// 结构：public/ 静态前端 + Supabase 数据库 + REST API
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');
const config = require('./config');
const { createClient } = require('@supabase/supabase-js');

// ---------------- Supabase 客户端 ----------------
let supabase = null;
if (config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY) {
  supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
  console.log('[Supabase] 连接成功:', config.SUPABASE_URL);
} else {
  console.error('[Supabase] 未配置 SUPABASE_URL 或 SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// ---------------- 数据目录（附件上传用） ----------------
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------- 工具函数 ----------------
function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, telegramId: u.telegram_id || null, createdAt: u.created_at };
}

// Telegram WebApp initData 签名验证
function verifyInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computed !== hash) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - auth_date > 60 * 60 * 48) return null;
    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { user = null; }
    return user;
  } catch (e) { return null; }
}

// ---------------- 认证 ----------------
async function authUser(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  const { data: session } = await supabase.from('sessions').select('user_id').eq('token', token).single();
  if (!session) return null;
  const { data: user } = await supabase.from('users').select('*').eq('id', session.user_id).single();
  return user || null;
}

function isAdmin(user) { return user && user.role === 'admin'; }

// ---------------- 响应工具 ----------------
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function err(res, status, message) { json(res, status, { error: message }); }

function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  if (!p.startsWith(path.resolve(base))) return null;
  return p;
}

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[\\/:\*\?"<>\|\x00-\x1f]/g, '_').slice(0, 120);
}

// 附件保存：仅允许 PDF / Word，单文件 ≤ 8MB
const ATT_EXT = ['.pdf', '.doc', '.docx'];
const ATT_MAX_MB = 8;
function saveAttachment(buf, name) {
  const ext = (path.extname(String(name || '')) || '').toLowerCase();
  if (!ATT_EXT.includes(ext)) return { error: '仅支持 PDF / Word 文档（.pdf .doc .docx）' };
  if (!buf.length) return { error: '文件内容为空' };
  if (buf.length > ATT_MAX_MB * 1024 * 1024) return { error: '单文件不能超过 ' + ATT_MAX_MB + 'MB' };
  const fname = uid().slice(0, 8) + '-' + sanitizeFileName(name);
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  return { att: { id: uid(), fileName: fname, name: String(name), size: buf.length, addedAt: nowIso() } };
}

function readBody(req, limitMB) {
  return new Promise((resolve, reject) => {
    const limit = (limitMB || 30) * 1024 * 1024;
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch (e) { throw Object.assign(new Error('JSON 解析失败'), { status: 400 }); }
}

// 善叙述历史版本保留策略
async function pruneGoodDeedVersions(gd) {
  const { data: settings } = await supabase.from('settings').select('gooddeed_retention_days').eq('id', 1).single();
  const days = settings?.gooddeed_retention_days || 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  if (!Array.isArray(gd.versions)) gd.versions = [];
  const fresh = gd.versions.filter(v => new Date(v.updated_at).getTime() >= cutoff);
  if (fresh.length === 0 && gd.versions.length > 0) fresh.push(gd.versions[gd.versions.length - 1]);
  gd.versions = fresh;
  return gd;
}

// ---------------- 路由 ----------------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:([a-zA-Z]+)/g, (m, k) => { keys.push(k); return '/([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler });
}

// ============ 认证 ============
route('POST', '/api/auth/login', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    console.log('[Login] 尝试登录:', username);

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    console.log('[Login] 查询结果:', user, '错误:', userErr);

    if (!user) {
      return err(res, 404, '用户不存在: ' + username);
    }

    if (user.password_hash) {
      const salt = user.salt;
      const hash = crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
      console.log('[Login] 密码验证:', hash === user.password_hash ? '通过' : '失败');
      if (hash !== user.password_hash) {
        return err(res, 401, '密码错误');
      }
    }

    const token = crypto.randomBytes(32).toString('hex');
    const { error: sessErr } = await supabase.from('sessions').insert({ token, user_id: user.id });
    console.log('[Login] 创建session:', sessErr ? '失败: ' + JSON.stringify(sessErr) : '成功');

    json(res, 200, {
      token,
      user: { id: user.id, username: user.username, role: user.role, telegramId: user.telegram_id, createdAt: user.created_at }
    });
  } catch (e) {
    console.error('[Login] 异常:', e);
    err(res, 500, e.message + ' | ' + e.stack);
  }
});
route('POST', '/api/auth/telegram, async (req, res) => {
  if (!config.BOT_TOKEN) return err(res, 500, 'BOT_TOKEN 未配置');
  const body = await parseJsonBody(req);
  const tgUser = verifyInitData(String(body.initData || ''), config.BOT_TOKEN);
  if (!tgUser) return err(res, 401, 'Telegram 身份验证失败');
  const tgId = String(tgUser.id);

  const { data: settings } = await supabase.from('settings').select('member_limit').eq('id', 1).single();
  const memberLimit = settings?.member_limit || 15;

  let { data: user } = await supabase.from('users').select('*').eq('telegram_id', tgId).single();

  if (!user) {
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
    if (count >= memberLimit) return err(res, 403, `成员已满（上限 ${memberLimit} 人），请联系管理员增加人数`);

    const newUser = {
      id: uid(),
      username: (tgUser.username || (tgUser.first_name + (tgUser.last_name ? ' ' + tgUser.last_name : '')) || ('tg_' + tgId.slice(0, 8))),
      salt: crypto.randomBytes(12).toString('hex'),
      password_hash: null,
      role: count === 0 ? 'admin' : 'member',
      telegram_id: tgId,
    };
    const { data: created } = await supabase.from('users').insert(newUser).select().single();
    user = created;
  }

  const token = crypto.randomBytes(32).toString('hex');
  await supabase.from('sessions').insert({ token, user_id: user.id });

  json(res, 200, { token, user: publicUser(user) });
});

route('POST', '/api/auth/logout', async (req, res) => {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) {
    await supabase.from('sessions').delete().eq('token', m[1]);
  }
  json(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');
  const { data: settings } = await supabase.from('settings').select('*').eq('id', 1).single();
  json(res, 200, { user: publicUser(user), settings });
});

route('PUT', '/api/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');
  const body = await parseJsonBody(req);
  const name = String(body.username || '').trim();
  if (!name || name.length > 30) return err(res, 400, '昵称需为 1-30 个字符');

  const { data: dup } = await supabase.from('users').select('id').eq('username', name).neq('id', user.id).single();
  if (dup) return err(res, 400, '这个昵称已被使用');

  await supabase.from('users').update({ username: name }).eq('id', user.id);
  const { data: updated } = await supabase.from('users').select('*').eq('id', user.id).single();
  json(res, 200, { user: publicUser(updated) });
});

// ============ 每日偈语 / 偈语库 ============
route('GET', '/api/daily', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const today = todayStr();
  let { data: teaching } = await supabase.from('teachings').select('*').eq('scheduled_date', today).order('created_at', { ascending: false }).limit(1).single();
  let note = '今日安排';

  if (!teaching) {
    const { data: past } = await supabase.from('teachings').select('*').lte('scheduled_date', today).order('scheduled_date', { ascending: false }).limit(1).single();
    if (past) { teaching = past; note = '最近安排'; }
    else {
      const { data: latest } = await supabase.from('teachings').select('*').order('created_at', { ascending: false }).limit(1).single();
      if (latest) { teaching = latest; note = '最新内容'; }
    }
  }

  json(res, 200, {
    teaching: teaching ? {
      id: teaching.id, type: teaching.type, title: teaching.title, content: teaching.content,
      source: teaching.source, scheduledDate: teaching.scheduled_date, fileName: teaching.file_name || null
    } : null,
    note
  });
});

route('GET', '/api/teachings', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const q = (req.query.get('q') || '').trim().toLowerCase();
  const type = req.query.get('type') || '';

  let query = supabase.from('teachings').select('*').order('created_at', { ascending: false });
  if (type) query = query.eq('type', type);
  if (q) query = query.or(`title.ilike.%${q}%,content.ilike.%${q}%,source.ilike.%${q}%`);

  const { data: list } = await query;
  json(res, 200, {
    teachings: (list || []).map(x => ({
      id: x.id, type: x.type, title: x.title, content: x.content, source: x.source,
      scheduledDate: x.scheduled_date, fileName: x.file_name || null, updatedAt: x.updated_at
    }))
  });
});

route('POST', '/api/teachings', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const body = await parseJsonBody(req);
  if (!String(body.content || '').trim()) return err(res, 400, '内容不能为空');

  const rec = {
    id: uid(),
    type: body.type === '开示' ? '开示' : '偈语',
    title: String(body.title || '').trim(),
    content: String(body.content).trim(),
    source: String(body.source || '').trim(),
    scheduled_date: body.scheduledDate || null,
    file_name: null,
    created_by: user.id,
  };

  if (body.attachment && body.attachment.name && body.attachment.data) {
    const r = saveAttachment(Buffer.from(String(body.attachment.data), 'base64'), body.attachment.name);
    if (r.error) return err(res, 400, r.error);
    rec.file_name = r.att.fileName;
  }

  const { data: created } = await supabase.from('teachings').insert(rec).select().single();
  json(res, 200, { teaching: created });
});

route('PUT', '/api/teachings/:id', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const { data: rec } = await supabase.from('teachings').select('*').eq('id', req.params.id).single();
  if (!rec) return err(res, 404, '内容不存在');

  const body = await parseJsonBody(req);
  const updates = { updated_at: nowIso() };
  if (body.title !== undefined) updates.title = String(body.title).trim();
  if (body.content !== undefined) {
    if (!String(body.content).trim()) return err(res, 400, '内容不能为空');
    updates.content = String(body.content).trim();
  }
  if (body.source !== undefined) updates.source = String(body.source).trim();
  if (body.type !== undefined) updates.type = body.type === '开示' ? '开示' : '偈语';
  if (body.scheduledDate !== undefined) updates.scheduled_date = body.scheduledDate || null;

  await supabase.from('teachings').update(updates).eq('id', rec.id);
  const { data: updated } = await supabase.from('teachings').select('*').eq('id', rec.id).single();
  json(res, 200, { teaching: updated });
});

route('DELETE', '/api/teachings/:id', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const { data: rec } = await supabase.from('teachings').select('*').eq('id', req.params.id).single();
  if (!rec) return err(res, 404, '内容不存在');

  if (rec.file_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, rec.file_name)); } catch (e) {} }
  await supabase.from('teachings').delete().eq('id', rec.id);
  json(res, 200, { ok: true });
});

// ============ 背诵周期 ============
route('GET', '/api/cycles', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: cycles } = await supabase.from('cycles').select('*').eq('user_id', user.id).order('created_at', { ascending: false });

  // 补充偈语信息
  const result = await Promise.all((cycles || []).map(async (c) => {
    const teachings = await Promise.all((c.teaching_ids || []).map(async (tid) => {
      const { data: t } = await supabase.from('teachings').select('id,title,type').eq('id', tid).single();
      return t ? { id: t.id, title: t.title, type: t.type } : { id: tid, title: '(已删除)', type: '偈语' };
    }));
    return {
      id: c.id, title: c.title, teachingIds: c.teaching_ids, status: c.status,
      startDate: c.start_date, endDate: c.end_date, createdAt: c.created_at, teachings
    };
  }));

  json(res, 200, { cycles: result });
});

route('POST', '/api/cycles', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const body = await parseJsonBody(req);
  const { data: allTeachings } = await supabase.from('teachings').select('id');
  const validIds = new Set((allTeachings || []).map(t => t.id));
  const ids = Array.isArray(body.teachingIds) ? body.teachingIds.filter(id => validIds.has(id)) : [];
  if (!ids.length) return err(res, 400, '请至少选择一条偈语/开示');

  // 归档之前的活跃周期
  await supabase.from('cycles').update({ status: 'archived' }).eq('user_id', user.id).eq('status', 'active');

  let endDate = body.endDate || null;
  if (!endDate && body.days && parseInt(body.days) > 0) {
    const d = new Date(); d.setDate(d.getDate() + parseInt(body.days) - 1);
    const p = n => String(n).padStart(2, '0');
    endDate = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }

  // 把选的第一个内容的日期设成今天
  await supabase.from('teachings').update({ scheduled_date: todayStr() }).eq('id', ids[0]);

  const cycle = {
    id: uid(), user_id: user.id, title: body.title || ('周期 ' + todayStr()),
    teaching_ids: ids, status: 'active', start_date: todayStr(), end_date: endDate,
  };
  const { data: created } = await supabase.from('cycles').insert(cycle).select().single();
  json(res, 200, { cycle: created });
});

// ============ 打卡 ============
route('POST', '/api/checkins', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const body = await parseJsonBody(req);
  const today = todayStr();
  const rec = {
    id: uid(), user_id: user.id, date: today,
    note: String(body.note || '').trim().slice(0, 500),
  };
  await supabase.from('checkins').insert(rec);

  const { count } = await supabase.from('checkins').select('*', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('date', today);
  json(res, 200, { checkin: rec, todayCount: count || 0 });
});

route('GET', '/api/checkins/today', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const today = todayStr();
  const { data: allUsers } = await supabase.from('users').select('*').order('username', { ascending: true });
  const { data: todayCheckins } = await supabase.from('checkins').select('*').eq('date', today);

  const roster = (allUsers || []).map(u => {
    const mine = (todayCheckins || []).filter(c => c.user_id === u.id);
    return {
      user: publicUser(u),
      done: mine.length > 0,
      count: mine.length,
      lastNote: mine.length ? mine[mine.length - 1].note : null,
      lastAt: mine.length ? mine[mine.length - 1].created_at : null,
    };
  });

  json(res, 200, { date: today, roster });
});

route('GET', '/api/checkins/mine', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: list } = await supabase.from('checkins').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  json(res, 200, { checkins: list || [] });
});

// ============ 善叙述 ============
route('GET', '/api/gooddeeds', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: list } = await supabase.from('gooddeeds').select('*').order('updated_at', { ascending: false });

  const result = await Promise.all((list || []).map(async (gd) => {
    await pruneGoodDeedVersions(gd);
    const { data: author } = await supabase.from('users').select('*').eq('id', gd.user_id).single();
    let teaching = null;
    if (gd.teaching_id) {
      const { data: t } = await supabase.from('teachings').select('id,title,type').eq('id', gd.teaching_id).single();
      teaching = t;
    }
    const { count: feedbackCount } = await supabase.from('feedback').select('*', { count: 'exact', head: true })
      .eq('target_type', 'gooddeed').eq('target_id', gd.id);

    return {
      id: gd.id,
      author: author ? publicUser(author) : { id: gd.user_id, username: '(已移除)', role: 'member' },
      content: gd.versions.length ? gd.versions[gd.versions.length - 1].content : '',
      attachments: gd.attachments || [],
      teachingId: gd.teaching_id || null,
      teaching: teaching ? { id: teaching.id, title: teaching.title, type: teaching.type } : null,
      versionCount: gd.versions.length,
      updatedAt: gd.updated_at, createdAt: gd.created_at,
      feedbackCount: feedbackCount || 0,
    };
  }));

  json(res, 200, { gooddeeds: result });
});

route('GET', '/api/gooddeeds/mine', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: list } = await supabase.from('gooddeeds').select('*').eq('user_id', user.id).order('updated_at', { ascending: false });

  const { data: settings } = await supabase.from('settings').select('gooddeed_max_updates').eq('id', 1).single();
  const maxUpdates = settings?.gooddeed_max_updates || 999;

  const result = await Promise.all((list || []).map(async (gd) => {
    await pruneGoodDeedVersions(gd);
    let teaching = null;
    if (gd.teaching_id) {
      const { data: t } = await supabase.from('teachings').select('id,title,type').eq('id', gd.teaching_id).single();
      teaching = t;
    }
    return {
      id: gd.id, title: gd.title || '',
      content: gd.versions.length ? gd.versions[gd.versions.length - 1].content : '',
      attachments: gd.attachments || [],
      teachingId: gd.teaching_id || null,
      teaching: teaching ? { id: teaching.id, title: teaching.title, type: teaching.type } : null,
      versions: gd.versions, versionCount: gd.versions.length,
      updateLeft: Math.max(0, maxUpdates - (gd.versions.length - 1)),
      updatedAt: gd.updated_at, createdAt: gd.created_at,
    };
  }));

  json(res, 200, { gooddeeds: result });
});

route('POST', '/api/gooddeeds', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const body = await parseJsonBody(req);
  const content = String(body.content || '').trim();
  if (!content) return err(res, 400, '善叙述内容不能为空');

  const today = todayStr();
  const { data: todayCheckin } = await supabase.from('checkins').select('id').eq('user_id', user.id).eq('date', today).order('created_at', { ascending: false }).limit(1).single();

  const attachments = [];
  if (Array.isArray(body.attachments)) {
    for (const att of body.attachments) {
      if (!att || !att.name) continue;
      const r = saveAttachment(Buffer.from(String(att.data || ''), 'base64'), att.name);
      if (r.error) return err(res, 400, r.error);
      attachments.push(r.att);
    }
  }

  const rec = {
    id: uid(), user_id: user.id, title: String(body.title || '').trim(),
    checkin_id: body.checkinId || (todayCheckin?.id || null),
    teaching_id: body.teachingId || null,
    versions: [{ content, updated_at: nowIso() }],
    attachments,
  };
  const { data: created } = await supabase.from('gooddeeds').insert(rec).select().single();
  json(res, 200, { gooddeed: { id: created.id, attachments: created.attachments } });
});

route('PUT', '/api/gooddeeds/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: gd } = await supabase.from('gooddeeds').select('*').eq('id', req.params.id).single();
  if (!gd) return err(res, 404, '善叙述不存在');
  if (gd.user_id !== user.id) return err(res, 403, '只能更新自己的善叙述');

  const body = await parseJsonBody(req);
  const content = String(body.content || '').trim();
  if (!content) return err(res, 400, '内容不能为空');

  const updates = {
    content,
    versions: [{ content, updated_at: nowIso() }],
    updated_at: nowIso(),
  };
  await supabase.from('gooddeeds').update(updates).eq('id', gd.id);
  json(res, 200, { gooddeed: { id: gd.id, versions: updates.versions, versionCount: 1 } });
});

route('GET', '/api/gooddeeds/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: gd } = await supabase.from('gooddeeds').select('*').eq('id', req.params.id).single();
  if (!gd) return err(res, 404, '善叙述不存在');

  await pruneGoodDeedVersions(gd);
  const { data: author } = await supabase.from('users').select('*').eq('id', gd.user_id).single();
  const { data: feedbackList } = await supabase.from('feedback').select('*, users(username)').eq('target_type', 'gooddeed').eq('target_id', gd.id);

  json(res, 200, {
    gooddeed: {
      id: gd.id,
      author: author ? publicUser(author) : { id: gd.user_id, username: '(已移除)', role: 'member' },
      attachments: gd.attachments || [],
      versions: gd.versions,
      content: gd.versions.length ? gd.versions[gd.versions.length - 1].content : '',
      updatedAt: gd.updated_at, createdAt: gd.created_at,
    },
    feedback: (feedbackList || []).map(f => ({
      id: f.id, content: f.content, createdAt: f.created_at,
      author: f.users?.username || '(已移除)'
    }))
  });
});

// 善叙述附件：追加
route('POST', '/api/gooddeeds/:id/attachments', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: gd } = await supabase.from('gooddeeds').select('*').eq('id', req.params.id).single();
  if (!gd) return err(res, 404, '善叙述不存在');
  if (gd.user_id !== user.id) return err(res, 403, '只能给自己的善叙述添加附件');

  const body = await parseJsonBody(req);
  if (!body.name || !body.data) return err(res, 400, '缺少文件');

  const r = saveAttachment(Buffer.from(String(body.data), 'base64'), body.name);
  if (r.error) return err(res, 400, r.error);

  const attachments = [...(gd.attachments || []), r.att];
  await supabase.from('gooddeeds').update({ attachments }).eq('id', gd.id);
  json(res, 200, { attachments });
});

// 善叙述附件：删除
route('DELETE', '/api/gooddeeds/:id/attachments/:attId', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: gd } = await supabase.from('gooddeeds').select('*').eq('id', req.params.id).single();
  if (!gd) return err(res, 404, '善叙述不存在');
  if (gd.user_id !== user.id) return err(res, 403, '只能删除自己善叙述的附件');

  const att = (gd.attachments || []).find(a => a.id === req.params.attId);
  if (!att) return err(res, 404, '附件不存在');

  const attachments = (gd.attachments || []).filter(a => a.id !== req.params.attId);
  await supabase.from('gooddeeds').update({ attachments }).eq('id', gd.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, att.fileName)); } catch (e) {}
  json(res, 200, { ok: true });
});

// 删除整条善叙述
route('DELETE', '/api/gooddeeds/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: gd } = await supabase.from('gooddeeds').select('*').eq('id', req.params.id).single();
  if (!gd) return err(res, 404, '善叙述不存在');
  if (gd.user_id !== user.id && user.role !== 'admin') return err(res, 403, '只能删除自己的善叙述');

  (gd.attachments || []).forEach(a => { try { fs.unlinkSync(path.join(UPLOAD_DIR, a.fileName)); } catch (e) {} });
  await supabase.from('feedback').delete().eq('target_type', 'gooddeed').eq('target_id', gd.id);
  await supabase.from('gooddeeds').delete().eq('id', gd.id);
  json(res, 200, { ok: true });
});

// ============ 反馈 ============
route('POST', '/api/feedback', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const body = await parseJsonBody(req);
  const type = String(body.targetType || '');
  const targetId = String(body.targetId || '');
  if (!['teaching', 'checkin', 'gooddeed'].includes(type)) return err(res, 400, 'targetType 无效');
  const content = String(body.content || '').trim();
  if (!content) return err(res, 400, '反馈内容不能为空');

  const rec = {
    id: uid(), user_id: user.id, target_type: type, target_id: targetId,
    content: content.slice(0, 1000),
  };
  const { data: created } = await supabase.from('feedback').insert(rec).select().single();
  json(res, 200, { feedback: created });
});

route('GET', '/api/feedback', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const type = req.query.get('targetType') || '';
  const targetId = req.query.get('targetId') || '';

  let query = supabase.from('feedback').select('*, users(username)').order('created_at', { ascending: false });
  if (type) query = query.eq('target_type', type);
  if (targetId) query = query.eq('target_id', targetId);

  const { data: list } = await query;
  json(res, 200, {
    feedback: (list || []).map(f => ({
      id: f.id, targetType: f.target_type, targetId: f.target_id,
      content: f.content, createdAt: f.created_at,
      author: f.users?.username || '(已移除)'
    }))
  });
});

route('PUT', '/api/feedback/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: f } = await supabase.from('feedback').select('*').eq('id', req.params.id).single();
  if (!f) return err(res, 404, '反馈不存在');
  if (f.user_id !== user.id) return err(res, 403, '只能编辑自己的反馈');

  const body = await parseJsonBody(req);
  const content = String(body.content || '').trim();
  if (!content) return err(res, 400, '内容不能为空');

  await supabase.from('feedback').update({ content, updated_at: nowIso() }).eq('id', f.id);
  json(res, 200, { feedback: { ...f, content } });
});

route('DELETE', '/api/feedback/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const { data: f } = await supabase.from('feedback').select('*').eq('id', req.params.id).single();
  if (!f) return err(res, 404, '反馈不存在');
  if (f.user_id !== user.id && user.role !== 'admin') return err(res, 403, '只能删除自己的反馈');

  await supabase.from('feedback').delete().eq('id', f.id);
  json(res, 200, { ok: true });
});

// ============ 文档文本提取 ============
function extractDocxText(base64Data, originalName) {
  return new Promise((resolve, reject) => {
    const ext = (path.extname(String(originalName || '')) || '').toLowerCase();
    if (ext === '.pdf') return resolve({ text: null, note: 'PDF 暂不支持自动提取，请手动复制内容到文本框' });
    if (ext === '.doc') return resolve({ text: null, note: '旧版 .doc 暂不支持，请另存为 .docx 后上传' });
    if (ext !== '.docx') return resolve({ text: null, note: '仅 .docx 支持自动提取文字' });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatha-extract-'));
    const tmpZip = path.join(tmpDir, 'input.zip');
    fs.writeFileSync(tmpZip, Buffer.from(String(base64Data || ''), 'base64'));

    const isWin = process.platform === 'win32';
    const expandDir = path.join(tmpDir, 'unzipped');
    const expandCmd = isWin
      ? ['powershell', '-NoProfile', '-Command', `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${expandDir}' -Force`]
      : ['unzip', '-o', tmpZip, '-d', expandDir];

    execFile(expandCmd[0], expandCmd.slice(1), { timeout: 15000 }, (err) => {
      if (err) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} return reject(new Error('解压文档失败，请确认是有效的 .docx 文件')); }
      try {
        const xmlPath = path.join(expandDir, 'unzipped', 'word', 'document.xml');
        if (!fs.existsSync(xmlPath)) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} return resolve({ text: null, note: '未在文档中找到文本内容' }); }
        const xml = fs.readFileSync(xmlPath, 'utf8');
        const paragraphs = xml.split(/<w:p[ >]/).slice(1);
        const lines = paragraphs.map(p => {
          const texts = p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
          return texts.map(t => t.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, '')).join('');
        }).filter(line => line.trim().length > 0);
        const text = lines.join('\n').trim();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        if (!text) return resolve({ text: null, note: '文档中未提取到文字（可能是图片型文档）' });
        resolve({ text });
      } catch (e) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) {} reject(new Error('读取文档内容失败')); }
    });
  });
}

route('POST', '/api/admin/extract-doc', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');
  const body = await parseJsonBody(req);
  if (!body.name || !body.data) return err(res, 400, '缺少文件');
  try {
    const r = await extractDocxText(body.data, body.name);
    json(res, 200, r);
  } catch (e) { err(res, 400, e.message); }
});

// ============ 管理 ============
route('GET', '/api/admin/users', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const today = todayStr();
  const { data: allUsers } = await supabase.from('users').select('*').order('username', { ascending: true });
  const { data: todayCheckins } = await supabase.from('checkins').select('user_id').eq('date', today);
  const checkedInUserIds = new Set((todayCheckins || []).map(c => c.user_id));
  const { data: settings } = await supabase.from('settings').select('member_limit').eq('id', 1).single();

  json(res, 200, {
    memberLimit: settings?.member_limit || 15,
    users: (allUsers || []).map(u => ({
      ...publicUser(u),
      todayDone: checkedInUserIds.has(u.id),
      isSelf: u.id === user.id,
    }))
  });
});

route('PUT', '/api/admin/users/:id/role', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const { data: target } = await supabase.from('users').select('*').eq('id', req.params.id).single();
  if (!target) return err(res, 404, '用户不存在');

  const body = await parseJsonBody(req);
  const role = body.role === 'admin' ? 'admin' : 'member';

  if (role !== 'admin' && target.role === 'admin') {
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'admin');
    if (count <= 1) return err(res, 400, '至少保留一名管理员');
  }

  await supabase.from('users').update({ role }).eq('id', target.id);
  json(res, 200, { user: publicUser({ ...target, role }) });
});

route('DELETE', '/api/admin/users/:id', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');
  if (req.params.id === user.id) return err(res, 400, '不能移除自己');

  const { data: target } = await supabase.from('users').select('*').eq('id', req.params.id).single();
  if (!target) return err(res, 404, '用户不存在');

  if (target.role === 'admin') {
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'admin');
    if (count <= 1) return err(res, 400, '至少保留一名管理员');
  }

  await supabase.from('checkins').delete().eq('user_id', target.id);
  await supabase.from('gooddeeds').delete().eq('user_id', target.id);
  await supabase.from('cycles').delete().eq('user_id', target.id);
  await supabase.from('feedback').delete().eq('user_id', target.id);
  await supabase.from('sessions').delete().eq('user_id', target.id);
  await supabase.from('users').delete().eq('id', target.id);

  json(res, 200, { ok: true });
});

route('PUT', '/api/admin/settings', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const body = await parseJsonBody(req);
  const limit = parseInt(body.memberLimit, 10);
  if (!(limit >= 1 && limit <= 500)) return err(res, 400, '人数上限需为 1-500');

  await supabase.from('settings').update({ member_limit: limit }).eq('id', 1);
  const { data: settings } = await supabase.from('settings').select('*').eq('id', 1).single();
  json(res, 200, { settings });
});

route('GET', '/api/admin/checkins', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const { data: list } = await supabase.from('checkins').select('*, users(username)').order('created_at', { ascending: false });
  json(res, 200, {
    checkins: (list || []).map(c => ({ ...c, username: c.users?.username || '(已移除)' }))
  });
});

route('DELETE', '/api/admin/checkins/:id', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  await supabase.from('checkins').delete().eq('id', req.params.id);
  json(res, 200, { ok: true });
});

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

function serveFile(res, absPath) {
  if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return err(res, 404, '文件不存在');
  const ext = path.extname(absPath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(absPath).pipe(res);
}

// ---------------- 服务器 ----------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(__dirname, 'public', 'index.html'));
      if (pathname.startsWith('/static/')) {
        const p = safeJoin(path.join(__dirname, 'public'), pathname.slice('/static/'.length));
        return serveFile(res, p);
      }
      if (pathname.startsWith('/uploads/')) {
        const p = safeJoin(UPLOAD_DIR, pathname.slice('/uploads/'.length));
        return serveFile(res, p);
      }
    }

    req.query = url.searchParams;
    req.params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.rx);
      if (!m) continue;
      r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
      await r.handler(req, res);
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || 500;
    json(res, status, { error: e.message || '服务器错误' });
  }
});

// ---------------- 首次启动种子数据 ----------------
async function seed() {
  const { count: userCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
  if (userCount === 0) {
    const salt = crypto.randomBytes(12).toString('hex');
    await supabase.from('users').insert({
      id: uid(), username: 'admin', salt,
      password_hash: hashPassword('admin123', salt), role: 'admin', telegram_id: null,
    });
    console.log('[Seed] 已创建管理员账号: admin / admin123');
  }

  const { count: teachingCount } = await supabase.from('teachings').select('*', { count: 'exact', head: true });
  if (teachingCount === 0) {
    await supabase.from('teachings').insert([
      { id: uid(), type: '偈语', title: '七佛通诫偈', content: '诸恶莫作，众善奉行；自净其意，是诸佛教。', source: '《增一阿含经》' },
      { id: uid(), type: '开示', title: '心念如镜', content: '心念如镜，尘来尘去，镜体不动；观照而不随转，即是修行。', source: '示例开示（可删除）' },
    ]);
    console.log('[Seed] 已插入示例偈语');
  }
}

seed().then(() => {
  server.listen(config.PORT, () => {
    console.log('==========================================');
    console.log('  偈语背诵打卡 · Supabase 版已启动');
    console.log(`  地址: http://localhost:${config.PORT}`);
    console.log(`  管理员: admin / admin123（首次启动自动创建）`);
    console.log('==========================================');
  });
});
