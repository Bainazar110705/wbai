module.exports = {
  id: '002_manager_campaigns',
  async up(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS manager_campaigns (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        manager_name VARCHAR(80) NOT NULL,
        campaign_id BIGINT NOT NULL,
        campaign_name VARCHAR(200) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, campaign_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS manager_campaigns_user_manager_idx ON manager_campaigns (user_id, manager_name)');
  }
};
