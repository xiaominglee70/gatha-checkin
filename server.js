'use strict';
// ============================================================
// 偈语背诵打卡小程序 · PostgreSQL 直连版
// 结构：根目录/public 静态前端 + PostgreSQL 数据库（pg 直连）
// 环境变量：DATABASE_URL（必填）、BOT_TOKEN（Telegram）
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');
const { Pool } = require('pg');

// ---------------- 数据库连接 ----------------
const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) {
  console.error('[DB] 未配置 DATABASE_URL 环境变量');
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ---------------- 配置 ----------------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const MEMBER_LIMIT_DEFAULT = 15;
const GOODDEED_MAX_UPDATES = 999;
const GOODDEED_RETENTION_DAYS = 30;
const PORT = process.env.PORT || 10000;

// ---------------- 数据目录（附件上传用） ----------------
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------- 工具函数 ----------------
function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
// 业务时区：蒙特利尔（America/Toronto，自动处理夏令时）。
// 服务器（Render）时钟是 UTC，必须显式按业务时区取"今天"的日期，
// 否则蒙特利尔晚上 23 点后程序会误判为第二天，导致"今日无安排"。
const BIZ_TZ = 'America/Toronto';
function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BIZ_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
// 在某个日期字符串（YYYY-MM-DD）上加 days 天（纯字符串日期算术，避免 UTC 干扰）
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, telegramId: u.telegram_id || null, createdAt: u.created_at };
}

// ---------------- 数据库辅助函数 ----------------
async function q(sql, params) {
  const { rows } = await pool.query(sql, params || []);
  return rows;
}
async function qOne(sql, params) {
  const { rows } = await pool.query(sql, params || []);
  return rows[0] || null;
}
async function countTable(sql, params) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${sql}`, params || []);
  return rows[0].c;
}
function prepVal(v) {
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}
async function insertRow(table, obj) {
  const keys = Object.keys(obj);
  const cols = keys.map(k => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map(k => prepVal(obj[k]));
  const { rows } = await pool.query(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`, values);
  return rows[0];
}
async function updateRow(table, obj, whereCol, whereVal) {
  const keys = Object.keys(obj);
  const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  const values = [...keys.map(k => prepVal(obj[k])), whereVal];
  const { rows } = await pool.query(`UPDATE "${table}" SET ${sets} WHERE "${whereCol}" = $${keys.length + 1} RETURNING *`, values);
  return rows[0];
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
    if (!authDate || Date.now() / 1000 - authDate > 60 * 60 * 48) return null;
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
  const session = await qOne('SELECT user_id FROM sessions WHERE token = $1 LIMIT 1', [token]);
  if (!session) return null;
  return await qOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [session.user_id]);
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
  const settings = await qOne('SELECT gooddeed_retention_days FROM settings WHERE id = 1 LIMIT 1');
  const days = settings?.gooddeed_retention_days || GOODDEED_RETENTION_DAYS;
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
  const body = await parseJsonBody(req);
  const username = String(body.username || '').trim();
  if (!username || username.length > 30) return err(res, 400, '用户名需为 1-30 个字符');

  const settings = await qOne('SELECT member_limit FROM settings WHERE id = 1 LIMIT 1');
  const memberLimit = settings?.member_limit || MEMBER_LIMIT_DEFAULT;

  let user = await qOne('SELECT * FROM users WHERE username = $1 LIMIT 1', [username]);

  if (!user) {
    const count = await countTable('users');
    if (count >= memberLimit) return err(res, 403, `成员已满（上限 ${memberLimit} 人），请联系管理员增加人数`);

    const salt = crypto.randomBytes(12).toString('hex');
    user = await insertRow('users', {
      id: uid(),
      username,
      salt,
      password_hash: body.password ? hashPassword(String(body.password), salt) : null,
      role: count === 0 ? 'admin' : 'member',
      telegram_id: null,
    });
  } else {
    if (user.password_hash) {
      if (!body.password || hashPassword(String(body.password), user.salt) !== user.password_hash) return err(res, 401, '密码错误');
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  await insertRow('sessions', { token, user_id: user.id });

  json(res, 200, { token, user: publicUser(user) });
});

