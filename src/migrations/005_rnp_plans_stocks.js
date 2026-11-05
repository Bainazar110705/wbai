// РНП, этап 2: план продаж на месяц, карточки товаров с остатками и ярлыки.
module.exports = {
  id: '005_rnp_plans_stocks',
  async up(pool) {
    // nm_id = 0 — план всего магазина.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rnp_plans (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        month CHAR(7) NOT NULL,
        nm_id BIGINT NOT NULL,
        orders_sum NUMERIC(14,2),
        orders_count INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, month, nm_id)
      )
    `);
    // Снимок товаров из воронки продаж WB: название и текущие остатки.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_products (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nm_id BIGINT NOT NULL,
        title VARCHAR(500) NOT NULL DEFAULT '',
        vendor_code VARCHAR(255) NOT NULL DEFAULT '',
        brand VARCHAR(255) NOT NULL DEFAULT '',
        subject VARCHAR(255) NOT NULL DEFAULT '',
        stock_wb INTEGER NOT NULL DEFAULT 0,
        stock_mp INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, nm_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rnp_labels (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nm_id BIGINT NOT NULL,
        labels TEXT[] NOT NULL DEFAULT '{}',
        PRIMARY KEY (user_id, nm_id)
      )
    `);
    await pool.query('ALTER TABLE wb_rnp_sync ADD COLUMN IF NOT EXISTS stocks_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE wb_rnp_sync ADD COLUMN IF NOT EXISTS stocks_error TEXT');
  }
};
