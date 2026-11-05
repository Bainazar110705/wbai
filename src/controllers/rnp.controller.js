const { AppError } = require('../platform/errors');
const { buildRnpReport } = require('../services/wb-rnp.service');
const { moscowDate, addDays, HISTORY_DAYS, REFRESH_AFTER_MINUTES } = require('../services/wb-rnp-sync.service');
const { STATISTICS_CURRENCY } = require('../services/wb-statistics.service');

const MAX_PERIOD_DAYS = 92;
const STOCK_WINDOW_DAYS = 14;
const PLAN_HINT_DAYS = 30;
const MAX_PLAN_ITEMS = 2000;
const MAX_LABELS = 10;
const MAX_LABEL_LENGTH = 30;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NO_TOKEN_MESSAGE = 'Токен WB не настроен';

function parsePeriod(query) {
  const { from, to } = query || {};
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    throw new AppError(400, 'Укажите период: from и to в формате ГГГГ-ММ-ДД.', 'VALIDATION_ERROR');
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (!Number.isFinite(days) || days < 1 || days > MAX_PERIOD_DAYS) {
    throw new AppError(400, `Период РНП — от 1 до ${MAX_PERIOD_DAYS} дней.`, 'VALIDATION_ERROR');
  }
  return { dateFrom: from, dateTo: to };
}

function parseMonth(value) {
  if (!MONTH_RE.test(String(value || ''))) throw new AppError(400, 'Укажите месяц в формате ГГГГ-ММ.', 'VALIDATION_ERROR');
  return value;
}

function monthsOf(dateFrom, dateTo) {
  const months = [];
  for (let month = dateFrom.slice(0, 7); month <= dateTo.slice(0, 7);) {
    months.push(month);
    const [year, number] = month.split('-').map(Number);
    month = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
  }
  return months;
}

// Пустое поле плана — «план не задан», иначе целое неотрицательное число.
function planValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e12) {
    throw new AppError(400, 'План должен быть неотрицательным числом.', 'VALIDATION_ERROR');
  }
  return Math.round(parsed);
}

function parsePlanItems(items) {
  if (!Array.isArray(items) || items.length > MAX_PLAN_ITEMS) throw new AppError(400, 'Некорректный список плана.', 'VALIDATION_ERROR');
  return items.map(item => {
    const nmId = Number(item?.nmId);
    if (!Number.isSafeInteger(nmId) || nmId < 0) throw new AppError(400, 'Некорректный артикул в плане.', 'VALIDATION_ERROR');
    return { nmId, ordersSum: planValue(item.ordersSum), ordersCount: planValue(item.ordersCount) };
  });
}

function parseLabels(labels) {
  if (!Array.isArray(labels)) throw new AppError(400, 'Ярлыки — это список строк.', 'VALIDATION_ERROR');
  const seen = new Set();
  return labels
    .map(label => String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH))
    .filter(label => label && !seen.has(label.toLowerCase()) && seen.add(label.toLowerCase()))
    .slice(0, MAX_LABELS);
}

// Суммы WB переводим в тенге без округления каждой строки.
function converter(currency, rubKztRate) {
  const normalized = String(currency || '').toUpperCase();
  if (normalized === 'RUB') return value => (Number(value) || 0) * rubKztRate;
  return value => Number(value) || 0;
}

// Время загрузки каждого источника и до какого момента у WB есть данные.
// Курсоры WB — время МСК без пояса («2026-11-05T09:52:00»).
function sourceTimes(sync) {
  const iso = value => (value ? new Date(value).toISOString() : null);
  return {
    orders: { loadedAt: iso(sync?.orders_at), wbChangedAt: sync?.orders_cursor || null },
    sales: { loadedAt: iso(sync?.sales_at), wbChangedAt: sync?.sales_cursor || null },
    stocks: { loadedAt: iso(sync?.stocks_at), error: sync?.stocks_error || null },
    ads: { loadedAt: iso(sync?.ads_at), through: sync?.ads_synced_to || null, error: sync?.ads_error || null },
    finance: { loadedAt: iso(sync?.finance_at), from: sync?.finance_from || null, to: sync?.finance_to || null, error: sync?.finance_error || null },
    costs: { loadedAt: iso(sync?.unit_costs_at), error: sync?.costs_error || null }
  };
}

