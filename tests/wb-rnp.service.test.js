const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRnpReport, listDays, stockInfo } = require('../src/services/wb-rnp.service');
const { extractDailyNmSpend } = require('../src/services/wb-advertising.service');
const { normalizeOrder, normalizeSale, createStatisticsService } = require('../src/services/wb-statistics.service');
const { funnelStocks, normalizeFunnelProduct } = require('../src/services/wb-sales-funnel.service');
const { computeUnitCosts, createRnpSyncService, addDays } = require('../src/services/wb-rnp-sync.service');
const { createRnpController, parsePeriod, parsePlanItems, parseLabels, monthsOf, sourceTimes, importPercent } = require('../src/controllers/rnp.controller');

const order = (day, nmId, price, extra = {}) => ({
  order_date: `${day}T10:00:00`, nm_id: String(nmId), supplier_article: `art-${nmId}`, brand: 'PURO', subject: 'Пылесосы',
  price_with_disc: String(price), is_cancel: false, ...extra
});
const sale = (day, nmId, price, forPay, extra = {}) => ({
  sale_date: `${day}T12:00:00`, nm_id: String(nmId), supplier_article: `art-${nmId}`, brand: 'PURO', subject: 'Пылесосы',
  is_return: false, price_with_disc: String(price), for_pay: String(forPay), ...extra
});

