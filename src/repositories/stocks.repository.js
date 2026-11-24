// История изменений остатков (пачка сохранения + позиции «было → стало»).
const HISTORY_LIMIT = 30;

function createStocksRepository(db) {
  return {
    async createBatch({ shopId, userId, warehouseId, warehouseName, source, savedCount, failedCount, undoOf = null, items }) {
      return db.transaction(async tx => {
        const batch = await tx.getAsync(
          `INSERT INTO stock_change_batches (shop_id, user_id, warehouse_id, warehouse_name, source, saved_count, failed_count, undo_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
          [shopId, userId || null, warehouseId, warehouseName || '', source, savedCount, failedCount, undoOf]
        );
        for (const item of items) {
          await tx.runAsync(
            `INSERT INTO stock_change_items (batch_id, chrt_id, sku, nm_id, vendor_code, size, amount_before, amount_after)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (batch_id, chrt_id) DO NOTHING`,
            [batch.id, item.chrtId, item.sku || '', item.nmId || null, item.vendorCode || '', item.size || '', item.before, item.after]
          );
        }
        if (undoOf) await tx.runAsync('UPDATE stock_change_batches SET undone_at = NOW() WHERE id = ? AND shop_id = ?', [undoOf, shopId]);
        return batch;
      });
    },

    listBatches: (shopId, limit = HISTORY_LIMIT) => db.allAsync(
      `SELECT id, warehouse_id, warehouse_name, source, saved_count, failed_count, undo_of, undone_at, created_at
       FROM stock_change_batches WHERE shop_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      [shopId, limit]
    ),

    findBatch: (shopId, batchId) => db.getAsync(
      `SELECT id, warehouse_id, warehouse_name, source, saved_count, failed_count, undo_of, undone_at, created_at
       FROM stock_change_batches WHERE shop_id = ? AND id = ?`,
      [shopId, batchId]
    ),

    // Последнее сохранение по складу — отменять можно только его.
    latestBatchId: async (shopId, warehouseId) => Number((await db.getAsync(
      'SELECT id FROM stock_change_batches WHERE shop_id = ? AND warehouse_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [shopId, warehouseId]
    ))?.id) || null,

    // Остаток на складах WB по товару (из последней загрузки РНП) — для справки.
    wbStocks: async shopId => new Map((await db.allAsync(
      'SELECT nm_id, stock_wb FROM wb_products WHERE shop_id = ?',
      [shopId]
    )).map(row => [Number(row.nm_id), Number(row.stock_wb) || 0])),

    batchItems: batchId => db.allAsync(
      `SELECT chrt_id, sku, nm_id, vendor_code, size, amount_before, amount_after
       FROM stock_change_items WHERE batch_id = ? ORDER BY vendor_code, size`,
      [batchId]
    )
  };
}

module.exports = { createStocksRepository };