function createRnpController({ repository, syncService, getRubKztRate, now = () => new Date() }) {
  function syncInfo(userId, sync, dataRange) {
    const running = syncService.isRunning(userId) || sync?.status === 'running';
    return {
      status: running ? 'running' : (sync?.status || 'idle'),
      progress: sync?.progress || {},
      initial: !sync?.last_success_at,
      lastSuccessAt: sync?.last_success_at || null,
      lastError: running ? null : (sync?.last_error || null),
      adsError: sync?.ads_error || null,
      stocksError: sync?.stocks_error || null,
      sources: sourceTimes(sync),
      nextRefreshAt: running || !sync?.last_success_at ? null : new Date(new Date(sync.last_success_at).getTime() + REFRESH_AFTER_MINUTES * 60_000).toISOString(),
      firstDay: dataRange?.first_day || null,
      historyDays: HISTORY_DAYS
    };
  }

  async function loadState(userId) {
    if (!await repository.getToken(userId)) return null;
    await repository.ensureSync(userId);
    await repository.markViewed(userId);
    return repository.getSync(userId);
  }

  return {
    async report(req, res) {
      const userId = req.user.id;
      const today = moscowDate(now());
      const period = parsePeriod(req.query);
      const sync = await loadState(userId);
      if (!sync) return res.status(400).json({ error: NO_TOKEN_MESSAGE, noToken: true });
      syncService.requestSync(userId, sync);
      const dataRange = await repository.dataRange(userId);
      const info = syncInfo(userId, sync, dataRange);
      // Пока идёт первая загрузка, неполную таблицу не показываем.
      if (info.initial) return res.json({ sync: info, report: null });

      const [orders, sales, adSpend, costs, plans, stocks, recentOrders, labels, rubKztRate] = await Promise.all([
        repository.listOrders(userId, period.dateFrom, period.dateTo),
        repository.listSales(userId, period.dateFrom, period.dateTo),
        repository.listAdSpend(userId, period.dateFrom, period.dateTo),
        repository.listCosts(userId),
        repository.listPlans(userId, monthsOf(period.dateFrom, period.dateTo)),
        sync.stocks_at ? repository.listProducts(userId) : null,
        repository.orderCountsByNm(userId, addDays(today, -STOCK_WINDOW_DAYS), addDays(today, -1)),
        repository.listLabels(userId),
        getRubKztRate()
      ]);
      const historyStart = addDays(today, -(HISTORY_DAYS - 1));
      const report = buildRnpReport({
        ...period,
        today,
        dataFrom: [historyStart, dataRange?.first_day || historyStart].sort()[0],
        orders,
        sales,
        adSpend,
        costs,
        plans,
        stocks,
        recentOrders,
        stockWindowDays: STOCK_WINDOW_DAYS,
        labels,
        unitCosts: sync.unit_costs,
        statisticsToKzt: converter(STATISTICS_CURRENCY, rubKztRate),
        adsToKzt: converter(sync.ads_currency, rubKztRate),
        financeToKzt: converter(sync.unit_costs?.currency, rubKztRate)
      });
      res.json({
        sync: info,
        report: {
          ...report,
          currency: 'KZT',
          rubKztRate: STATISTICS_CURRENCY === 'RUB' ? rubKztRate : null,
          stocksAt: sync.stocks_at || null
        }
      });
    },

    async status(req, res) {
      const sync = await repository.getSync(req.user.id);
      const dataRange = await repository.dataRange(req.user.id);
      res.json({ sync: syncInfo(req.user.id, sync, dataRange) });
    },

    // План на месяц: магазин (nmId 0) и товары с заказами за 30 дней как подсказка.
    async plans(req, res) {
      const userId = req.user.id;
      const month = parseMonth(req.query.month);
      const today = moscowDate(now());
      const [plans, recent, rubKztRate] = await Promise.all([
        repository.listPlans(userId, [month]),
        repository.recentProducts(userId, addDays(today, -PLAN_HINT_DAYS), addDays(today, -1)),
        getRubKztRate()
      ]);
      const toKzt = converter(STATISTICS_CURRENCY, rubKztRate);
      const planByNm = new Map(plans.map(row => [Number(row.nm_id), row]));
      const value = raw => (raw === null || raw === undefined ? null : Number(raw));
      const products = new Map(recent.map(row => [Number(row.nm_id), {
        nmId: Number(row.nm_id),
        vendorCode: row.supplier_article || '',
        subject: row.subject || '',
        last30OrdersSum: Math.round(toKzt(row.orders_sum)),
        last30OrdersCount: Number(row.orders) || 0
      }]));
      for (const nmId of planByNm.keys()) {
        if (nmId && !products.has(nmId)) products.set(nmId, { nmId, vendorCode: '', subject: '', last30OrdersSum: 0, last30OrdersCount: 0 });
      }
      const shop = planByNm.get(0);
      res.json({
        month,
        hintDays: PLAN_HINT_DAYS,
        shop: {
          ordersSum: value(shop?.orders_sum),
          ordersCount: value(shop?.orders_count),
          last30OrdersSum: [...products.values()].reduce((sum, product) => sum + product.last30OrdersSum, 0),
          last30OrdersCount: [...products.values()].reduce((sum, product) => sum + product.last30OrdersCount, 0)
        },
        products: [...products.values()]
          .map(product => ({
            ...product,
            ordersSum: value(planByNm.get(product.nmId)?.orders_sum),
            ordersCount: value(planByNm.get(product.nmId)?.orders_count)
          }))
          .sort((a, b) => b.last30OrdersSum - a.last30OrdersSum)
      });
    },

    async savePlans(req, res) {
      const month = parseMonth(req.body?.month);
      const items = parsePlanItems(req.body?.items);
      await repository.savePlans(req.user.id, month, items);
      res.json({ ok: true });
    },

    async saveLabels(req, res) {
      const nmId = Number(req.body?.nmId);
      if (!Number.isSafeInteger(nmId) || nmId <= 0) throw new AppError(400, 'Некорректный артикул.', 'VALIDATION_ERROR');
      const labels = parseLabels(req.body?.labels);
      await repository.saveLabels(req.user.id, nmId, labels);
      res.json({ ok: true, labels });
    },

    async refresh(req, res) {
      const sync = await loadState(req.user.id);
      if (!sync) return res.status(400).json({ error: NO_TOKEN_MESSAGE, noToken: true });
      const started = syncService.requestSync(req.user.id, sync, { force: true });
      res.json({ ok: true, started });
    }
  };
}

module.exports = { createRnpController, parsePeriod, parsePlanItems, parseLabels, monthsOf, sourceTimes };
