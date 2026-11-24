// История изменений остатков на складах продавца: кто, когда, было → стало.
// Привязана к магазину: удаление магазина стирает и историю.
module.exports = {
  id: '011_stock_changes',
  async up(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_change_batches (
        id SERIAL PRIMARY KEY,
        shop_id INTEGER NOT NULL REFERENCES wb_shops(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        warehouse_id BIGINT NOT NULL,
        warehouse_name VARCHAR(255) NOT NULL DEFAULT '',
        source VARCHAR(20) NOT NULL DEFAULT 'manual',
        saved_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        undo_of INTEGER REFERENCES stock_change_batches(id) ON DELETE SET NULL,
        undone_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS stock_change_batches_shop_idx ON stock_change_batches (shop_id, created_at DESC)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_change_items (
        batch_id INTEGER NOT NULL REFERENCES stock_change_batches(id) ON DELETE CASCADE,
        chrt_id BIGINT NOT NULL,
        sku VARCHAR(64) NOT NULL DEFAULT '',
        nm_id BIGINT,
        vendor_code VARCHAR(255) NOT NULL DEFAULT '',
        size VARCHAR(100) NOT NULL DEFAULT '',
        amount_before INTEGER NOT NULL,
        amount_after INTEGER NOT NULL,
        PRIMARY KEY (batch_id, chrt_id)
      )
    `);
  }
};
