'use strict';
// ============ 应用配置 ============
// 部署时通过环境变量注入 SUPABASE_URL 和 SUPABASE_SERVICE_KEY
module.exports = {
  PORT: process.env.PORT || 3000,

  // Supabase 连接信息（从环境变量读取，Render 部署时配置）
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',

  // Telegram Bot API Token（部署时通过环境变量注入）
  BOT_TOKEN: process.env.BOT_TOKEN || '',

  // 业务参数
  MEMBER_LIMIT_DEFAULT: 15,
  GOODDEED_MAX_UPDATES: 999,
  GOODDEED_RETENTION_DAYS: 30,
};
