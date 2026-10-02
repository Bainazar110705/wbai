module.exports = {
  id: '003_wb_analytics_cache',
  async up(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_analytics_source_cache (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source VARCHAR(20) NOT NULL,
        date_from DATE NOT NULL,
        date_to DATE NOT NULL,
        payload JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, source, date_from, date_to)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS wb_analytics_source_cache_lookup_idx
      ON wb_analytics_source_cache (user_id, source, fetched_at DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_analytics_snapshots (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date_from DATE NOT NULL,
        date_to DATE NOT NULL,
        payload JSONB NOT NULL,
        orders_fetched_at TIMESTAMPTZ,
        finance_fetched_at TIMESTAMPTZ,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, date_from, date_to)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS wb_analytics_snapshots_user_date_idx
      ON wb_analytics_snapshots (user_id, calculated_at DESC)
    `);
  }
};