route('POST', '/api/auth/telegram', async (req, res) => {
  if (!BOT_TOKEN) return err(res, 500, 'BOT_TOKEN 未配置');
  const body = await parseJsonBody(req);
  const tgUser = verifyInitData(String(body.initData || ''), BOT_TOKEN);
  if (!tgUser) return err(res, 401, 'Telegram 身份验证失败');
  const tgId = String(tgUser.id);

  const settings = await qOne('SELECT member_limit FROM settings WHERE id = 1 LIMIT 1');
  const memberLimit = settings?.member_limit || MEMBER_LIMIT_DEFAULT;

  let user = await qOne('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [tgId]);

  if (!user) {
    const count = await countTable('users');
    if (count >= memberLimit) return err(res, 403, `成员已满（上限 ${memberLimit} 人），请联系管理员增加人数`);

    user = await insertRow('users', {
      id: uid(),
      username: (tgUser.username || (tgUser.first_name + (tgUser.last_name ? ' ' + tgUser.last_name : '')) || ('tg_' + tgId.slice(0, 8))),
      salt: crypto.randomBytes(12).toString('hex'),
      password_hash: null,
      role: count === 0 ? 'admin' : 'member',
      telegram_id: tgId,
    });
  }

  const token = crypto.randomBytes(32).toString('hex');
  await insertRow('sessions', { token, user_id: user.id });

  json(res, 200, { token, user: publicUser(user) });
});

route('POST', '/api/auth/logout', async (req, res) => {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [m[1]]);
  }
  json(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');
  const settings = await qOne('SELECT * FROM settings WHERE id = 1 LIMIT 1');
  json(res, 200, { user: publicUser(user), settings });
});

route('PUT', '/api/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');
  const body = await parseJsonBody(req);
  const name = String(body.username || '').trim();
  if (!name || name.length > 30) return err(res, 400, '昵称需为 1-30 个字符');

  const dup = await qOne('SELECT id FROM users WHERE username = $1 AND id != $2 LIMIT 1', [name, user.id]);
  if (dup) return err(res, 400, '这个昵称已被使用');

  await updateRow('users', { username: name }, 'id', user.id);
  const updated = await qOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [user.id]);
  json(res, 200, { user: publicUser(updated) });
});

// ============ 每日偈语 / 偈语库 ============
route('GET', '/api/daily', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const today = todayStr();
  // 当天显式安排优先；没有显式安排时，若进行中的多天周期覆盖今天（延续安排），则显示周期第一条内容
  const teaching = await qOne(
    `SELECT * FROM (
       SELECT t1.*, 1 AS prio FROM teachings t1 WHERE t1.scheduled_date = $1
       UNION ALL
       SELECT t2.*, 2 AS prio FROM cycles c JOIN teachings t2 ON t2.id = c.teaching_ids[1]
       WHERE c.status = 'active' AND c.start_date <= $1 AND (c.end_date IS NULL OR c.end_date >= $1)
     ) sub ORDER BY prio, created_at DESC LIMIT 1`,
    [today]);
  const note = '今日安排';

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

  const q2 = (req.query.get('q') || '').trim().toLowerCase();
  const type = req.query.get('type') || '';

  let sql = 'SELECT * FROM teachings';
  const conds = [];
  const params = [];
  if (type) { params.push(type); conds.push(`type = $${params.length}`); }
  if (q2) { params.push(`%${q2}%`); conds.push(`(title ILIKE $${params.length} OR content ILIKE $${params.length} OR source ILIKE $${params.length})`); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  const list = await q(sql, params);
  const total = await countTable('teachings' + (type ? ' WHERE type = $1' : ''), type ? [type] : []);
  json(res, 200, {
    teachings: (list || []).map(x => ({
      id: x.id, type: x.type, title: x.title, content: x.content, source: x.source,
      scheduledDate: x.scheduled_date, fileName: x.file_name || null, updatedAt: x.updated_at
    })),
    total: total || 0
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

  const created = await insertRow('teachings', rec);
  json(res, 200, { teaching: created });
});

route('PUT', '/api/teachings/:id', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const rec = await qOne('SELECT * FROM teachings WHERE id = $1 LIMIT 1', [req.params.id]);
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

  await updateRow('teachings', updates, 'id', rec.id);
  const updated = await qOne('SELECT * FROM teachings WHERE id = $1 LIMIT 1', [rec.id]);
  json(res, 200, { teaching: updated });
});

route('DELETE', '/api/teachings/:id', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const rec = await qOne('SELECT * FROM teachings WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!rec) return err(res, 404, '内容不存在');

  if (rec.file_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, rec.file_name)); } catch (e) {} }
  await pool.query('DELETE FROM teachings WHERE id = $1', [rec.id]);
  json(res, 200, { ok: true });
});

