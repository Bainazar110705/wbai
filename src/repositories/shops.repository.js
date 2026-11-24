// Таблицы с данными магазина: при смене кабинета очищаются целиком.
const SHOP_DATA_TABLES = [
  'product_costs', 'manager_campaigns', 'wb_analytics_source_cache', 'wb_analytics_snapshots',
  'wb_orders', 'wb_sales', 'wb_ad_spend_daily', 'wb_rnp_sync', 'rnp_plans', 'wb_products',
  'rnp_labels', 'wb_finance_rows', 'wb_storage_daily', 'stock_change_batches'
];
const SHOP_COLUMNS = 'id, user_id, name, seller_id, token, tax_rate, created_at';

function createShopsRepository(db) {
  return {
    listByUser: userId => db.allAsync(`SELECT ${SHOP_COLUMNS} FROM wb_shops WHERE user_id=? ORDER BY id`, [userId]),
    findForUser: (userId, shopId) => db.getAsync(`SELECT ${SHOP_COLUMNS} FROM wb_shops WHERE user_id=? AND id=?`, [userId, shopId]),
    firstForUser: userId => db.getAsync(`SELECT ${SHOP_COLUMNS} FROM wb_shops WHERE user_id=? ORDER BY id LIMIT 1`, [userId]),
    countForUser: async userId => Number((await db.getAsync('SELECT COUNT(*)::int AS n FROM wb_shops WHERE user_id=?', [userId]))?.n) || 0,
    findBySeller: (userId, sellerId) => db.getAsync(`SELECT ${SHOP_COLUMNS} FROM wb_shops WHERE user_id=? AND seller_id=?`, [userId, sellerId]),

    create: ({ userId, name, sellerId, token, fingerprint }) => db.getAsync(
      `INSERT INTO wb_shops (user_id, name, seller_id, token, token_fingerprint) VALUES (?, ?, ?, ?, ?)
       RETURNING ${SHOP_COLUMNS}`,
      [userId, name, sellerId || null, token, fingerprint]
    ),

    update: async (shopId, fields) => {
      const allowed = ['name', 'seller_id', 'token', 'token_fingerprint'];
      const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
      if (!entries.length) return;
      await db.runAsync(
        `UPDATE wb_shops SET ${entries.map(([key]) => `${key}=?`).join(', ')} WHERE id=?`,
        [...entries.map(([, value]) => value), shopId]
      );
    },

    // Удаление магазина каскадом стирает все его данные.
    remove: shopId => db.runAsync('DELETE FROM wb_shops WHERE id=?', [shopId]),

    // Новый кабинет на месте старого: всё старое стираем, магазин остаётся.
    purgeData: async shopId => {
      for (const table of SHOP_DATA_TABLES) await db.runAsync(`DELETE FROM ${table} WHERE shop_id=?`, [shopId]);
    },

    // Товары магазина — чтобы узнать тот же кабинет, если WB не дал номер продавца.
    storedNmIds: async shopId => (await db.allAsync(
      `SELECT nm_id FROM wb_products WHERE shop_id=?
       UNION SELECT DISTINCT nm_id FROM wb_orders WHERE shop_id=?
       LIMIT 5000`,
      [shopId, shopId]
    )).map(row => Number(row.nm_id))
  };
}

module.exports = { createShopsRepository, SHOP_DATA_TABLES };
