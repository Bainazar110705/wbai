const { buildProductPnl } = require('../services/wb-product-pnl.service');

// Суммы WB переводим в тенге без округления каждой строки — округляем итоги.
function converter(currency, rubKztRate) {
  const normalized = String(currency || '').toUpperCase();
  if (normalized === 'RUB') return value => (Number(value) || 0) * rubKztRate;
  return value => Number(value) || 0;
}

function previousDay(day) {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

const DETAIL_KEY_RE = /^(nm:\d{1,15}|vc:.{1,255}|shop)$/;

function createAnalyticsProductsController({
  storedSync,
  resolveRange,
  loadFinance,
  loadStockDays,
  findFunnel,
  repository,
  getRubKztRate,
  today
}) {
  return {
    // Прибыль по каждому товару за период «Аналитики»; ?key=nm:… — с разбивкой по дням.
    async list(req, res) {
      if (!req.shop) return res.status(400).json({ error: 'Токен WB не настроен', noToken: true });
      const shopId = req.shop.id;
      const token = req.shop.token;
      const moscowToday = today();
      const range = resolveRange(req.query, moscowToday);
      if (!range) return res.status(400).json({ error: 'Некорректный период аналитики.' });
      const detailKey = typeof req.query.key === 'string' && DETAIL_KEY_RE.test(req.query.key) ? req.query.key : null;
      const sync = await storedSync(shopId);

      let finance;
      try {
        finance = await loadFinance({ shopId, token, sync, dateFrom: range.dateFrom, dateTo: range.dateTo, today: moscowToday });
      } catch (error) {
        return res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message || 'Финотчёт WB недоступен.' });
      }
      // Строки финотчёта могут быть шире периода (кэш большего периода) — берём только нужные дни.
      const rows = (Array.isArray(finance?.payload?.rows) ? finance.payload.rows : [])
        .filter(row => row.date >= range.dateFrom && row.date <= range.dateTo);
      const financeCurrency = finance?.payload?.currency || null;

      // Хранение по товарам используем, только если отчёт покрывает весь период (кроме сегодня).
      const storageNeedTo = range.dateTo >= moscowToday ? previousDay(moscowToday) : range.dateTo;
      const storageKnown = !!(sync?.storage_from && sync.storage_synced_to && sync.storage_from <= range.dateFrom && sync.storage_synced_to >= storageNeedTo);
      const [catalog, adRows, costs, rubKztRate, stockDays, funnel, storageRows] = await Promise.all([
        repository.listProducts(shopId),
        sync?.ads_from && sync.ads_from <= range.dateFrom ? repository.listAdSpend(shopId, range.dateFrom, range.dateTo) : [],
        repository.listCosts(shopId),
        getRubKztRate(),
        loadStockDays(shopId, sync, moscowToday),
        findFunnel(shopId, range),
        storageKnown ? repository.storageCostByNm(shopId, range.dateFrom, range.dateTo) : []
      ]);
      const storageByNm = new Map(storageRows.map(row => [Number(row.nm_id), Number(row.cost) || 0]));
      const adsToKzt = converter(sync?.ads_currency, rubKztRate);
      const adSpendByNm = new Map();
      for (const row of adRows) {
        const nmId = Number(row.nm_id);
        if (nmId) adSpendByNm.set(nmId, (adSpendByNm.get(nmId) || 0) + adsToKzt(row.spend));
      }
      const costsByVendorCode = Object.fromEntries(costs.map(row => [String(row.supplier_article || '').trim(), Number(row.cost_price) || 0]));

      const report = buildProductPnl({
        rows,
        costsByVendorCode,
        adSpendByNm,
        storageByNm,
        catalog,
        toKzt: converter(financeCurrency, rubKztRate),
        detailKey
      });
      const funnelByNm = new Map((funnel || []).map(item => [Number(item.nmId), item]));
      for (const product of report.products) {
        const stock = product.nmId && stockDays ? stockDays.get(product.nmId) : null;
        product.stock = stock ? { quantity: stock.quantity, wb: stock.wb, fbs: stock.fbs, daysLeft: stock.daysLeft } : null;
        if (product.key === detailKey) product.funnel = funnelByNm.get(product.nmId) || null;
      }

      res.json({
        period: { dateFrom: range.dateFrom, dateTo: range.dateTo },
        currency: 'KZT',
        financeCurrency,
        financeReady: rows.length > 0,
        adsKnown: !!(sync?.ads_from && sync.ads_from <= range.dateFrom),
        kindsKnown: report.kindsKnown,
        storageKnown,
        shop: report.shop,
        products: report.products,
        check: report.check,
        fetchedAt: finance?.fetchedAt || null,
        stored: !!finance?.stored
      });
    }
  };
}

module.exports = { createAnalyticsProductsController, converter };
