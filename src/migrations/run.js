const migrations = [require('./001_initial')];
const logger = require('../platform/logger');

async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  for (const migration of migrations) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
    if (applied.rowCount) continue;
    logger.info('migration_started', { migrationId: migration.id });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await migration.up(client);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      await client.query('COMMIT');
      logger.info('migration_completed', { migrationId: migration.id });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { runMigrations };
