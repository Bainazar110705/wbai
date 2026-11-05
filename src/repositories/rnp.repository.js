const BATCH_SIZE = 500;
const SYNC_FIELDS = new Set([
  'token_fingerprint', 'status', 'progress', 'orders_cursor', 'sales_cursor', 'ads_synced_to',
  'ads_currency', 'ads_error', 'unit_costs', 'unit_costs_at', 'started_at', 'finished_at',
  'last_success_at', 'last_error', 'last_viewed_at', 'stocks_at', 'stocks_error'
]);
const JSON_FIELDS = new Set(['progress', 'unit_costs']);

// Даты WB хранятся во времени МСК без пояса; отдаём их строкой, чтобы pg
// не переводил их в часовой пояс сервера.
const LOCAL_TIMESTAMP = column => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS')`;

function chunks(items) {
  const result = [];
  for (let index = 0; index < items.length; index += BATCH_SIZE) result.push(items.slice(index, index + BATCH_SIZE));
  return result;
}

function placeholders(rowCount, columnCount) {
  const row = `(${new Array(columnCount).fill('?').join(', ')})`;
  return new Array(rowCount).fill(row).join(', ');
}

function createRnpRepository(db) {
  async function upsertRows(table, columns, conflict, rows, valuesOf) {
    const updates = columns.filter(column => !conflict.includes(column)).map(column => `${column}=EXCLUDED.${column}`).join(', ');
    // Одна вставка не может обновить строку дважды: дубли ключа внутри выгрузки WB схлопываем.
    const unique = new Map();
    for (const row of rows) {
      const values = valuesOf(row);
      unique.set(JSON.stringify(conflict.map(column => values[columns.indexOf(column)])), values);
    }
    for (const batch of chunks([...unique.values()])) {
      await db.runAsync(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders(batch.length, columns.length)}
         ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${updates}`,
        batch.flat()
      );
    }
  }

  return {
    getSync: userId => db.getAsync(
      `SELECT *, ads_synced_to::text AS ads_synced_to FROM wb_rnp_sync WHERE user_id=?`,
      [userId]
    ),

    ensureSync: userId => db.runAsync(
      'INSERT INTO wb_rnp_sync (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    ),

    // Захват синхронизации: зависшая больше 30 минут считается прерванной.
    claimSync: async (userId, progress) => {
      const rows = await db.allAsync(
        `UPDATE wb_rnp_sync
           SET status='running', started_at=NOW(), finished_at=NULL, last_error=NULL, progress=?::jsonb
         WHERE user_id=? AND (status <> 'running' OR started_at < NOW() - INTERVAL '30 minutes')
         RETURNING *, ads_synced_to::text AS ads_synced_to`,
        [JSON.stringify(progress), userId]
      );
      return rows[0] || null;
    },

    updateSync: async (userId, fields) => {
      const entries = Object.entries(fields).filter(([key]) => SYNC_FIELDS.has(key));
      if (!entries.length) return;
      const assignments = entries.map(([key]) => (JSON_FIELDS.has(key) ? `${key}=?::jsonb` : `${key}=?`)).join(', ');
      const values = entries.map(([key, value]) => (JSON_FIELDS.has(key) && value !== null ? JSON.stringify(value) : value));
      await db.runAsync(`UPDATE wb_rnp_sync SET ${assignments} WHERE user_id=?`, [...values, userId]);
    },

    // Новый токен может принадлежать другому кабинету — старые данные не смешиваем.
    resetData: async (userId, tokenFingerprint) => {
      await db.runAsync('DELETE FROM wb_orders WHERE user_id=?', [userId]);
      await db.runAsync('DELETE FROM wb_sales WHERE user_id=?', [userId]);
      await db.runAsync('DELETE FROM wb_ad_spend_daily WHERE user_id=?', [userId]);
      await db.runAsync('DELETE FROM wb_products WHERE user_id=?', [userId]);
      await db.runAsync(
        `UPDATE wb_rnp_sync SET token_fingerprint=?, orders_cursor=NULL, sales_cursor=NULL, ads_synced_to=NULL,
           ads_currency=NULL, ads_error=NULL, unit_costs=NULL, unit_costs_at=NULL, last_success_at=NULL,
           stocks_at=NULL, stocks_error=NULL
         WHERE user_id=?`,
        [tokenFingerprint, userId]
      );
    },

    markViewed: userId => db.runAsync('UPDATE wb_rnp_sync SET last_viewed_at=NOW() WHERE user_id=?', [userId]),

    // После перезапуска сервера незавершённые синхронизации продолжатся с курсоров.
    resetRunning: () => db.runAsync(`UPDATE wb_rnp_sync SET status='idle' WHERE status='running'`, []),

    listDueUserIds: async ({ viewedWithinHours, refreshAfterMinutes }) => {
      const rows = await db.allAsync(
        `SELECT s.user_id FROM wb_rnp_sync s JOIN users u ON u.id = s.user_id
         WHERE u.wb_api_token IS NOT NULL AND s.status <> 'running'
           AND s.last_viewed_at > NOW() - make_interval(hours => ?::int)
           AND (s.last_success_at IS NULL OR s.last_success_at < NOW() - make_interval(mins => ?::int))
           AND (s.status <> 'error' OR s.finished_at < NOW() - make_interval(mins => ?::int))
         ORDER BY s.last_success_at NULLS FIRST LIMIT 20`,
        [viewedWithinHours, refreshAfterMinutes, refreshAfterMinutes]
      );
      return rows.map(row => row.user_id);
    },

    upsertOrders: (userId, rows) => upsertRows(
      'wb_orders',
      ['user_id', 'srid', 'order_date', 'last_change_date', 'nm_id', 'supplier_article', 'brand', 'subject',
        'price_with_disc', 'finished_price', 'is_cancel', 'region', 'warehouse'],
      ['user_id', 'srid'],
      rows,
      row => [userId, row.srid, row.orderDate, row.lastChangeDate, row.nmId, row.supplierArticle, row.brand, row.subject,
        row.priceWithDisc, row.finishedPrice, row.isCancel, row.region, row.warehouse]
    ),

    upsertSales: (userId, rows) => upsertRows(
      'wb_sales',
      ['user_id', 'sale_id', 'srid', 'sale_date', 'last_change_date', 'nm_id', 'supplier_article', 'brand', 'subject',
        'is_return', 'price_with_disc', 'for_pay', 'finished_price'],
      ['user_id', 'sale_id'],
      rows,
      row => [userId, row.saleId, row.srid, row.saleDate, row.lastChangeDate, row.nmId, row.supplierArticle, row.brand,
        row.subject, row.isReturn, row.priceWithDisc, row.forPay, row.finishedPrice]
    ),

    // Кусок рекламы WB пересчитывает целиком, поэтому старые строки периода заменяются.
    replaceAdSpend: async (userId, dateFrom, dateTo, rows) => {
      await db.runAsync('DELETE FROM wb_ad_spend_daily WHERE user_id=? AND day BETWEEN ? AND ?', [userId, dateFrom, dateTo]);
      await upsertRows(
        'wb_ad_spend_daily',
        ['user_id', 'day', 'advert_id', 'nm_id', 'spend', 'views', 'clicks', 'orders'],
        ['user_id', 'day', 'advert_id', 'nm_id'],
        rows,
        row => [userId, row.day, row.advertId, row.nmId, row.spend, Math.round(row.views), Math.round(row.clicks), Math.round(row.orders)]
      );
    },

    listOrders: (userId, dateFrom, dateTo) => db.allAsync(
      `SELECT ${LOCAL_TIMESTAMP('order_date')} AS order_date, nm_id, supplier_article, brand, subject,
              price_with_disc, is_cancel, region, warehouse
       FROM wb_orders WHERE user_id=? AND order_date >= ?::date AND order_date < ?::date + 1`,
      [userId, dateFrom, dateTo]
    ),

    listSales: (userId, dateFrom, dateTo) => db.allAsync(
      `SELECT ${LOCAL_TIMESTAMP('sale_date')} AS sale_date, nm_id, supplier_article, brand, subject,
              is_return, price_with_disc, for_pay
       FROM wb_sales WHERE user_id=? AND sale_date >= ?::date AND sale_date < ?::date + 1`,
      [userId, dateFrom, dateTo]
    ),

    listAdSpend: (userId, dateFrom, dateTo) => db.allAsync(
      `SELECT day::text AS day, nm_id, SUM(spend) AS spend
       FROM wb_ad_spend_daily WHERE user_id=? AND day BETWEEN ? AND ?
       GROUP BY day, nm_id`,
      [userId, dateFrom, dateTo]
    ),

    dataRange: userId => db.getAsync(
      `SELECT to_char(MIN(order_date), 'YYYY-MM-DD') AS first_day, COUNT(*)::int AS orders
       FROM wb_orders WHERE user_id=?`,
      [userId]
    ),

    // Товары с остатками — снимок на момент загрузки: старый снимок заменяется целиком.
    replaceProducts: async (userId, rows) => {
      await db.runAsync('DELETE FROM wb_products WHERE user_id=?', [userId]);
      await upsertRows(
        'wb_products',
        ['user_id', 'nm_id', 'title', 'vendor_code', 'brand', 'subject', 'stock_wb', 'stock_mp'],
        ['user_id', 'nm_id'],
        rows,
        row => [userId, row.nmId, row.title, row.vendorCode, row.brand, row.subject, Math.round(row.stockWb), Math.round(row.stockMp)]
      );
    },

    listProducts: userId => db.allAsync(
      'SELECT nm_id, title, vendor_code, brand, subject, stock_wb, stock_mp FROM wb_products WHERE user_id=?',
      [userId]
    ),

    // Средние заказы в день для «хватит на N дней» считаем по последним дням, а не по выбранному периоду.
    orderCountsByNm: (userId, dateFrom, dateTo) => db.allAsync(
      `SELECT nm_id, COUNT(*)::int AS orders FROM wb_orders
       WHERE user_id=? AND order_date >= ?::date AND order_date < ?::date + 1
       GROUP BY nm_id`,
      [userId, dateFrom, dateTo]
    ),

    recentProducts: (userId, dateFrom, dateTo) => db.allAsync(
      `SELECT nm_id, MAX(supplier_article) AS supplier_article, MAX(subject) AS subject,
              COUNT(*)::int AS orders, SUM(price_with_disc) AS orders_sum
       FROM wb_orders WHERE user_id=? AND order_date >= ?::date AND order_date < ?::date + 1
       GROUP BY nm_id`,
      [userId, dateFrom, dateTo]
    ),

    listPlans: (userId, months) => db.allAsync(
      `SELECT month, nm_id, orders_sum, orders_count FROM rnp_plans WHERE user_id=? AND month = ANY(?::text[])`,
      [userId, months]
    ),

    savePlans: async (userId, month, items) => {
      for (const item of items) {
        if (item.ordersSum === null && item.ordersCount === null) {
          await db.runAsync('DELETE FROM rnp_plans WHERE user_id=? AND month=? AND nm_id=?', [userId, month, item.nmId]);
          continue;
        }
        await db.runAsync(
          `INSERT INTO rnp_plans (user_id, month, nm_id, orders_sum, orders_count, updated_at) VALUES (?, ?, ?, ?, ?, NOW())
           ON CONFLICT (user_id, month, nm_id) DO UPDATE
             SET orders_sum=EXCLUDED.orders_sum, orders_count=EXCLUDED.orders_count, updated_at=NOW()`,
          [userId, month, item.nmId, item.ordersSum, item.ordersCount]
        );
      }
    },

    listLabels: userId => db.allAsync('SELECT nm_id, labels FROM rnp_labels WHERE user_id=?', [userId]),

    saveLabels: (userId, nmId, labels) => (labels.length
      ? db.runAsync(
        `INSERT INTO rnp_labels (user_id, nm_id, labels) VALUES (?, ?, ?::text[])
         ON CONFLICT (user_id, nm_id) DO UPDATE SET labels=EXCLUDED.labels`,
        [userId, nmId, labels]
      )
      : db.runAsync('DELETE FROM rnp_labels WHERE user_id=? AND nm_id=?', [userId, nmId])),

    listCosts: userId => db.allAsync('SELECT supplier_article, cost_price FROM product_costs WHERE user_id=?', [userId]),

    getToken: async userId => (await db.getAsync('SELECT wb_api_token FROM users WHERE id=?', [userId]))?.wb_api_token || null
  };
}

module.exports = { createRnpRepository };
