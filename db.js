const { Pool } = require('pg');
const { runMigrations } = require('./src/migrations/run');
const logger = require('./src/platform/logger');

const isLocal = !process.env.DATABASE_URL || /localhost|127\.0\.0\.1|::1|postgres/.test(process.env.DATABASE_URL || '') || /sslmode=disable/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

let initialized;

// Совместимый фасад БД: стартовая инициализация теперь использует версионированные миграции.
async function init() {
  if (initialized) return initialized;
  initialized = runMigrations(pool);
  await initialized;
  logger.info('database_ready');
}

module.exports = {
  init,
  close: () => pool.end(),
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
