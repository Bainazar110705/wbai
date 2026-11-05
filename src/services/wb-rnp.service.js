// Расчёт РНП («Рука на пульсе») из сохранённых заказов, выкупов и рекламы.
// Чистая логика без БД и сети: на вход строки, на выход таблица по дням.
const { normalizeVendorCode } = require('./wb-finance.service');

const METRICS = [
  'ordersSum', 'ordersCount', 'cancelCount', 'buyoutsSum', 'buyoutsCount', 'returnsSum', 'returnsCount',
  'payout', 'cogs', 'wbCosts', 'adSpend'
];
const ABC_A_SHARE = 0.8;
const ABC_B_SHARE = 0.95;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function listDays(dateFrom, dateTo) {
  const days = [];
  const end = Date.parse(`${dateTo}T00:00:00.000Z`);
  for (let time = Date.parse(`${dateFrom}T00:00:00.000Z`); time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

function emptyMetrics() {
  return Object.fromEntries(METRICS.map(metric => [metric, 0]));
}

function percent(part, total) {
  return total ? round((part / total) * 100, 2) : null;
}

// Производные показатели. Прибыль — оценка: «к перечислению» по выкупам минус
// возвраты, себестоимость, логистика/хранение WB на выкуп и реклама.
function finalize(metrics, { future = false } = {}) {
  if (future) return null;
  const buyoutsNet = metrics.buyoutsSum - metrics.returnsSum;
  const hasMoneyFlow = metrics.buyoutsCount || metrics.returnsCount || metrics.adSpend;
  const profit = hasMoneyFlow ? metrics.payout - metrics.cogs - metrics.wbCosts - metrics.adSpend : null;
  return {
    ordersSum: round(metrics.ordersSum),
    ordersCount: metrics.ordersCount,
    cancelCount: metrics.cancelCount,
    buyoutsSum: round(metrics.buyoutsSum),
    buyoutsCount: metrics.buyoutsCount,
    returnsCount: metrics.returnsCount,
    buyoutPct: percent(metrics.buyoutsCount, metrics.buyoutsCount + metrics.returnsCount),
    adSpend: round(metrics.adSpend),
    drr: percent(metrics.adSpend, metrics.ordersSum),
    profit: profit === null ? null : round(profit),
    margin: profit === null || buyoutsNet <= 0 ? null : percent(profit, buyoutsNet)
  };
}

function addMetrics(target, source) {
  METRICS.forEach(metric => { target[metric] += source[metric]; });
}

function assignAbc(products) {
  const total = products.reduce((sum, product) => sum + product.raw.ordersSum, 0);
  let cumulative = 0;
  [...products].sort((a, b) => b.raw.ordersSum - a.raw.ordersSum).forEach(product => {
    const shareBefore = total ? cumulative / total : 1;
    cumulative += product.raw.ordersSum;
    product.abc = !product.raw.ordersSum ? 'C' : shareBefore < ABC_A_SHARE ? 'A' : shareBefore < ABC_B_SHARE ? 'B' : 'C';
  });
}

function daysInMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

const PLAN_FIELDS = [['ordersSum', 'orders_sum'], ['ordersCount', 'orders_count']];

// Месячный план делится поровну на дни месяца. Если плана магазина нет,
// планом магазина считается сумма планов товаров.
function buildPlans(planRows, days) {
  const byNm = new Map();
  for (const row of Array.isArray(planRows) ? planRows : []) {
    const nmId = number(row.nm_id);
    const months = byNm.get(nmId) || new Map();
    months.set(String(row.month), row);
    byNm.set(nmId, months);
  }
  const seriesFor = months => {
    if (!months) return null;
    const series = {};
    let any = false;
    for (const [field, column] of PLAN_FIELDS) {
      series[field] = days.map(day => {
        const row = months.get(day.slice(0, 7));
        const value = row?.[column];
        if (value === null || value === undefined || value === '') return null;
        any = true;
        return number(value) / daysInMonth(day.slice(0, 7));
      });
    }
    return any ? series : null;
  };
  const products = new Map();
  for (const [nmId, months] of byNm) if (nmId) products.set(nmId, seriesFor(months));

  let shop = seriesFor(byNm.get(0));
  if (!shop && products.size) {
    shop = {};
    for (const [field] of PLAN_FIELDS) {
      shop[field] = days.map((day, index) => {
        const values = [...products.values()].map(series => series?.[field][index]).filter(value => value !== null && value !== undefined);
        return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
      });
    }
    shop.derived = true;
  }
  return { shop, products };
}

// Выполнение плана: за весь период и на сегодня (только прошедшие дни).
function planSummary(series, fact, missing) {
  if (!series) return null;
  const summary = { derived: !!series.derived };
  for (const [field] of PLAN_FIELDS) {
    const values = series[field];
    if (!values.some(value => value !== null)) {
      summary[field] = null;
      continue;
    }
    const total = values.reduce((sum, value) => sum + (value || 0), 0);
    const toDate = values.reduce((sum, value, index) => sum + (missing[index] ? 0 : (value || 0)), 0);
    summary[field] = {
      total: round(total, field === 'ordersCount' ? 1 : 0),
      toDate: round(toDate, field === 'ordersCount' ? 1 : 0),
      pct: toDate ? round((fact[field] / toDate) * 100, 1) : null
    };
  }
  return summary;
}

function roundSeries(series) {
  if (!series) return null;
  return Object.fromEntries(PLAN_FIELDS.map(([field]) => [
    field,
    series[field].map(value => (value === null ? null : round(value, field === 'ordersCount' ? 2 : 0)))
  ]));
}

// Запас в днях = остаток (склады WB + свой склад FBS) / средние заказы в день за последние дни.
function stockInfo(stock, recentOrders, windowDays) {
  if (!stock) return null;
  const wb = number(stock.stock_wb);
  const fbs = number(stock.stock_mp);
  const avgDaily = windowDays ? recentOrders / windowDays : 0;
  return {
    quantity: wb + fbs,
    wb,
    fbs,
    avgDaily: round(avgDaily, 2),
    daysLeft: avgDaily > 0 ? Math.floor((wb + fbs) / avgDaily) : null
  };
}

const NO_BRAND = 'Без бренда';
const GEO_TOP = 30;

// Бренды: суммы товаров бренда по дням и за период.
function buildBrands(productList, days, isMissing) {
  const brands = new Map();
  for (const product of productList) {
    const name = product.brand || NO_BRAND;
    const brand = brands.get(name) || { brand: name, productCount: 0, days: days.map(emptyMetrics), raw: emptyMetrics() };
    brand.productCount++;
    product.days.forEach((metrics, index) => addMetrics(brand.days[index], metrics));
    addMetrics(brand.raw, product.raw);
    brands.set(name, brand);
  }
  return [...brands.values()]
    .sort((a, b) => b.raw.ordersSum - a.raw.ordersSum)
    .map(brand => ({
      brand: brand.brand,
      productCount: brand.productCount,
      totals: finalize(brand.raw),
      days: days.map((day, index) => finalize(brand.days[index], { future: isMissing(day) }))
    }));
}

// Тайминг: заказы по дню недели (0 = понедельник) и часу по московскому времени.
function buildTiming(orders, toKzt, isInPeriod) {
  const counts = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const sums = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const weekdayDays = Array.from({ length: 7 }, () => new Set());
  for (const row of orders) {
    const stamp = String(row.order_date);
    const day = stamp.slice(0, 10);
    if (!isInPeriod(day)) continue;
    const hour = Number(stamp.slice(11, 13));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const weekday = (new Date(`${day}T12:00:00.000Z`).getUTCDay() + 6) % 7;
    counts[weekday][hour]++;
    sums[weekday][hour] += toKzt(row.price_with_disc);
    weekdayDays[weekday].add(day);
  }
  return {
    timezone: 'Europe/Moscow',
    counts,
    sums: sums.map(row => row.map(value => round(value))),
    weekdayDays: weekdayDays.map(set => set.size)
  };
}

// География: регионы покупателей и склады отгрузки, крупные сверху.
function groupOrders(orders, keyOf, toKzt, isInPeriod) {
  const groups = new Map();
  let totalCount = 0;
  for (const row of orders) {
    if (!isInPeriod(String(row.order_date).slice(0, 10))) continue;
    const name = String(keyOf(row) || '').trim() || 'Не указан';
    const group = groups.get(name) || { name, ordersCount: 0, ordersSum: 0, cancelCount: 0 };
    group.ordersCount++;
    group.ordersSum += toKzt(row.price_with_disc);
    if (row.is_cancel) group.cancelCount++;
    groups.set(name, group);
    totalCount++;
  }
  const sorted = [...groups.values()].sort((a, b) => b.ordersCount - a.ordersCount || b.ordersSum - a.ordersSum);
  const top = sorted.slice(0, GEO_TOP);
  const rest = sorted.slice(GEO_TOP);
  if (rest.length) {
    top.push(rest.reduce((other, group) => ({
      name: `Остальные (${rest.length})`,
      ordersCount: other.ordersCount + group.ordersCount,
      ordersSum: other.ordersSum + group.ordersSum,
      cancelCount: other.cancelCount + group.cancelCount,
      other: true
    }), { ordersCount: 0, ordersSum: 0, cancelCount: 0 }));
  }
  return {
    total: totalCount,
    count: sorted.length,
    rows: top.map(group => ({
      ...group,
      ordersSum: round(group.ordersSum),
      share: percent(group.ordersCount, totalCount),
      cancelPct: percent(group.cancelCount, group.ordersCount)
    }))
  };
}

function buildRnpReport({
  dateFrom,
  dateTo,
  today,
  dataFrom = null,
  orders = [],
  sales = [],
  adSpend = [],
  costs = [],
  unitCosts = null,
  plans = [],
  stocks = null,
  recentOrders = [],
  stockWindowDays = 14,
  labels = [],
  statisticsToKzt = number,
  adsToKzt = number,
  financeToKzt = number
}) {
  const days = listDays(dateFrom, dateTo);
  const dayIndex = new Map(days.map((day, index) => [day, index]));
  const costByVendor = new Map(costs.map(row => [normalizeVendorCode(row.supplier_article), number(row.cost_price)]));
  const unitWbCost = vendorCode => financeToKzt(
    unitCosts?.byVendor?.[vendorCode] ?? unitCosts?.shopPerUnit ?? 0
  );
  const products = new Map();
  const shopDays = days.map(emptyMetrics);

  const productFor = row => {
    const nmId = number(row.nm_id);
    let product = products.get(nmId);
    if (!product) {
      product = { nmId, vendorCode: '', brand: '', subject: '', days: days.map(emptyMetrics), raw: emptyMetrics(), unpriced: false };
      products.set(nmId, product);
    }
    if (row.supplier_article) product.vendorCode = row.supplier_article;
    if (row.brand) product.brand = row.brand;
    if (row.subject) product.subject = row.subject;
    return product;
  };
  const add = (product, index, metric, value) => {
    product.days[index][metric] += value;
    shopDays[index][metric] += value;
  };

  for (const row of orders) {
    const index = dayIndex.get(String(row.order_date).slice(0, 10));
    if (index === undefined) continue;
    const product = productFor(row);
    add(product, index, 'ordersSum', statisticsToKzt(row.price_with_disc));
    add(product, index, 'ordersCount', 1);
    if (row.is_cancel) add(product, index, 'cancelCount', 1);
  }

  for (const row of sales) {
    const index = dayIndex.get(String(row.sale_date).slice(0, 10));
    if (index === undefined) continue;
    const product = productFor(row);
    const vendorCode = normalizeVendorCode(row.supplier_article);
    const unitCost = costByVendor.get(vendorCode) || 0;
    const payout = statisticsToKzt(row.for_pay);
    if (row.is_return) {
      add(product, index, 'returnsCount', 1);
      add(product, index, 'returnsSum', statisticsToKzt(row.price_with_disc));
      add(product, index, 'payout', -payout);
      add(product, index, 'cogs', -unitCost);
    } else {
      add(product, index, 'buyoutsCount', 1);
      add(product, index, 'buyoutsSum', statisticsToKzt(row.price_with_disc));
      add(product, index, 'payout', payout);
      add(product, index, 'cogs', unitCost);
      add(product, index, 'wbCosts', unitWbCost(vendorCode));
    }
    if (!unitCost) product.unpriced = true;
  }

  for (const row of adSpend) {
    const index = dayIndex.get(String(row.day).slice(0, 10));
    if (index === undefined) continue;
    const spend = adsToKzt(row.spend);
    // Расход без артикула входит только в итог магазина.
    if (number(row.nm_id)) add(productFor(row), index, 'adSpend', spend);
    else shopDays[index].adSpend += spend;
  }

  // Будущие дни и дни до начала собранной истории показываются как «нет данных».
  const isMissing = day => day > today || (dataFrom && day < dataFrom);
  const elapsedDays = days.filter(day => !isMissing(day)).length;
  const shopTotal = emptyMetrics();
  shopDays.forEach(metrics => addMetrics(shopTotal, metrics));

  const missing = days.map(isMissing);
  const inPeriod = day => dayIndex.has(day) && !isMissing(day);
  const planSeries = buildPlans(plans, days);
  const stockByNm = new Map((stocks || []).map(row => [number(row.nm_id), row]));
  const recentByNm = new Map(recentOrders.map(row => [number(row.nm_id), number(row.orders)]));
  const labelsByNm = new Map(labels.map(row => [number(row.nm_id), Array.isArray(row.labels) ? row.labels : []]));
  // Товар с планом показываем, даже если за период по нему не было движения.
  for (const nmId of planSeries.products.keys()) if (!products.has(nmId)) productFor({ nm_id: nmId });

  const productList = [...products.values()];
  productList.forEach(product => product.days.forEach(metrics => addMetrics(product.raw, metrics)));
  assignAbc(productList);

  const kpi = finalize(shopTotal);
  return {
    period: { dateFrom, dateTo, today, dataFrom, days, elapsedDays },
    kpi: {
      ...kpi,
      ordersPerDay: elapsedDays ? round(shopTotal.ordersCount / elapsedDays, 1) : 0,
      drrBuyouts: percent(shopTotal.adSpend, shopTotal.buyoutsSum),
      cpo: shopTotal.ordersCount ? round(shopTotal.adSpend / shopTotal.ordersCount) : null,
      cogsMissing: productList.some(product => product.unpriced),
      wbCostsKnown: !!unitCosts,
      plan: planSummary(planSeries.shop, shopTotal, missing),
      stockKnown: !!stocks,
      stockQuantity: stocks ? stocks.reduce((sum, row) => sum + number(row.stock_wb) + number(row.stock_mp), 0) : null
    },
    shopPlan: roundSeries(planSeries.shop),
    brands: buildBrands(productList, days, isMissing),
    timing: buildTiming(orders, statisticsToKzt, inPeriod),
    geography: {
      regions: groupOrders(orders, row => row.region, statisticsToKzt, inPeriod),
      warehouses: groupOrders(orders, row => row.warehouse, statisticsToKzt, inPeriod)
    },
    shop: days.map((day, index) => finalize(shopDays[index], { future: isMissing(day) })),
    products: productList
      .sort((a, b) => b.raw.ordersSum - a.raw.ordersSum || b.raw.buyoutsSum - a.raw.buyoutsSum)
      .map(product => {
        const totals = finalize(product.raw);
        // Название и пустые поля берём из карточки товара в воронке WB.
        const card = stockByNm.get(product.nmId);
        return {
          nmId: product.nmId,
          title: card?.title || '',
          vendorCode: product.vendorCode || card?.vendor_code || '',
          brand: product.brand || card?.brand || '',
          subject: product.subject || card?.subject || '',
          abc: product.abc,
          unpriced: product.unpriced,
          totals: {
            ...totals,
            ordersPerDay: elapsedDays ? round(product.raw.ordersCount / elapsedDays, 1) : 0,
            cpo: product.raw.ordersCount ? round(product.raw.adSpend / product.raw.ordersCount) : null
          },
          days: days.map((day, index) => finalize(product.days[index], { future: isMissing(day) })),
          plan: roundSeries(planSeries.products.get(product.nmId)),
          planSummary: planSummary(planSeries.products.get(product.nmId), product.raw, missing),
          stock: stocks ? stockInfo(card || {}, recentByNm.get(product.nmId) || 0, stockWindowDays) : null,
          labels: labelsByNm.get(product.nmId) || []
        };
      })
  };
}

module.exports = { buildRnpReport, buildPlans, planSummary, stockInfo, buildTiming, groupOrders, listDays, finalize };
