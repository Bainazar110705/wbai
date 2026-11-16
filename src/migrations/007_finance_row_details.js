// Прибыль по товарам: у строки финотчёта храним nmId и тип удержания
// (оплата «WB Продвижение» или другое), а для хранения — расход по товару
// из отчёта WB «Платное хранение».
module.exports = {
  id: '007_finance_row_details',
  async up(pool) {
    await pool.query('ALTER TABLE wb_finance_rows ADD COLUMN IF NOT EXISTS nm_id BIGINT');
    await pool.query('ALTER TABLE wb_finance_rows ADD COLUMN IF NOT EXISTS deduction_kind VARCHAR(20)');
    // Старые строки без этих полей: следующая загрузка заберёт финотчёт заново.
    await pool.query('UPDATE wb_rnp_sync SET finance_from = NULL, finance_to = NULL');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wb_storage_daily (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        nm_id BIGINT NOT NULL,
        cost NUMERIC(14,4) NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, nm_id)
      )
    `);
    await pool.query('ALTER TABLE wb_rnp_sync ADD COLUMN IF NOT EXISTS storage_from DATE');
    await pool.query('ALTER TABLE wb_rnp_sync ADD COLUMN IF NOT EXISTS storage_synced_to DATE');
    await pool.query('ALTER TABLE wb_rnp_sync ADD COLUMN IF NOT EXISTS storage_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE wb_rnp_sync ADD COLUMN IF NOT EXISTS storage_error TEXT');
  }
};
