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

// Плейсхолдеры ? в стиле SQLite переводятся в $N для pg.
function toPg(query) {
  let idx = 0;
  return query.replace(/\?/g, () => `$${++idx}`);
}

// Те же методы поверх любого исполнителя запросов: пула или клиента транзакции.
function helpers(executor) {
  return {
    getAsync: async (query, params) => (await executor.query(toPg(query), params)).rows[0] || null,
    allAsync: async (query, params) => (await executor.query(toPg(query), params)).rows,
    runAsync: async (query, params) => {
      const result = await executor.query(toPg(query), params);
      return { lastID: result.rows[0]?.id, changes: result.rowCount };
    }
  };
}

// Несколько запросов одной транзакцией: при ошибке всё откатывается.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(helpers(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  init,
  close: () => pool.end(),
  ...helpers(pool),
  transaction
};