test('listDays covers the period inclusively across a month boundary', () => {
  assert.deepEqual(listDays('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('buildRnpReport sums the shop and products by day and estimates profit', () => {
  const report = buildRnpReport({
    dateFrom: '2026-10-01',
    dateTo: '2026-10-03',
    today: '2026-10-02',
    orders: [
      order('2026-10-01', 1, 1000),
      order('2026-10-01', 1, 1000, { is_cancel: true }),
      order('2026-10-02', 2, 500),
      order('2026-09-30', 1, 9999)
    ],
    sales: [
      sale('2026-10-01', 1, 1000, 800),
      sale('2026-10-02', 1, 1000, 800, { is_return: true }),
      sale('2026-10-02', 2, 500, 400)
    ],
    adSpend: [
      { day: '2026-10-01', nm_id: '1', spend: '100' },
      { day: '2026-10-01', nm_id: '0', spend: '50' }
    ],
    costs: [{ supplier_article: 'ART-1', cost_price: 300 }],
    unitCosts: { shopPerUnit: 60, byVendor: { 'art-1': 100 } }
  });

  assert.deepEqual(report.period.days, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(report.period.elapsedDays, 2);
  assert.deepEqual(report.shop[0], {
    ordersSum: 2000, ordersCount: 2, cancelCount: 1, buyoutsSum: 1000, buyoutsCount: 1, returnsCount: 0,
    // 800 к перечислению − 300 себестоимость − 100 логистика − 150 реклама (с нераспределённой)
    buyoutPct: 100, adSpend: 150, drr: 7.5, profit: 250, margin: 25
  });
  assert.equal(report.shop[2], null, 'будущий день пустой');
  // День 2: возврат товара 1 (−800 + 300) и выкуп товара 2 без себестоимости (400 − 60).
  assert.equal(report.shop[1].profit, -500 + 340);
  assert.equal(report.shop[1].buyoutPct, 50);

  assert.equal(report.kpi.ordersCount, 3);
  assert.equal(report.kpi.ordersPerDay, 1.5);
  assert.equal(report.kpi.adSpend, 150);
  assert.equal(report.kpi.cpo, 50);
  assert.equal(report.kpi.cogsMissing, true);

  const [first, second] = report.products;
  assert.equal(first.nmId, 1);
  assert.equal(first.abc, 'A');
  assert.equal(first.unpriced, false);
  assert.equal(first.totals.adSpend, 100, 'нераспределённая реклама не попадает в товар');
  assert.equal(second.nmId, 2);
  assert.equal(second.unpriced, true);
  assert.equal(second.days[0].profit, null, 'нет движения денег — нет прибыли');
});

test('buildRnpReport converts every money source with its own currency', () => {
  const report = buildRnpReport({
    dateFrom: '2026-10-01', dateTo: '2026-10-01', today: '2026-10-01',
    orders: [order('2026-10-01', 1, 100)],
    sales: [sale('2026-10-01', 1, 100, 80)],
    adSpend: [{ day: '2026-10-01', nm_id: '1', spend: '10' }],
    unitCosts: { shopPerUnit: 2, byVendor: {} },
    statisticsToKzt: value => Number(value) * 6,
    adsToKzt: value => Number(value),
    financeToKzt: value => Number(value) * 6
  });
  assert.equal(report.kpi.ordersSum, 600);
  assert.equal(report.kpi.adSpend, 10);
  assert.equal(report.kpi.profit, 480 - 12 - 10);
});

test('extractDailyNmSpend splits campaigns by day and article and keeps the unattributed rest', () => {
  const rows = extractDailyNmSpend([{
    advertId: 7,
    sum: 150,
    days: [{
      date: '2026-10-01T00:00:00+03:00', sum: 150, sum_price: 900, views: 30, clicks: 3, orders: 1,
      apps: [
        { appType: 1, nms: [{ nmId: 11, sum: 60, sum_price: 900, views: 10, clicks: 1, orders: 1 }] },
        { appType: 32, nms: [{ nmId: 11, sum: 40, views: 10, clicks: 1, orders: 0 }] }
      ]
    }]
  }]);
  assert.deepEqual(rows, [
    { day: '2026-10-01', advertId: 7, nmId: 11, spend: 100, orderSum: 900, views: 20, clicks: 2, orders: 1 },
    { day: '2026-10-01', advertId: 7, nmId: 0, spend: 50, orderSum: 0, views: 10, clicks: 1, orders: 0 }
  ]);
});

test('normalizeOrder and normalizeSale keep Moscow time and unsigned returns', () => {
  assert.deepEqual(normalizeOrder({
    date: '2026-10-01T23:59:00', lastChangeDate: '2026-10-02T08:00:00', nmId: 5, srid: 'x1',
    supplierArticle: ' A ', brand: 'B', subject: 'S', priceWithDisc: 900.5, finishedPrice: 700, isCancel: true,
    regionName: 'Алматы', warehouseName: 'Астана'
  }), {
    srid: 'x1', orderDate: '2026-10-01T23:59:00', lastChangeDate: '2026-10-02T08:00:00', nmId: 5,
    supplierArticle: 'A', brand: 'B', subject: 'S', priceWithDisc: 900.5, finishedPrice: 700, isCancel: true,
    region: 'Алматы', warehouse: 'Астана'
  });
  const returned = normalizeSale({ date: '2026-10-03T10:00:00', nmId: 5, saleID: 'R123', priceWithDisc: -900, forPay: -800 });
  assert.equal(returned.isReturn, true);
  assert.equal(returned.priceWithDisc, 900);
  assert.equal(returned.forPay, 800);
  assert.equal(normalizeOrder({ date: '2026-10-01', nmId: 5 }), null, 'без srid строку не сохраняем');
});

test('statistics loadSince pages by lastChangeDate and stops on a short page', async () => {
  const requested = [];
  const pages = [
    Array.from({ length: 50_000 }, (_, index) => ({ date: '2026-10-01T10:00:00', lastChangeDate: `2026-10-01T10:${String(index % 60).padStart(2, '0')}:00`, nmId: 1, srid: `s${index}` })),
    [{ date: '2026-10-02T10:00:00', lastChangeDate: '2026-10-02T11:00:00', nmId: 1, srid: 'last' }]
  ];
  const waits = [];
  const service = createStatisticsService({
    fetchImpl: async url => {
      requested.push(new URL(url).searchParams.get('dateFrom'));
      return { ok: true, status: 200, json: async () => pages.shift() };
    },
    wait: async ms => waits.push(ms)
  });
  const saved = [];
  const cursor = await service.loadSince({ method: 'orders', token: 't', cursor: '2026-08-01T00:00:00', onPage: async (rows, next) => saved.push([rows.length, next]) });
  assert.deepEqual(requested, ['2026-08-01T00:00:00', '2026-10-01T10:59:00']);
  assert.deepEqual(saved, [[50_000, '2026-10-01T10:59:00'], [1, '2026-10-02T11:00:00']]);
  assert.equal(cursor, '2026-10-02T11:00:00');
  assert.deepEqual(waits, [61_000]);
});

test('computeUnitCosts spreads shop-level storage over every sold unit', () => {
  const unit = computeUnitCosts([
    { vendorCode: 'A', operation: 'Продажа', quantity: 2, logistics: 0 },
    { vendorCode: 'A', operation: 'Логистика', quantity: 0, logistics: 200 },
    { vendorCode: 'B', operation: 'Продажа', quantity: 2, logistics: 0 },
    { vendorCode: '', operation: 'Хранение', quantity: 0, storage: 40 },
    { vendorCode: 'C', operation: 'Логистика', quantity: 0, logistics: 30 }
  ], { currency: 'KZT' });
  assert.deepEqual(unit.byVendor, { a: 110, b: 10 });
  assert.equal(unit.shopPerUnit, 67.5);
  assert.equal(unit.currency, 'KZT');
});

test('parsePeriod rejects bad dates and periods longer than 92 days', () => {
  assert.deepEqual(parsePeriod({ from: '2026-10-01', to: '2026-10-31' }), { dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  assert.throws(() => parsePeriod({ from: '2026-10-31', to: '2026-10-01' }), /от 1 до 92/);
  assert.throws(() => parsePeriod({ from: '2026-01-01', to: '2026-10-01' }), /от 1 до 92/);
  assert.throws(() => parsePeriod({ from: 'x', to: '2026-10-01' }), /ГГГГ-ММ-ДД/);
});

function fakeRepository(initial = {}) {
  const state = { sync: { token_fingerprint: null, status: 'idle', ...initial }, calls: [] };
  return {
    state,
    getToken: async () => 'token',
    ensureSync: async () => {},
    getSync: async () => ({ ...state.sync }),
    resetData: async (userId, fingerprint) => { state.calls.push('reset'); state.sync.token_fingerprint = fingerprint; state.sync.orders_cursor = null; },
    claimSync: async () => (state.sync.status === 'running' ? null : (state.sync.status = 'running', { ...state.sync })),
    updateSync: async (userId, fields) => { Object.assign(state.sync, fields); },
    upsertOrders: async (userId, rows) => state.calls.push(['orders', rows.length]),
    upsertSales: async (userId, rows) => state.calls.push(['sales', rows.length]),
    replaceAdSpend: async (userId, from, to, rows) => state.calls.push(['ads', from, to, rows.length]),
    replaceProducts: async (userId, rows) => state.calls.push(['stocks', rows.length]),
    replaceFinanceRows: async (userId, from, to, rows) => {
      state.calls.push(['finance', from, to, rows.length]);
      state.finance = (state.finance || []).filter(row => row.date < from || row.date > to).concat(rows);
    },
    listFinanceRows: async (userId, from, to) => (state.finance || []).filter(row => row.date >= from && row.date <= to)
  };
}

test('sync loads history once, then only new rows from saved cursors', async () => {
  const repository = fakeRepository();
  const cursors = [];
  const adPeriods = [];
  const statisticsService = {
    loadSince: async ({ method, cursor, onPage }) => {
      cursors.push([method, cursor]);
      await onPage([{}], `${method}-cursor`);
      return `${method}-cursor`;
    }
  };
  const salesFunnelService = { getCatalog: async () => [{ nmId: 1, title: 'Пылесос', stockWb: 5, stockMp: 0 }] };
  const advertisingService = {
    getDailySpend: async ({ dateFrom, dateTo, onChunk }) => {
      adPeriods.push([dateFrom, dateTo]);
      await onChunk({ period: { from: dateFrom, to: dateTo }, rows: [], currency: 'KZT' });
    }
  };
  const financeCalls = [];
  const financeService = {
    getDetailedReportPage: async ({ dateFrom, dateTo, rrdId }) => {
      financeCalls.push([dateFrom, dateTo, rrdId]);
      // Первая страница свежего отрезка полная — сервис должен попросить продолжение.
      if (dateTo === '2026-10-30' && rrdId === 0) {
        return { currency: 'KZT', nextRrdId: 10, rows: [{ rrdId: 10, date: '2026-10-20', currency: 'KZT', vendorCode: 'A', operation: 'Продажа', quantity: 2, logistics: 0 }] };
      }
      if (dateTo === '2026-10-30') return { currency: 'KZT', nextRrdId: null, rows: [{ rrdId: 11, date: '2026-10-21', currency: 'KZT', vendorCode: 'A', operation: 'Логистика', quantity: 0, logistics: 300 }] };
      return { currency: 'KZT', nextRrdId: null, rows: [] };
    }
  };
  const waits = [];
  const logger = { info() {}, warn() {}, error() {} };
  const sync = createRnpSyncService({
    repository, statisticsService, salesFunnelService, advertisingService, financeService, logger,
    now: () => new Date('2026-10-30T09:00:00Z'),
    wait: async ms => waits.push(ms)
  });

  await sync.syncUser(1);
  assert.deepEqual(cursors, [['orders', '2026-08-02T00:00:00'], ['sales', '2026-08-02T00:00:00']]);
  assert.deepEqual(adPeriods, [['2026-08-02', '2026-10-30']]);
  assert.equal(repository.state.sync.status, 'idle');
  assert.equal(repository.state.sync.ads_synced_to, '2026-10-30');
  assert.equal(repository.state.sync.ads_from, '2026-08-02');
  assert.ok(repository.state.sync.last_success_at);

  // Финотчёт: свежие 92 дня по страницам, затем три куска истории от новых к старым.
  assert.deepEqual(financeCalls, [
    ['2026-07-31', '2026-10-30', 0], ['2026-07-31', '2026-10-30', 10],
    ['2026-04-30', '2026-07-30', 0], ['2026-01-28', '2026-04-29', 0], ['2025-10-28', '2026-01-27', 0]
  ]);
  assert.ok(waits.every(ms => ms === 61_000) && waits.length === 4, 'между запросами к Finance API — минута');
  assert.equal(repository.state.sync.finance_from, '2025-10-28');
  assert.equal(repository.state.sync.finance_to, '2026-10-30');
  assert.equal(repository.state.sync.finance_currency, 'KZT');
  // Логистика на выкуп — из сохранённых строк: 300 ₸ на 2 выкупа.
  assert.equal(repository.state.sync.unit_costs.shopPerUnit, 150);

  await sync.syncUser(1);
  assert.deepEqual(cursors.slice(2), [['orders', 'orders-cursor'], ['sales', 'sales-cursor']]);
  assert.deepEqual(adPeriods[1], [addDays('2026-10-30', -2), '2026-10-30']);
  assert.deepEqual(financeCalls.slice(5).map(call => [call[0], call[1]]), [
    ['2026-10-16', '2026-10-30'], ['2026-10-16', '2026-10-30'],
    ['2025-07-28', '2025-10-27'], ['2025-04-27', '2025-07-27'], ['2025-01-25', '2025-04-26']
  ], 'дальше — только последние 14 дней и продолжение истории');
  assert.equal(repository.state.sync.finance_from, '2025-01-25');
  assert.equal(repository.state.calls.filter(call => call === 'reset').length, 1);
  assert.deepEqual(repository.state.calls.filter(call => call[0] === 'stocks'), [['stocks', 1], ['stocks', 1]], 'остатки обновляются при каждой загрузке');
  assert.ok(repository.state.sync.stocks_at);
  for (const field of ['orders_at', 'sales_at', 'ads_at', 'stocks_at', 'finance_at', 'unit_costs_at']) assert.ok(repository.state.sync[field], field);
});

test('sync keeps orders when ads fail and records a readable error when statistics fail', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const repository = fakeRepository();
  const okStatistics = { loadSince: async ({ onPage }) => { await onPage([], 'c'); return 'c'; } };
  const failingAds = { getDailySpend: async () => { throw Object.assign(new Error('В токене WB нет доступа «Продвижение».'), { status: 403 }); } };
  const finance = { getDetailedReportPage: async () => { throw Object.assign(new Error('В токене WB нет доступа к категории «Финансы».'), { status: 403 }); } };
  await createRnpSyncService({ repository, statisticsService: okStatistics, advertisingService: failingAds, financeService: finance, logger }).syncUser(1);
  assert.equal(repository.state.sync.status, 'idle');
  assert.match(repository.state.sync.ads_error, /Продвижение/);
  assert.equal(repository.state.sync.progress.steps.ads, 'error');
  assert.equal(repository.state.sync.progress.steps.stocks, 'error', 'без отчёта об остатках загрузка не падает');
  assert.ok(repository.state.sync.stocks_error);
  assert.match(repository.state.sync.finance_error, /Финансы/);
  assert.match(repository.state.sync.costs_error, /Финансы/, 'без финотчёта логистику не считаем и объясняем почему');

  const broken = fakeRepository();
  const failingStatistics = { loadSince: async () => { throw Object.assign(new Error('В токене WB нет доступа «Статистика».'), { status: 403 }); } };
  await createRnpSyncService({ repository: broken, statisticsService: failingStatistics, advertisingService: failingAds, financeService: finance, logger }).syncUser(1);
  assert.equal(broken.state.sync.status, 'error');
  assert.match(broken.state.sync.last_error, /Статистика/);
  assert.equal(broken.state.sync.progress.steps.orders, 'error');
});

test('requestSync refreshes stale data only and respects a manual refresh pause', () => {
  const now = new Date('2026-10-30T09:00:00Z');
  const repository = fakeRepository();
  const neverResolving = { loadSince: () => new Promise(() => {}) };
  const sync = createRnpSyncService({ repository, statisticsService: neverResolving, advertisingService: {}, financeService: {}, logger: { info() {}, warn() {}, error() {} }, now: () => now });
  const minutesAgo = minutes => ({ status: 'idle', last_success_at: new Date(now - minutes * 60_000).toISOString() });
  assert.equal(sync.requestSync(1, minutesAgo(10)), false);
  assert.equal(sync.requestSync(1, minutesAgo(3), { force: true }), false);
  assert.equal(sync.requestSync(1, { status: 'running' }), false);
  assert.equal(sync.requestSync(1, minutesAgo(31)), true);
  assert.equal(sync.isRunning(1), true);
  assert.equal(sync.requestSync(1, minutesAgo(31)), false, 'вторая загрузка не запускается');
});

test('days before the collected history are shown as missing, not as zero sales', () => {
  const report = buildRnpReport({
    dateFrom: '2026-07-30', dateTo: '2026-08-02', today: '2026-10-30', dataFrom: '2026-08-01',
    orders: [order('2026-08-01', 1, 100)]
  });
  assert.deepEqual(report.shop.map(day => day && day.ordersCount), [null, null, 1, 0]);
  assert.equal(report.period.elapsedDays, 2);
  assert.equal(report.kpi.ordersPerDay, 0.5);
});

test('monthly plan is split by day; the shop plan falls back to the sum of product plans', () => {
  const report = buildRnpReport({
    dateFrom: '2026-10-30', dateTo: '2026-11-01', today: '2026-10-31',
    orders: [order('2026-10-30', 1, 150), order('2026-10-31', 1, 50)],
    plans: [
      { month: '2026-10', nm_id: '1', orders_sum: '3100', orders_count: null },
      { month: '2026-11', nm_id: '1', orders_sum: '3000', orders_count: '30' }
    ]
  });
  const [product] = report.products;
  assert.deepEqual(product.plan.ordersSum, [100, 100, 100]);
  assert.deepEqual(product.plan.ordersCount, [null, null, 1]);
  assert.deepEqual(product.planSummary.ordersSum, { total: 300, toDate: 200, pct: 100 });
  assert.deepEqual(product.planSummary.ordersCount, { total: 1, toDate: 0, pct: null });
  assert.deepEqual(report.shopPlan.ordersSum, [100, 100, 100]);
  assert.equal(report.kpi.plan.derived, true);
  assert.equal(report.kpi.plan.ordersSum.pct, 100);
});

test('an explicit shop plan wins and products with a plan appear without sales', () => {
  const report = buildRnpReport({
    dateFrom: '2026-10-01', dateTo: '2026-10-01', today: '2026-10-01',
    plans: [
      { month: '2026-10', nm_id: '0', orders_sum: '31000', orders_count: '31' },
      { month: '2026-10', nm_id: '9', orders_sum: '310', orders_count: null }
    ]
  });
  assert.deepEqual(report.shopPlan.ordersSum, [1000]);
  assert.equal(report.kpi.plan.derived, false);
  assert.deepEqual(report.kpi.plan.ordersSum, { total: 1000, toDate: 1000, pct: 0 });
  assert.equal(report.products[0].nmId, 9);
  assert.equal(report.products[0].abc, 'C');
});

test('stock days left use recent daily orders; labels and unknown stock are passed through', () => {
  assert.deepEqual(stockInfo({ stock_wb: 26, stock_mp: '4' }, 28, 14), { quantity: 30, wb: 26, fbs: 4, avgDaily: 2, daysLeft: 15 });
  assert.equal(stockInfo({ stock_wb: 5 }, 0, 14).daysLeft, null, 'без заказов запас не считаем');
  const withStock = buildRnpReport({
    dateFrom: '2026-10-01', dateTo: '2026-10-01', today: '2026-10-01',
    orders: [order('2026-10-01', 1, 100), order('2026-10-01', 2, 100)],
    stocks: [{ nm_id: '1', title: 'Пылесос PURO', stock_wb: 7, stock_mp: 0 }], recentOrders: [{ nm_id: '1', orders: 14 }, { nm_id: '2', orders: 7 }],
    labels: [{ nm_id: '1', labels: ['хит'] }]
  });
  const byNm = Object.fromEntries(withStock.products.map(product => [product.nmId, product]));
  assert.equal(byNm[1].stock.daysLeft, 7);
  assert.equal(byNm[1].title, 'Пылесос PURO');
  assert.equal(byNm[2].stock.quantity, 0, 'товара нет в воронке — значит остаток 0');
  assert.equal(byNm[2].stock.daysLeft, 0);
  assert.deepEqual(byNm[1].labels, ['хит']);
  assert.equal(withStock.kpi.stockQuantity, 7);
  const noStock = buildRnpReport({ dateFrom: '2026-10-01', dateTo: '2026-10-01', today: '2026-10-01', orders: [order('2026-10-01', 1, 100)] });
  assert.equal(noStock.products[0].stock, null);
  assert.equal(noStock.kpi.stockKnown, false);
});

test('funnel stocks and product cards are read from the WB sales funnel', () => {
  assert.deepEqual(funnelStocks({ wb: 12, mp: 3, balanceSum: 900 }), { wb: 12, mp: 3 });
  assert.deepEqual(funnelStocks(7), { wb: 7, mp: 0 });
  assert.deepEqual(funnelStocks(null), { wb: 0, mp: 0 });
  assert.deepEqual(normalizeFunnelProduct({ product: { nmId: 5, title: ' Пылесос ', vendorCode: 'fx-200', brandName: 'PURO', subjectName: 'Пылесосы', stocks: { wb: -1, mp: 2 } } }), {
    nmId: 5, title: 'Пылесос', vendorCode: 'fx-200', brand: 'PURO', subject: 'Пылесосы', stockWb: 0, stockMp: 2
  });
  assert.equal(normalizeFunnelProduct({ product: {} }), null);
});

test('plan items and labels are validated and normalized', () => {
  assert.deepEqual(parsePlanItems([{ nmId: 0, ordersSum: '1500000.4', ordersCount: '' }, { nmId: '5', ordersSum: null, ordersCount: 10 }]), [
    { nmId: 0, ordersSum: 1500000, ordersCount: null },
    { nmId: 5, ordersSum: null, ordersCount: 10 }
  ]);
  assert.throws(() => parsePlanItems([{ nmId: 1, ordersSum: -5 }]), /неотрицательным/);
  assert.throws(() => parsePlanItems([{ nmId: 'x' }]), /артикул/);
  assert.throws(() => parsePlanItems('nope'), /список/);
  assert.deepEqual(parseLabels([' Хит ', 'хит', '', 'Новинка   осень', 'x'.repeat(40)]), ['Хит', 'Новинка осень', 'x'.repeat(30)]);
  assert.deepEqual(monthsOf('2026-11-15', '2027-01-02'), ['2026-11', '2026-12', '2027-01']);
});

test('brands, timing and geography are built from the same stored orders', () => {
  const report = buildRnpReport({
    dateFrom: '2026-11-02', dateTo: '2026-11-04', today: '2026-11-03',
    orders: [
      // 2 ноября 2026 — понедельник.
      order('2026-11-02', 1, 100, { order_date: '2026-11-02T09:15:00', region: 'Алматы', warehouse: 'Астана' }),
      order('2026-11-02', 2, 300, { order_date: '2026-11-02T09:40:00', region: 'Алматы', warehouse: 'Коледино', is_cancel: true }),
      order('2026-11-03', 3, 50, { order_date: '2026-11-03T23:05:00', brand: '', region: '', warehouse: 'Астана' }),
      order('2026-11-01', 1, 999, { order_date: '2026-11-01T10:00:00', region: 'Вне периода' })
    ],
    sales: [sale('2026-11-03', 1, 100, 80)]
  });

  assert.deepEqual(report.brands.map(brand => [brand.brand, brand.productCount, brand.totals.ordersCount]), [['PURO', 2, 2], ['Без бренда', 1, 1]]);
  assert.equal(report.brands[0].days[1].buyoutsCount, 1);
  assert.equal(report.brands[0].days[2], null, 'будущий день бренда пустой');

  assert.equal(report.timing.counts[0][9], 2, 'понедельник, 9 часов');
  assert.equal(report.timing.sums[0][9], 400);
  assert.equal(report.timing.counts[1][23], 1, 'вторник, 23 часа');
  assert.deepEqual(report.timing.weekdayDays, [1, 1, 0, 0, 0, 0, 0]);

  assert.deepEqual(report.geography.regions.rows, [
    { name: 'Алматы', ordersCount: 2, ordersSum: 400, cancelCount: 1, share: 66.67, cancelPct: 50 },
    { name: 'Не указан', ordersCount: 1, ordersSum: 50, cancelCount: 0, share: 33.33, cancelPct: 0 }
  ]);
  assert.equal(report.geography.warehouses.rows[0].name, 'Астана');
  assert.equal(report.geography.warehouses.total, 3);
});

test('geography folds the long tail into one row', () => {
  const orders = Array.from({ length: 35 }, (_, index) => order('2026-11-02', 1, 10, { region: `Регион ${index}` }));
  const report = buildRnpReport({ dateFrom: '2026-11-02', dateTo: '2026-11-02', today: '2026-11-02', orders });
  const rows = report.geography.regions.rows;
  assert.equal(rows.length, 31);
  assert.deepEqual([rows[30].name, rows[30].ordersCount, rows[30].other], ['Остальные (5)', 5, true]);
  assert.equal(report.geography.regions.count, 35);
});

test('sourceTimes reports when each WB source was loaded and how fresh WB data is', () => {
  const sources = sourceTimes({
    orders_at: '2026-11-05T05:05:00Z', orders_cursor: '2026-11-05T09:52:00',
    sales_at: null, sales_cursor: null,
    stocks_at: '2026-11-05T05:06:00Z', stocks_error: null,
    ads_at: '2026-11-05T05:07:00Z', ads_synced_to: '2026-11-05', ads_error: null,
    unit_costs_at: null, costs_error: 'В токене WB нет доступа к категории «Финансы».'
  });
  assert.deepEqual(sources.orders, { loadedAt: '2026-11-05T05:05:00.000Z', wbChangedAt: '2026-11-05T09:52:00' });
  assert.deepEqual(sources.sales, { loadedAt: null, wbChangedAt: null });
  assert.equal(sources.ads.through, '2026-11-05');
  assert.match(sources.costs.error, /Финансы/);
  assert.equal(sourceTimes(null).orders.loadedAt, null);
});

test('finance history stops at the oldest period WB still serves', async () => {
  const repository = fakeRepository({ finance_from: '2026-04-30', finance_to: '2026-10-29' });
  const calls = [];
  const financeService = {
    getDetailedReportPage: async ({ dateFrom }) => {
      calls.push(dateFrom);
      if (dateFrom < '2026-04-30') throw Object.assign(new Error('WB отклонил период финансового отчёта.'), { code: 'WB_FINANCE_400', status: 400 });
      return { rows: [], currency: 'KZT', nextRrdId: null };
    }
  };
  const ok = { loadSince: async ({ onPage }) => { await onPage([], 'c'); return 'c'; } };
  await createRnpSyncService({
    repository, statisticsService: ok, salesFunnelService: { getCatalog: async () => [] },
    advertisingService: { getDailySpend: async () => {} }, financeService,
    logger: { info() {}, warn() {}, error() {} }, now: () => new Date('2026-10-30T09:00:00Z'), wait: async () => {}
  }).syncUser(1);
  assert.deepEqual(calls, ['2026-10-15', '2026-01-28']);
  assert.equal(repository.state.sync.finance_from, addDays('2026-10-30', -729), 'дальше в прошлое больше не просим');
  assert.equal(repository.state.sync.progress.steps.finance, 'done');
});

test('import percent weighs the slow steps and never shows 100 before the end', () => {
  assert.equal(importPercent({}), 0);
  assert.equal(importPercent({ steps: { orders: 'done', sales: 'running' } }), 23);
  assert.equal(importPercent({ steps: { orders: 'done', sales: 'done', stocks: 'error', ads: 'done', finance: 'done', costs: 'done' } }), 99);
});

test('status shows the RNP table once orders and sales are in, while the import goes on', async () => {
  const statusOf = async (sync, running) => {
    let body;
    const controller = createRnpController({
      repository: { getSync: async () => sync, dataRange: async () => null },
      syncService: { isRunning: () => running },
      getRubKztRate: async () => 5
    });
    await controller.status({ user: { id: 1 } }, { json: value => { body = value; } });
    return body.sync;
  };
  const progress = { steps: { orders: 'done', sales: 'done', stocks: 'running' } };
  const loading = await statusOf({ status: 'running', progress, orders_at: '2026-11-09T05:00:00Z', sales_at: '2026-11-09T05:01:00Z' }, true);
  assert.deepEqual([loading.initial, loading.importing, loading.percent], [false, true, 33]);
  const fresh = await statusOf({ status: 'running', progress: { steps: { orders: 'running' } } }, true);
  assert.deepEqual([fresh.initial, fresh.importing, fresh.percent], [true, true, 8]);
  const done = await statusOf({ status: 'idle', last_success_at: '2026-11-09T05:08:00Z', orders_at: '2026-11-09T05:00:00Z', sales_at: '2026-11-09T05:01:00Z' }, false);
  assert.deepEqual([done.initial, done.importing, done.percent], [false, false, 100]);
  const none = await statusOf(null, false);
  assert.deepEqual([none.status, none.importing], ['idle', true], 'без загрузки индикатор не показываем: статус не running');
});
