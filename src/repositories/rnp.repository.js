const BATCH_SIZE = 500;
const SYNC_FIELDS = new Set([
  'token_fingerprint', 'status', 'progress', 'orders_cursor', 'sales_cursor', 'ads_synced_to',
  'ads_currency', 'ads_error', 'unit_costs', 'unit_costs_at', 'started_at', 'finished_at',
  'last_success_at', 'last_error', 'last_viewed_at', 'stocks_at', 'stocks_error',
  'orders_at', 'sales_at', 'ads_at', 'ads_from', 'costs_error',
  'finance_from', 'finance_to', 'finance_at', 'finance_currency', 'finance_error',
  'storage_from', 'storage_synced_to', 'storage_at', 'storage_error'
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
    getSync: shopId => db.getAsync(
      `SELECT *, ads_synced_to::text AS ads_synced_to, ads_from::text AS ads_from, finance_from::text AS finance_from, finance_to::text AS finance_to, storage_synced_to::text AS storage_synced_to, storage_from::text AS storage_from FROM wb_rnp_sync WHERE shop_id=?`,
      [shopId]
    ),

    ensureSync: shopId => db.runAsync(
      'INSERT INTO wb_rnp_sync (shop_id) VALUES (?) ON CONFLICT (shop_id) DO NOTHING',
      [shopId]
    ),

    // Захват синхронизации: зависшая больше 30 минут считается прерванной.
    claimSync: async (shopId, progress) => {
      const rows = await db.allAsync(
        `UPDATE wb_rnp_sync
           SET status='running', started_at=NOW(), finished_at=NULL, last_error=NULL, progress=?::jsonb
         WHERE shop_id=? AND (status <> 'running' OR started_at < NOW() - INTERVAL '30 minutes')
         RETURNING *, ads_synced_to::text AS ads_synced_to, ads_from::text AS ads_from, finance_from::text AS finance_from, finance_to::text AS finance_to, storage_synced_to::text AS storage_synced_to, storage_from::text AS storage_from`,
        [JSON.stringify(progress), shopId]
      );
      return rows[0] || null;
    },

    updateSync: async (shopId, fields) => {
      const entries = Object.entries(fields).filter(([key]) => SYNC_FIELDS.has(key));
      if (!entries.length) return;
      const assignments = entries.map(([key]) => (JSON_FIELDS.has(key) ? `${key}=?::jsonb` : `${key}=?`)).join(', ');
      const values = entries.map(([key, value]) => (JSON_FIELDS.has(key) && value !== null ? JSON.stringify(value) : value));
      await db.runAsync(`UPDATE wb_rnp_sync SET ${assignments} WHERE shop_id=?`, [...values, shopId]);
    },

    // Сброс загруженных данных WB магазина (себестоимость, планы и ярлыки не трогает).
    resetData: async (shopId, tokenFingerprint) => {
      await db.runAsync('DELETE FROM wb_orders WHERE shop_id=?', [shopId]);
      await db.runAsync('DELETE FROM wb_sales WHERE shop_id=?', [shopId]);
      await db.runAsync('DELETE FROM wb_ad_spend_daily WHERE shop_id=?', [shopId]);
      await db.runAsync('DELETE FROM wb_products WHERE shop_id=?', [shopId]);
      await db.runAsync('DELETE FROM wb_finance_rows WHERE shop_id=?', [shopId]);
      await db.runAsync('DELETE FROM wb_storage_daily WHERE shop_id=?', [shopId]);
      await db.runAsync(
        `UPDATE wb_rnp_sync SET token_fingerprint=?, orders_cursor=NULL, sales_cursor=NULL, ads_synced_to=NULL,
           ads_currency=NULL, ads_error=NULL, unit_costs=NULL, unit_costs_at=NULL, last_success_at=NULL,
           stocks_at=NULL, stocks_error=NULL, orders_at=NULL, sales_at=NULL, ads_at=NULL, ads_from=NULL, costs_error=NULL,
           finance_from=NULL, finance_to=NULL, finance_at=NULL, finance_currency=NULL, finance_error=NULL,
           storage_from=NULL, storage_synced_to=NULL, storage_at=NULL, storage_error=NULL
         WHERE shop_id=?`,
        [tokenFingerprint, shopId]
      );
    },

    markViewed: shopId => db.runAsync('UPDATE wb_rnp_sync SET last_viewed_at=NOW() WHERE shop_id=?', [shopId]),

    // После перезапуска сервера незавершённые синхронизации продолжатся с курсоров.
    resetRunning: () => db.runAsync(`UPDATE wb_rnp_sync SET status='idle' WHERE status='running'`, []),

    // Магазины, которые открывали недавно и чьи данные устарели.
    listDueShopIds: async ({ viewedWithinHours, refreshAfterMinutes }) => {
      const rows = await db.allAsync(
        `SELECT s.shop_id FROM wb_rnp_sync s JOIN wb_shops w ON w.id = s.shop_id
         WHERE s.status <> 'running'
           AND s.last_viewed_at > NOW() - make_interval(hours => ?::int)
           AND (s.last_success_at IS NULL OR s.last_success_at < NOW() - make_interval(mins => ?::int))
           AND (s.status <> 'error' OR s.finished_at < NOW() - make_interval(mins => ?::int))
         ORDER BY s.last_success_at NULLS FIRST LIMIT 20`,
        [viewedWithinHours, refreshAfterMinutes, refreshAfterMinutes]
      );
      return rows.map(row => row.shop_id);
    },

    upsertOrders: (shopId, rows) => upsertRows(
      'wb_orders',
      ['shop_id', 'srid', 'order_date', 'last_change_date', 'nm_id', 'supplier_article', 'brand', 'subject',
        'price_with_disc', 'finished_price', 'is_cancel', 'region', 'warehouse'],
      ['shop_id', 'srid'],
      rows,
      row => [shopId, row.srid, row.orderDate, row.lastChangeDate, row.nmId, row.supplierArticle, row.brand, row.subject,
        row.priceWithDisc, row.finishedPrice, row.isCancel, row.region, row.warehouse]
    ),

    upsertSales: (shopId, rows) => upsertRows(
      'wb_sales',
      ['shop_id', 'sale_id', 'srid', 'sale_date', 'last_change_date', 'nm_id', 'supplier_article', 'brand', 'subject',
        'is_return', 'price_with_disc', 'for_pay', 'finished_price'],
      ['shop_id', 'sale_id'],
      rows,
      row => [shopId, row.saleId, row.srid, row.saleDate, row.lastChangeDate, row.nmId, row.supplierArticle, row.brand,
        row.subject, row.isReturn, row.priceWithDisc, row.forPay, row.finishedPrice]
    ),

    // Кусок рекламы WB пересчитывает целиком, поэтому старые строки периода заменяются.
    replaceAdSpend: async (shopId, dateFrom, dateTo, rows) => {
      await db.runAsync('DELETE FROM wb_ad_spend_daily WHERE shop_id=? AND day BETWEEN ? AND ?', [shopId, dateFrom, dateTo]);
      await upsertRows(
        'wb_ad_spend_daily',
        ['shop_id', 'day', 'advert_id', 'nm_id', 'spend', 'order_sum', 'views', 'clicks', 'orders'],
        ['shop_id', 'day', 'advert_id', 'nm_id'],
        rows,
        row => [shopId, row.day, row.advertId, row.nmId, row.spend, row.orderSum || 0, Math.round(row.views), Math.round(row.clicks), Math.round(row.orders)]
      );
    },

    listOrders: (shopId, dateFrom, dateTo) => db.allAsync(
      `SELECT ${LOCAL_TIMESTAMP('order_date')} AS order_date, nm_id, supplier_article, brand, subject,
              price_with_disc, is_cancel, region, warehouse
       FROM wb_orders WHERE shop_id=? AND order_date >= ?::date AND order_date < ?::date + 1`,
      [shopId, dateFrom, dateTo]
    ),

    listSales: (shopId, dateFrom, dateTo) => db.allAsync(
      `SELECT ${LOCAL_TIMESTAMP('sale_date')} AS sale_date, nm_id, supplier_article, brand, subject,
              is_return, price_with_disc, for_pay, finished_price
       FROM wb_sales WHERE shop_id=? AND sale_date >= ?::date AND sale_date < ?::date + 1`,
      [shopId, dateFrom, dateTo]
    ),

    listAdSpend: (shopId, dateFrom, dateTo) => db.allAsync(
      `SELECT day::text AS day, nm_id, SUM(spend) AS spend
       FROM wb_ad_spend_daily WHERE shop_id=? AND day BETWEEN ? AND ?
       GROUP BY day, nm_id`,
      [shopId, dateFrom, dateTo]
    ),

    dataRange: shopId => db.getAsync(
      `SELECT to_char(MIN(order_date), 'YYYY-MM-DD') AS first_day, COUNT(*)::int AS orders
       FROM wb_orders WHERE shop_id=?`,
      [shopId]
    ),

    // Товары с остатками — снимок на момент загрузки: старый снимок заменяется целиком.
    replaceProducts: async (shopId, rows) => {
      await db.runAsync('DELETE FROM wb_products WHERE shop_id=?', [shopId]);
      await upsertRows(
        'wb_products',
        ['shop_id', 'nm_id', 'title', 'vendor_code', 'brand', 'subject', 'stock_wb', 'stock_mp'],
        ['shop_id', 'nm_id'],
        rows,
        row => [shopId, row.nmId, row.title, row.vendorCode, row.brand, row.subject, Math.round(row.stockWb), Math.round(row.stockMp)]
      );
    },

    listProducts: shopId => db.allAsync(
      'SELECT nm_id, title, vendor_code, brand, subject, stock_wb, stock_mp FROM wb_products WHERE shop_id=?',
      [shopId]
    ),

    // Средние заказы в день для «хватит на N дней» считаем по последним дням, а не по выбранному периоду.
    orderCountsByNm: (shopId, dateFrom, dateTo) => db.allAsync(
      `SELECT nm_id, COUNT(*)::int AS orders FROM wb_orders
       WHERE shop_id=? AND order_date >= ?::date AND order_date < ?::date + 1
       GROUP BY nm_id`,
      [shopId, dateFrom, dateTo]
    ),

    recentProducts: (shopId, dateFrom, dateTo) => db.allAsync(
      `SELECT nm_id, MAX(supplier_article) AS supplier_article, MAX(subject) AS subject,
              COUNT(*)::int AS orders, SUM(price_with_disc) AS orders_sum
       FROM wb_orders WHERE shop_id=? AND order_date >= ?::date AND order_date < ?::date + 1
       GROUP BY nm_id`,
      [shopId, dateFrom, dateTo]
    ),

    listPlans: (shopId, months) => db.allAsync(
      `SELECT month, nm_id, orders_sum, orders_count FROM rnp_plans WHERE shop_id=? AND month = ANY(?::text[])`,
      [shopId, months]
    ),

    savePlans: async (shopId, month, items) => {
      for (const item of items) {
        if (item.ordersSum === null && item.ordersCount === null) {
          await db.runAsync('DELETE FROM rnp_plans WHERE shop_id=? AND month=? AND nm_id=?', [shopId, month, item.nmId]);
          continue;
        }
        await db.runAsync(
          `INSERT INTO rnp_plans (shop_id, month, nm_id, orders_sum, orders_count, updated_at) VALUES (?, ?, ?, ?, ?, NOW())
           ON CONFLICT (shop_id, month, nm_id) DO UPDATE
             SET orders_sum=EXCLUDED.orders_sum, orders_count=EXCLUDED.orders_count, updated_at=NOW()`,
          [shopId, month, item.nmId, item.ordersSum, item.ordersCount]
        );
      }
    },

    listLabels: shopId => db.allAsync('SELECT nm_id, labels FROM rnp_labels WHERE shop_id=?', [shopId]),

    saveLabels: (shopId, nmId, labels) => (labels.length
      ? db.runAsync(
        `INSERT INTO rnp_labels (shop_id, nm_id, labels) VALUES (?, ?, ?::text[])
         ON CONFLICT (shop_id, nm_id) DO UPDATE SET labels=EXCLUDED.labels`,
        [shopId, nmId, labels]
      )
      : db.runAsync('DELETE FROM rnp_labels WHERE shop_id=? AND nm_id=?', [shopId, nmId])),

    // Итоги рекламы за период для «Аналитики WB» — те же поля, что даёт fullstats.
    adTotals: (shopId, dateFrom, dateTo) => db.getAsync(
      `SELECT COALESCE(SUM(spend), 0) AS spend, COALESCE(SUM(order_sum), 0) AS order_sum,
              COALESCE(SUM(views), 0)::bigint AS views, COALESCE(SUM(clicks), 0)::bigint AS clicks,
              COALESCE(SUM(orders), 0)::bigint AS orders,
              COUNT(DISTINCT advert_id) FILTER (WHERE spend > 0 OR views > 0)::int AS campaign_count
       FROM wb_ad_spend_daily WHERE shop_id=? AND day BETWEEN ? AND ?`,
      [shopId, dateFrom, dateTo]
    ),

    // Кусок финотчёта WB пересчитывает целиком, поэтому строки периода заменяются.
    replaceFinanceRows: async (shopId, dateFrom, dateTo, rows) => {
      await db.runAsync('DELETE FROM wb_finance_rows WHERE shop_id=? AND rr_date BETWEEN ? AND ?', [shopId, dateFrom, dateTo]);
      await upsertRows(
        'wb_finance_rows',
        ['shop_id', 'rrd_id', 'rr_date', 'currency', 'vendor_code', 'quantity', 'operation', 'document_type', 'retail_amount',
          'sales', 'payable', 'commission', 'logistics', 'storage', 'penalty', 'deduction', 'acceptance', 'additional_payment', 'margin',
          'nm_id', 'deduction_kind'],
        ['shop_id', 'rrd_id'],
        rows.filter(row => row.rrdId && row.date >= dateFrom && row.date <= dateTo),
        row => [shopId, row.rrdId, row.date, row.currency, row.vendorCode, row.quantity, row.operation, row.documentType,
          row.retailAmount, row.sales, row.payable, row.commission, row.logistics, row.storage, row.penalty, row.deduction,
          row.acceptance, row.additionalPayment, row.margin, row.nmId || null, row.deductionKind || null]
      );
    },

    // Строки в том же виде, что отдаёт normalizeFinanceRows.
    listFinanceRows: async (shopId, dateFrom, dateTo) => {
      const rows = await db.allAsync(
        `SELECT rr_date::text AS date, currency, vendor_code, quantity, operation, document_type, retail_amount, sales,
                payable, commission, logistics, storage, penalty, deduction, acceptance, additional_payment, margin,
                nm_id, deduction_kind
         FROM wb_finance_rows WHERE shop_id=? AND rr_date BETWEEN ? AND ? ORDER BY rrd_id`,
        [shopId, dateFrom, dateTo]
      );
      const money = value => Number(value) || 0;
      return rows.map(row => ({
        date: row.date,
        currency: row.currency,
        vendorCode: row.vendor_code,
        quantity: money(row.quantity),
        operation: row.operation,
        documentType: row.document_type,
        retailAmount: money(row.retail_amount),
        sales: money(row.sales),
        payable: money(row.payable),
        commission: money(row.commission),
        logistics: money(row.logistics),
        storage: money(row.storage),
        penalty: money(row.penalty),
        deduction: money(row.deduction),
        acceptance: money(row.acceptance),
        additionalPayment: money(row.additional_payment),
        margin: money(row.margin),
        // Поля есть только у строк, загруженных с nmId и типом удержания.
        ...(row.nm_id ? { nmId: Number(row.nm_id) } : {}),
        ...(row.deduction_kind ? { deductionKind: row.deduction_kind } : {})
      }));
    },

    // Платное хранение: кусок отчёта WB пересчитывается целиком.
    replaceStorage: async (shopId, dateFrom, dateTo, rows) => {
      await db.runAsync('DELETE FROM wb_storage_daily WHERE shop_id=? AND day BETWEEN ? AND ?', [shopId, dateFrom, dateTo]);
      await upsertRows(
        'wb_storage_daily',
        ['shop_id', 'day', 'nm_id', 'cost'],
        ['shop_id', 'day', 'nm_id'],
        rows,
        row => [shopId, row.day, row.nmId, row.cost]
      );
    },

    storageCostByNm: (shopId, dateFrom, dateTo) => db.allAsync(
      'SELECT nm_id, SUM(cost) AS cost FROM wb_storage_daily WHERE shop_id=? AND day BETWEEN ? AND ? GROUP BY nm_id',
      [shopId, dateFrom, dateTo]
    ),

    // Артикулы, которые продавались или возвращались по финотчёту, — им нужна себестоимость.
    soldVendorCodes: (shopId, dateFrom) => db.allAsync(
      `SELECT DISTINCT vendor_code FROM wb_finance_rows
       WHERE shop_id=? AND rr_date >= ? AND vendor_code <> '' AND operation IN ('Продажа', 'Возврат')`,
      [shopId, dateFrom]
    ),

    listCosts: shopId => db.allAsync('SELECT supplier_article, cost_price FROM product_costs WHERE shop_id=?', [shopId]),

    getToken: async shopId => (await db.getAsync('SELECT token FROM wb_shops WHERE id=?', [shopId]))?.token || null
  };
}

module.exports = { createRnpRepository };
