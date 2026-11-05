// РНП («Рука на пульсе»): заказы, выкупы и реклама кабинета хранятся у нас
// и дополняются только изменениями, чтобы не упираться в лимиты WB.
module.exports = {
  id: '004_wb_rnp',
  async up(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_orders (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        srid VARCHAR(120) NOT NULL,
        order_date TIMESTAMP NOT NULL,
        last_change_date TIMESTAMP NOT NULL,
        nm_id BIGINT NOT NULL,
        supplier_article VARCHAR(255) NOT NULL DEFAULT '',
        brand VARCHAR(255) NOT NULL DEFAULT '',
        subject VARCHAR(255) NOT NULL DEFAULT '',
        price_with_disc NUMERIC(14,2) NOT NULL DEFAULT 0,
        finished_price NUMERIC(14,2) NOT NULL DEFAULT 0,
        is_cancel BOOLEAN NOT NULL DEFAULT FALSE,
        region VARCHAR(255) NOT NULL DEFAULT '',
        warehouse VARCHAR(255) NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, srid)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS wb_orders_user_date_idx ON wb_orders (user_id, order_date)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_sales (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sale_id VARCHAR(120) NOT NULL,
        srid VARCHAR(120) NOT NULL DEFAULT '',
        sale_date TIMESTAMP NOT NULL,
        last_change_date TIMESTAMP NOT NULL,
        nm_id BIGINT NOT NULL,
        supplier_article VARCHAR(255) NOT NULL DEFAULT '',
        brand VARCHAR(255) NOT NULL DEFAULT '',
        subject VARCHAR(255) NOT NULL DEFAULT '',
        is_return BOOLEAN NOT NULL DEFAULT FALSE,
        price_with_disc NUMERIC(14,2) NOT NULL DEFAULT 0,
        for_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
        finished_price NUMERIC(14,2) NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, sale_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS wb_sales_user_date_idx ON wb_sales (user_id, sale_date)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_ad_spend_daily (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        advert_id BIGINT NOT NULL,
        nm_id BIGINT NOT NULL,
        spend NUMERIC(14,2) NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        clicks INTEGER NOT NULL DEFAULT 0,
        orders INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, advert_id, nm_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_rnp_sync (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        token_fingerprint VARCHAR(64),
        status VARCHAR(20) NOT NULL DEFAULT 'idle',
        progress JSONB NOT NULL DEFAULT '{}'::jsonb,
        orders_cursor VARCHAR(40),
        sales_cursor VARCHAR(40),
        ads_synced_to DATE,
        ads_currency VARCHAR(3),
        ads_error TEXT,
        unit_costs JSONB,
        unit_costs_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        last_error TEXT,
        last_viewed_at TIMESTAMPTZ
      )
    `);
  }
};
