const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { Pool } = require('pg');

// ============ 数据库配置 ============
const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============ 工具函数 ============
function hashPassword(pwd, salt) {
  return crypto.createHash('sha256').update(pwd + '::' + salt).digest('hex');
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, telegram_id: u.telegram_id, created_at: u.created_at };
}

// ============ 认证路由 ============
async function handleLogin(req, res, body) {
  const username = String(body.username || '').trim();
  if (!username || username.length > 30) return sendJson(res, 400, { error: '用户名需为 1-30 个字符' });
  
  console.log('[Login] 尝试登录:', username);
  
  try {
    // 查询用户
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    console.log('[Login] 查询用户结果:', result.rows.length ? '找到' : '未找到');
    
    if (result.rows.length === 0) {
      return sendJson(res, 404, { error: '用户不存在: ' + username });
    }
    
    const user = result.rows[0];
    
    // 验证密码
    if (user.password_hash) {
      const hash = hashPassword(String(body.password || ''), user.salt);
      console.log('[Login] 密码验证:', hash === user.password_hash ? '通过' : '失败');
      if (hash !== user.password_hash) return sendJson(res, 401, { error: '密码错误' });
    }
    
    // 创建 session
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
    console.log('[Login] 创建session: 成功');
    
    sendJson(res, 200, { token: token, user: publicUser(user) });
  } catch (e) {
    console.error('[Login] 错误:', e.message);
    sendJson(res, 500, { error: e.message });
  }
}

async function handleTelegramLogin(req, res, body) {
  const initData = body.initData;
  if (!initData) return sendJson(res, 400, { error: '缺少 initData' });
  
  // 简单解析 Telegram initData
  const params = new URLSearchParams(initData);
  const telegramId = params.get('id');
  const username = params.get('username');
  const firstName = params.get('first_name');
  
  if (!telegramId) return sendJson(res, 400, { error: '无法识别 Telegram 用户' });
  
  try {
    // 查询是否已有该 Telegram 用户
    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    let user;
    
    if (result.rows.length > 0) {
      user = result.rows[0];
    } else {
      // 新用户，自动创建
      const salt = crypto.randomBytes(8).toString('hex');
      const insertResult = await pool.query(
        'INSERT INTO users (username, display_name, telegram_id, salt, role) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [username || 'tg_' + telegramId, firstName || username || 'Telegram 用户', telegramId, salt, 'user']
      );
      user = insertResult.rows[0];
    }
    
    // 创建 session
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
    
    sendJson(res, 200, { token: token, user: publicUser(user) });
  } catch (e) {
    console.error('[Telegram Login] 错误:', e.message);
    sendJson(res, 500, { error: e.message });
  }
}

// ============ 辅助函数 ============
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
  };
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('文件不存在');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ============ 服务器 ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${process.env.PORT || 10000}`);
  const pathname = url.pathname;
  
  // 静态文件
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(__dirname, 'index.html'));
    }
    if (pathname === '/app.js') {
      return serveStatic(res, path.join(__dirname, 'app.js'));
    }
    if (pathname === '/style.css') {
      return serveStatic(res, path.join(__dirname, 'style.css'));
    }
  }
  
  // API 路由
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        handleLogin(req, res, parsed);
      } catch (e) {
        sendJson(res, 400, { error: '无效的请求' });
      }
    });
    return;
  }
  
  if (pathname === '/api/auth/telegram' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        handleTelegramLogin(req, res, parsed);
      } catch (e) {
        sendJson(res, 400, { error: '无效的请求' });
      }
    });
    return;
  }
  
  if (pathname === '/api/me') {
    sendJson(res, 200, { error: '未登录' });
    return;
  }
  
  sendJson(res, 404, { error: 'Not Found' });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, async () => {
  console.log('==========================================');
  console.log('  打卡小程序已启动');
  console.log('  地址: http://localhost:' + PORT + '/');
  
  // 测试数据库连接
  try {
    await pool.query('SELECT 1');
    console.log('  数据库连接成功');
  } catch (e) {
    console.log('  数据库连接失败:', e.message);
  }
  
  console.log('==========================================');
});