// ============ 背诵周期 ============
route('GET', '/api/cycles', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const cycles = await q('SELECT * FROM cycles WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);

  // 补充偈语信息
  const result = await Promise.all((cycles || []).map(async (c) => {
    const teachings = await Promise.all((c.teaching_ids || []).map(async (tid) => {
      const t = await qOne('SELECT id, title, type FROM teachings WHERE id = $1 LIMIT 1', [tid]);
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
  const allTeachings = await q('SELECT id FROM teachings');
  const validIds = new Set((allTeachings || []).map(t => t.id));
  const ids = Array.isArray(body.teachingIds) ? body.teachingIds.filter(id => validIds.has(id)) : [];
  if (!ids.length) return err(res, 400, '请至少选择一条偈语/开示');

  // 归档之前的活跃周期
  await pool.query('UPDATE cycles SET status = $1 WHERE user_id = $2 AND status = $3', ['archived', user.id, 'active']);

  let endDate = body.endDate || null;
  if (!endDate && body.days && parseInt(body.days) > 0) {
    endDate = addDaysToDateStr(todayStr(), parseInt(body.days) - 1);
  }

  // 清除今天已有的旧安排，避免首页显示过期的偈语/开示
  await pool.query('UPDATE teachings SET scheduled_date = NULL WHERE scheduled_date = $1', [todayStr()]);
  // 把选的第一个内容的日期设成今天
  await pool.query('UPDATE teachings SET scheduled_date = $1 WHERE id = $2', [todayStr(), ids[0]]);

  // teaching_ids 是 PostgreSQL 数组列，必须以数组参数传入（pg 驱动自动转成 {..} 格式），
  // 不能走 prepVal 的 JSON.stringify，否则会报 malformed array literal
  const created = await qOne(
    `INSERT INTO cycles (id, user_id, title, teaching_ids, status, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [uid(), user.id, body.title || ('周期 ' + todayStr()), ids, 'active', todayStr(), endDate]
  );
  json(res, 200, { cycle: created });
});

// 撤销安排：删除包含该内容的进行中周期，并清除其今日安排
route('DELETE', '/api/cycles/by-teaching/:tid', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');
  const tid = req.params.tid;
  const cycle = await qOne(
    'SELECT * FROM cycles WHERE user_id = $1 AND status = $2 AND $3::uuid = ANY(teaching_ids) ORDER BY created_at DESC LIMIT 1',
    [user.id, 'active', tid]
  );
  if (!cycle) return err(res, 404, '未找到包含该内容的进行中周期');
  await pool.query('UPDATE teachings SET scheduled_date = NULL WHERE id = $1', [tid]);
  await pool.query('DELETE FROM cycles WHERE id = $1', [cycle.id]);
  json(res, 200, { ok: true });
});

// ============ 打卡 ===========
route('POST', '/api/checkins', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const body = await parseJsonBody(req);
  const today = todayStr();
  const rec = {
    id: uid(), user_id: user.id, date: today,
    note: String(body.note || '').trim().slice(0, 500),
  };
  // 快照当天安排题目：优先当日 scheduled_date，其次进行中周期；失败不影响打卡
  try {
    const t = await qOne(
      `SELECT title FROM teachings WHERE scheduled_date = $1
       UNION ALL
       SELECT t2.title FROM cycles c JOIN teachings t2 ON t2.id = ANY(c.teaching_ids)
       WHERE c.status = 'active' AND c.start_date <= $1 AND (c.end_date IS NULL OR c.end_date >= $1)
       LIMIT 1`, [today]);
    if (t && t.title) rec.title = t.title;
  } catch (e) { console.log('[Checkin] 标题快照失败:', e.message); }
  await insertRow('checkins', rec);

  const count = await countTable('checkins WHERE user_id = $1 AND date = $2', [user.id, today]);
  json(res, 200, { checkin: rec, todayCount: count || 0 });
});

route('GET', '/api/checkins/today', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const today = todayStr();
  const allUsers = await q('SELECT * FROM users ORDER BY username ASC');
  const todayCheckins = await q('SELECT * FROM checkins WHERE date = $1 ORDER BY created_at ASC', [today]);

  const roster = (allUsers || []).map(u => {
    const mine = (todayCheckins || []).filter(c => c.user_id === u.id);
    return {
      user: publicUser(u),
      done: mine.length > 0,
      count: mine.length,
      lastNote: mine.length ? mine[mine.length - 1].note : null,
      lastAt: mine.length ? mine[mine.length - 1].created_at : null,
      lastTitle: mine.length ? mine[mine.length - 1].title : null,
    };
  });

  json(res, 200, { date: today, roster });
});

route('GET', '/api/checkins/mine', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const list = await q('SELECT * FROM checkins WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
  json(res, 200, { checkins: list || [] });
});

// ============ 善叙述 ============
route('GET', '/api/gooddeeds', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const list = await q('SELECT * FROM gooddeeds ORDER BY updated_at DESC');

  const result = await Promise.all((list || []).map(async (gd) => {
    await pruneGoodDeedVersions(gd);
    const author = await qOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [gd.user_id]);
    let teaching = null;
    if (gd.teaching_id) {
      const t = await qOne('SELECT id, title, type FROM teachings WHERE id = $1 LIMIT 1', [gd.teaching_id]);
      teaching = t;
    }
    const feedbackCount = await countTable('feedback WHERE target_type = $1 AND target_id = $2', ['gooddeed', gd.id]);

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

  const list = await q('SELECT * FROM gooddeeds WHERE user_id = $1 ORDER BY updated_at DESC', [user.id]);

  const settings = await qOne('SELECT gooddeed_max_updates FROM settings WHERE id = 1 LIMIT 1');
  const maxUpdates = settings?.gooddeed_max_updates || GOODDEED_MAX_UPDATES;

  const result = await Promise.all((list || []).map(async (gd) => {
    await pruneGoodDeedVersions(gd);
    let teaching = null;
    if (gd.teaching_id) {
      const t = await qOne('SELECT id, title, type FROM teachings WHERE id = $1 LIMIT 1', [gd.teaching_id]);
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
  const todayCheckin = await qOne('SELECT id FROM checkins WHERE user_id = $1 AND date = $2 ORDER BY created_at DESC LIMIT 1', [user.id, today]);

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
  const created = await insertRow('gooddeeds', rec);
  json(res, 200, { gooddeed: { id: created.id, attachments: created.attachments } });
});

route('PUT', '/api/gooddeeds/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const gd = await qOne('SELECT * FROM gooddeeds WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!gd) return err(res, 404, '善叙述不存在');
  if (gd.user_id !== user.id) return err(res, 403, '只能更新自己的善叙述');

  const body = await parseJsonBody(req);
  const content = String(body.content || '').trim();
  if (!content) return err(res, 400, '内容不能为空');

  // gooddeeds 表没有 content 列，内容保存在 versions（JSONB 数组）里；
  // 按用户要求只保留最新版本：编辑后 versions 只存当前这一版，不再累积历史版本
  const updates = {
    versions: [{ content, updated_at: nowIso() }],
    updated_at: nowIso(),
  };
  await updateRow('gooddeeds', updates, 'id', gd.id);
  json(res, 200, { gooddeed: { id: gd.id, versions: updates.versions, versionCount: updates.versions.length } });
});

route('GET', '/api/gooddeeds/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const gd = await qOne('SELECT * FROM gooddeeds WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!gd) return err(res, 404, '善叙述不存在');

  await pruneGoodDeedVersions(gd);
  const author = await qOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [gd.user_id]);
  const feedbackList = await q(
    'SELECT f.*, u.username AS author_username FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.target_type = $1 AND f.target_id = $2 ORDER BY f.created_at DESC',
    ['gooddeed', gd.id]
  );

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
      author: f.author_username || '(已移除)', authorId: f.user_id || null
    }))
  });
});

// 善叙述附件：追加
route('POST', '/api/gooddeeds/:id/attachments', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const gd = await qOne('SELECT * FROM gooddeeds WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!gd) return err(res, 404, '善叙述不存在');
  if (gd.user_id !== user.id) return err(res, 403, '只能给自己的善叙述添加附件');

  const body = await parseJsonBody(req);
  if (!body.name || !body.data) return err(res, 400, '缺少文件');

  const r = saveAttachment(Buffer.from(String(body.data), 'base64'), body.name);
  if (r.error) return err(res, 400, r.error);

  const attachments = [...(gd.attachments || []), r.att];
  await updateRow('gooddeeds', { attachments }, 'id', gd.id);
  json(res, 200, { attachments });
});

// 善叙述附件：删除
route('DELETE', '/api/gooddeeds/:id/attachments/:attId', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const gd = await qOne('SELECT * FROM gooddeeds WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!gd) return err(res, 404, '善叙述不存在');
  if (gd.user_id !== user.id) return err(res, 403, '只能删除自己善叙述的附件');

  const att = (gd.attachments || []).find(a => a.id === req.params.attId);
  if (!att) return err(res, 404, '附件不存在');

  const attachments = (gd.attachments || []).filter(a => a.id !== req.params.attId);
  await updateRow('gooddeeds', { attachments }, 'id', gd.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, att.fileName)); } catch (e) {}
  json(res, 200, { ok: true });
});

// 删除整条善叙述
route('DELETE', '/api/gooddeeds/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const gd = await qOne('SELECT * FROM gooddeeds WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!gd) return err(res, 404, '善叙述不存在');
  if (gd.user_id !== user.id && user.role !== 'admin') return err(res, 403, '只能删除自己的善叙述');

  (gd.attachments || []).forEach(a => { try { fs.unlinkSync(path.join(UPLOAD_DIR, a.fileName)); } catch (e) {} });
  await pool.query('DELETE FROM feedback WHERE target_type = $1 AND target_id = $2', ['gooddeed', gd.id]);
  await pool.query('DELETE FROM gooddeeds WHERE id = $1', [gd.id]);
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
  const created = await insertRow('feedback', rec);
  json(res, 200, { feedback: created });
});

route('GET', '/api/feedback', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const type = req.query.get('targetType') || '';
  const targetId = req.query.get('targetId') || '';

  let sql = 'SELECT f.*, u.username AS author_username FROM feedback f LEFT JOIN users u ON u.id = f.user_id';
  const conds = [];
  const params = [];
  if (type) { params.push(type); conds.push(`f.target_type = $${params.length}`); }
  if (targetId) { params.push(targetId); conds.push(`f.target_id = $${params.length}`); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY f.created_at DESC';

  const list = await q(sql, params);
  json(res, 200, {
    feedback: (list || []).map(f => ({
      id: f.id, targetType: f.target_type, targetId: f.target_id,
      content: f.content, createdAt: f.created_at,
      author: f.author_username || '(已移除)', authorId: f.user_id || null
    }))
  });
});

route('PUT', '/api/feedback/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const f = await qOne('SELECT * FROM feedback WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!f) return err(res, 404, '反馈不存在');
  if (f.user_id !== user.id) return err(res, 403, '只能编辑自己的反馈');

  const body = await parseJsonBody(req);
  const content = String(body.content || '').trim();
  if (!content) return err(res, 400, '内容不能为空');

  await updateRow('feedback', { content, updated_at: nowIso() }, 'id', f.id);
  json(res, 200, { feedback: { ...f, content } });
});

route('DELETE', '/api/feedback/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');

  const f = await qOne('SELECT * FROM feedback WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!f) return err(res, 404, '反馈不存在');
  if (f.user_id !== user.id && user.role !== 'admin') return err(res, 403, '只能删除自己的反馈');

  await pool.query('DELETE FROM feedback WHERE id = $1', [f.id]);
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
        const xmlPath = path.join(expandDir, 'word', 'document.xml');
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
  const allUsers = await q('SELECT * FROM users ORDER BY username ASC');
  const todayCheckins = await q('SELECT user_id FROM checkins WHERE date = $1', [today]);
  const checkedInUserIds = new Set((todayCheckins || []).map(c => c.user_id));
  const settings = await qOne('SELECT member_limit FROM settings WHERE id = 1 LIMIT 1');

  json(res, 200, {
    memberLimit: settings?.member_limit || MEMBER_LIMIT_DEFAULT,
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

  const target = await qOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!target) return err(res, 404, '用户不存在');

  const body = await parseJsonBody(req);
  const role = body.role === 'admin' ? 'admin' : 'member';

  if (role !== 'admin' && target.role === 'admin') {
    const count = await countTable('users WHERE role = $1', ['admin']);
    if (count <= 1) return err(res, 400, '至少保留一名管理员');
  }

  await updateRow('users', { role }, 'id', target.id);
  json(res, 200, { user: publicUser({ ...target, role }) });
});

route('DELETE', '/api/admin/users/:id', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');
  if (req.params.id === user.id) return err(res, 400, '不能移除自己');

  const target = await qOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!target) return err(res, 404, '用户不存在');

  if (target.role === 'admin') {
    const count = await countTable('users WHERE role = $1', ['admin']);
    if (count <= 1) return err(res, 400, '至少保留一名管理员');
  }

  await pool.query('DELETE FROM checkins WHERE user_id = $1', [target.id]);
  await pool.query('DELETE FROM gooddeeds WHERE user_id = $1', [target.id]);
  await pool.query('DELETE FROM cycles WHERE user_id = $1', [target.id]);
  await pool.query('DELETE FROM feedback WHERE user_id = $1', [target.id]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
  await pool.query('DELETE FROM users WHERE id = $1', [target.id]);

  json(res, 200, { ok: true });
});

route('PUT', '/api/admin/settings', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const body = await parseJsonBody(req);
  const limit = parseInt(body.memberLimit, 10);
  if (!(limit >= 1 && limit <= 500)) return err(res, 400, '人数上限需为 1-500');

  await updateRow('settings', { member_limit: limit }, 'id', 1);
  const settings = await qOne('SELECT * FROM settings WHERE id = 1 LIMIT 1');
  json(res, 200, { settings });
});


// 管理：全部善叙述（管理员）
route('GET', '/api/admin/gooddeeds', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');
  if (user.role !== 'admin') return err(res, 403, '仅管理员可查看');

  const list = await q('SELECT * FROM gooddeeds ORDER BY updated_at DESC');
  const result = await Promise.all((list || []).map(async (gd) => {
    await pruneGoodDeedVersions(gd);
    const author = await qOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [gd.user_id]);
    const feedbackCount = await countTable('feedback WHERE target_type = $1 AND target_id = $2', ['gooddeed', gd.id]);
    return {
      id: gd.id,
      author: author ? publicUser(author) : { id: gd.user_id, username: '(已移除)', role: 'member' },
      title: gd.title || '',
      content: gd.versions.length ? gd.versions[gd.versions.length - 1].content : '',
      teachingId: gd.teaching_id || null,
      versionCount: gd.versions.length,
      updatedAt: gd.updated_at, createdAt: gd.created_at,
      feedbackCount: feedbackCount || 0,
    };
  }));
  json(res, 200, { gooddeeds: result });
});

// 管理：全部反馈（管理员）
route('GET', '/api/admin/feedback', async (req, res) => {
  const user = await authUser(req);
  if (!user) return err(res, 401, '未登录');
  if (user.role !== 'admin') return err(res, 403, '仅管理员可查看');

  const list = await q(
    `SELECT f.*, u.username AS author_username,
       t.title AS target_title, t.type AS target_type_label,
       gd.title AS gooddeed_title
     FROM feedback f
     LEFT JOIN users u ON u.id = f.user_id
     LEFT JOIN teachings t ON t.id = f.target_id AND f.target_type = 'teaching'
     LEFT JOIN gooddeeds gd ON gd.id = f.target_id AND f.target_type = 'gooddeed'
     ORDER BY f.created_at DESC`
  );
  json(res, 200, {
    feedback: (list || []).map(f => ({
      id: f.id, targetType: f.target_type, targetId: f.target_id,
      targetTitle: f.gooddeed_title || f.target_title || null,
      targetTypeLabel: f.target_type_label || f.target_type || null,
      content: f.content, createdAt: f.created_at,
      author: f.author_username || '(已移除)', authorId: f.user_id || null
    }))
  });
});

route('GET', '/api/admin/checkins', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  const list = await q('SELECT c.*, u.username AS author_username FROM checkins c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.created_at DESC');
  json(res, 200, {
    checkins: (list || []).map(c => ({ ...c, username: c.author_username || '(已移除)' }))
  });
});

route('DELETE', '/api/admin/checkins/:id', async (req, res) => {
  const user = await authUser(req);
  if (!isAdmin(user)) return err(res, 403, '需要管理员权限');

  await pool.query('DELETE FROM checkins WHERE id = $1', [req.params.id]);
  json(res, 200, { ok: true });
});

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

// 查找静态文件：优先根目录，其次 public/ 子目录
function findStatic(name) {
  const rootFile = path.join(__dirname, name);
  if (fs.existsSync(rootFile) && fs.statSync(rootFile).isFile()) return rootFile;
  const pubFile = path.join(__dirname, 'public', name);
  if (fs.existsSync(pubFile) && fs.statSync(pubFile).isFile()) return pubFile;
  return null;
}

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
      if (pathname === '/' || pathname === '/index.html') return serveFile(res, findStatic('index.html'));
      if (pathname.startsWith('/static/')) {
        const p = findStatic(pathname.slice('/static/'.length));
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
    console.error('[Server] 错误:', e.message);
    json(res, status, { error: e.message || '服务器错误' });
  }
});

// ---------------- 首次启动种子数据 ----------------
async function seed() {
  try {
    // 迁移：打卡记录增加 title 列（打卡时快照当天安排题目，安排被覆盖后历史标题仍可显示）
    try { await pool.query('ALTER TABLE checkins ADD COLUMN IF NOT EXISTS title TEXT'); }
    catch (e) { console.log('[Seed] checkins.title 迁移:', e.message); }

    // 迁移：善叙述只保留最新版本（把历史多版本收拢为最后一条）
    try {
      await pool.query(
        `UPDATE gooddeeds SET versions = jsonb_build_array(versions[array_length(versions, 1)])
         WHERE jsonb_array_length(versions) > 1`
      );
    } catch (e) { console.log('[Seed] gooddeeds 版本收拢:', e.message); }

    const userCount = await countTable('users');
    if (userCount === 0) {
      const salt = crypto.randomBytes(12).toString('hex');
      await insertRow('users', {
        id: uid(), username: 'admin', salt,
        password_hash: hashPassword('admin123', salt), role: 'admin', telegram_id: null,
      });
      console.log('[Seed] 已创建管理员账号: admin / admin123');
    }

    const teachingCount = await countTable('teachings');
    if (teachingCount === 0) {
      await pool.query(
        'INSERT INTO teachings (id, type, title, content, source) VALUES ($1,$2,$3,$4,$5), ($6,$7,$8,$9,$10)',
        [uid(), '偈语', '七佛通诫偈', '诸恶莫作，众善奉行；自净其意，是诸佛教。', '《增一阿含经》',
         uid(), '开示', '心念如镜', '心念如镜，尘来尘去，镜体不动；观照而不随转，即是修行。', '示例开示（可删除）']
      );
      console.log('[Seed] 已插入示例偈语');
    }
  } catch (e) {
    console.error('[Seed] 初始化失败:', e.message);
  }
}

seed().then(() => {
  server.listen(PORT, async () => {
    console.log('==========================================');
    console.log('  偈语背诵打卡 · PostgreSQL 直连版已启动');
    console.log(`  地址: http://localhost:${PORT}`);
    console.log(`  管理员: admin / admin123（首次启动自动创建）`);
    console.log('==========================================');
    try {
      await pool.query('SELECT 1');
      console.log('[DB] 数据库连接正常');
    } catch (e) {
      console.error('[DB] 数据库连接失败:', e.message);
    }
  });
});


// ---------------- Telegram 待打卡提醒（默认每天 20:00，可用环境变量 REMIND_HOUR / REMIND_MINUTE 调整） ----------------
async function tgSend(chatId, text) {
  if (!BOT_TOKEN) { console.log('[提醒] BOT_TOKEN 未配置，跳过推送'); return; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const j = await r.json();
    if (!j.ok) console.log('[提醒] 发送失败:', j.description || '未知错误');
  } catch (e) { console.log('[提醒] 发送异常:', e.message); }
}

const REMIND_HOUR = Number(process.env.REMIND_HOUR || 20);
const REMIND_MINUTE = Number(process.env.REMIND_MINUTE || 0);
let lastRemindDate = '';
setInterval(async () => {
  try {
    // 提醒时刻按蒙特利尔本地时间判断（服务器时钟是 UTC，不能直接用 getHours）
    const nowParts = new Intl.DateTimeFormat('en-US', {
      timeZone: BIZ_TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
    }).formatToParts(new Date());
    const nowHour = Number(nowParts.find(p => p.type === 'hour').value);
    const nowMinute = Number(nowParts.find(p => p.type === 'minute').value);
    if (nowHour !== REMIND_HOUR || nowMinute !== REMIND_MINUTE) return;
    const today = todayStr();
    if (lastRemindDate === today) return;
    lastRemindDate = today;
    const doneRows = await q('SELECT DISTINCT user_id FROM checkins WHERE date = $1', [today]);
    const doneSet = new Set((doneRows || []).map(r => r.user_id));
    const allUsers = await q('SELECT * FROM users WHERE telegram_id IS NOT NULL');
    let sent = 0;
    for (const u of allUsers || []) {
      if (doneSet.has(u.id)) continue;
      await tgSend(u.telegram_id, '温馨提醒，今日待打卡！');
      sent++;
    }
    console.log(`[提醒] ${today} ${REMIND_HOUR}:${REMIND_MINUTE} 已提醒 ${sent} 人`);
  } catch (e) { console.log('[提醒] 运行错误:', e.message); }
}, 60000);
