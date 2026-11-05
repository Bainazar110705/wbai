// Хранение источников WB у нас: время загрузки каждого источника для подсказки
// «Обновлено», строки финотчёта для Аналитики и РНП, сумма заказов с рекламы.
module.exports = {
  id: '006_wb_stored_sources',
  async up(pool) {
    for (const column of [
      'orders_at TIMESTAMPTZ', 'sales_at TIMESTAMPTZ', 'ads_at TIMESTAMPTZ', 'ads_from DATE', 'costs_error TEXT',
      'finance_from DATE', 'finance_to DATE', 'finance_at TIMESTAMPTZ', 'finance_currency VARCHAR(3)', 'finance_error TEXT'
    ]) {
      await pool.query(`ALTER TABLE wb_rnp_sync ADD COLUMN IF NOT EXISTS ${column}`);
    }
    await pool.query('ALTER TABLE wb_ad_spend_daily ADD COLUMN IF NOT EXISTS order_sum NUMERIC(14,2) NOT NULL DEFAULT 0');
    // Без суммы заказов старые строки рекламы неполные: следующая загрузка заберёт рекламу целиком.
    await pool.query('UPDATE wb_rnp_sync SET ads_synced_to = NULL');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_finance_rows (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rrd_id BIGINT NOT NULL,
        rr_date DATE NOT NULL,
        currency VARCHAR(3) NOT NULL,
        vendor_code VARCHAR(255) NOT NULL DEFAULT '',
        quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
        operation VARCHAR(255) NOT NULL DEFAULT '',
        document_type VARCHAR(255) NOT NULL DEFAULT '',
        retail_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
        sales NUMERIC(16,2) NOT NULL DEFAULT 0,
        payable NUMERIC(16,2) NOT NULL DEFAULT 0,
        commission NUMERIC(16,2) NOT NULL DEFAULT 0,
        logistics NUMERIC(16,2) NOT NULL DEFAULT 0,
        storage NUMERIC(16,2) NOT NULL DEFAULT 0,
        penalty NUMERIC(16,2) NOT NULL DEFAULT 0,
        deduction NUMERIC(16,2) NOT NULL DEFAULT 0,
        acceptance NUMERIC(16,2) NOT NULL DEFAULT 0,
        additional_payment NUMERIC(16,2) NOT NULL DEFAULT 0,
        margin NUMERIC(16,2) NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, rrd_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS wb_finance_rows_user_date_idx ON wb_finance_rows (user_id, rr_date)');
  }
};
