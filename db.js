const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') 
    ? { rejectUnauthorized: false }
    : (process.env.DATABASE_URL ? { rejectUnauthorized: false } : false)
});

// Создаём таблицы если не существуют
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255) DEFAULT '',
      subscription_end TIMESTAMP,
      is_active INTEGER DEFAULT 0,
      ai_requests_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Добавляем колонку если её нет (для существующих баз)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_requests_count INTEGER DEFAULT 0`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT,
      response TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS infographic_styles (
      id SERIAL PRIMARY KEY,
      name TEXT,
      image_base64 TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS templates (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) DEFAULT '',
      chars TEXT DEFAULT '',
      length VARCHAR(50) DEFAULT '',
      width VARCHAR(50) DEFAULT '',
      height VARCHAR(50) DEFAULT '',
      weight VARCHAR(50) DEFAULT '',
      price VARCHAR(50) DEFAULT '',
      kw TEXT DEFAULT '',
      date VARCHAR(50) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Новые поля для планов и кредитов
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'start'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_credits INTEGER DEFAULT 0`);
  // Таблица транзакций кредитов
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Campaign statistics (imported from WB via extension)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_stats (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      campaign_name VARCHAR(500) DEFAULT '',
      source_url TEXT DEFAULT '',
      date VARCHAR(20) NOT NULL,
      shows NUMERIC DEFAULT 0,
      cpm NUMERIC DEFAULT 0,
      clicks NUMERIC DEFAULT 0,
      ctr NUMERIC DEFAULT 0,
      cpc NUMERIC DEFAULT 0,
      spend NUMERIC DEFAULT 0,
      baskets NUMERIC DEFAULT 0,
      cpl NUMERIC DEFAULT 0,
      orders NUMERIC DEFAULT 0,
      cpo NUMERIC DEFAULT 0,
      revenue NUMERIC DEFAULT 0,
      drr NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, campaign_name, date)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comp_groups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      keyword VARCHAR(500) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comp_articles (
      id SERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES comp_groups(id) ON DELETE CASCADE,
      article VARCHAR(50) NOT NULL,
      product_name VARCHAR(500) DEFAULT '',
      is_own BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comp_positions (
      id SERIAL PRIMARY KEY,
      article_id INTEGER REFERENCES comp_articles(id) ON DELETE CASCADE,
      position INTEGER,
      checked_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keyword_trackers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      article VARCHAR(50) NOT NULL,
      product_name VARCHAR(500) DEFAULT '',
      keyword VARCHAR(500) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keyword_positions (
      id SERIAL PRIMARY KEY,
      tracker_id INTEGER REFERENCES keyword_trackers(id) ON DELETE CASCADE,
      position INTEGER,
      total INTEGER DEFAULT 0,
      checked_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('[WBai] Database ready');
}

init().catch(console.error);

module.exports = {
  getAsync: async (query, params) => {
    let idx = 0;
    const pgQuery = query.replace(/\?/g, () => `$${++idx}`);
    const result = await pool.query(pgQuery, params);
    return result.rows[0] || null;
  },
  allAsync: async (query, params) => {
    let idx = 0;
    const pgQuery = query.replace(/\?/g, () => `$${++idx}`);
    const result = await pool.query(pgQuery, params);
    return result.rows;
  },
  runAsync: async (query, params) => {
    let idx = 0;
    const pgQuery = query.replace(/\?/g, () => `$${++idx}`);
    const result = await pool.query(pgQuery, params);
    return { lastID: result.rows[0]?.id, changes: result.rowCount };
  }
};
