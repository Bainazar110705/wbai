const { Pool } = require('pg');

const isLocal = !process.env.DATABASE_URL || /localhost|127\.0\.0\.1|::1|postgres/.test(process.env.DATABASE_URL || '') || /sslmode=disable/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wb_api_token TEXT DEFAULT NULL`);
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
