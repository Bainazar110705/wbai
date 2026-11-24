// Запросы админки: пользователи, их магазины и состояние загрузки данных WB.
// Полный токен WB из базы наружу не отдаётся — только последние символы.
function createAdminRepository(db) {
  return {
    listUsers: () => db.allAsync(
      `SELECT u.id, u.email, u.name, u.subscription_end, u.created_at, u.plan, u.legacy_terms_until,
              (SELECT COALESCE(SUM(b.remaining), 0)::int FROM photo_credit_batches b
               WHERE b.user_id = u.id AND b.remaining > 0 AND (b.expires_at IS NULL OR b.expires_at > NOW())) AS photo_credits,
              (SELECT COUNT(*)::int FROM wb_shops s WHERE s.user_id = u.id) AS shops_count
       FROM users u ORDER BY u.id DESC`,
      []
    ),

    findUser: id => db.getAsync(
      `SELECT id, email, name, subscription_end, created_at, plan, legacy_terms_until
       FROM users WHERE id = ?`,
      [id]
    ),

    listShops: userId => db.allAsync(
      `SELECT s.id, s.name, s.seller_id, RIGHT(s.token, 6) AS token_tail, s.tax_rate, s.created_at,
              y.status AS sync_status, y.progress AS sync_progress, y.last_success_at, y.last_error,
              y.finished_at, y.last_viewed_at,
              (SELECT COUNT(*)::int FROM wb_products p WHERE p.shop_id = s.id) AS products_count,
              (SELECT COUNT(*)::int FROM wb_orders o WHERE o.shop_id = s.id
                 AND o.order_date >= NOW() - INTERVAL '30 days') AS orders_30d
       FROM wb_shops s
       LEFT JOIN wb_rnp_sync y ON y.shop_id = s.id
       WHERE s.user_id = ?
       ORDER BY s.id`,
      [userId]
    ),

    findShop: (userId, shopId) => db.getAsync('SELECT id FROM wb_shops WHERE user_id = ? AND id = ?', [userId, shopId]),

    creditHistory: userId => db.allAsync(
      'SELECT id, amount, note, created_at FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30',
      [userId]
    )
  };
}

module.exports = { createAdminRepository };
