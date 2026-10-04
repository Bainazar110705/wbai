const SALES_FUNNEL_URL = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';
const PAGE_SIZE = 1000;
const PAGE_DELAY_MS = 20_100;

function wbAnalyticsError(status) {
  const messages = {
    400: 'Некорректный период для аналитики WB.',
    401: 'Токен WB недействителен. Создайте новый токен.',
    402: 'Метод аналитики WB недоступен для этого кабинета.',
    403: 'В токене WB нет доступа к категории «Аналитика». Пересоздайте токен с доступами «Аналитика» и «Статистика».',
    429: 'Лимит запросов WB API. Подождите минуту.'
  };
  const error = new Error(messages[status] || `WB Analytics API вернул ошибку ${status}`);
  error.status = status;
  error.needsAnalyticsPermission = status === 403;
  return error;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateProducts(products) {
  return products.reduce((result, item) => {
    const selected = item?.statistic?.selected || {};
    const past = item?.statistic?.past || {};
    result.current.orders += number(selected.orderCount);
    result.current.revenue += number(selected.orderSum);
    result.previous.orders += number(past.orderCount);
    result.previous.revenue += number(past.orderSum);
    return result;
  }, {
    current: { orders: 0, revenue: 0 },
    previous: { orders: 0, revenue: 0 }
  });
}

function productOrderMetrics(products) {
  return products.map(item => ({
    nmId: number(item?.product?.nmId),
    vendorCode: String(item?.product?.vendorCode || '').trim(),
    currentOrders: number(item?.statistic?.selected?.orderCount),
    previousOrders: number(item?.statistic?.past?.orderCount)
  })).filter(item => item.nmId || item.vendorCode);
}

function calculateProductCogs(productMetrics, costsByVendorCode, field = 'currentOrders') {
  return (Array.isArray(productMetrics) ? productMetrics : []).reduce((sum, metric) => {
    const vendorCode = String(metric?.vendorCode || '').trim();
    const unitCost = number(costsByVendorCode?.[vendorCode]);
    return sum + unitCost * number(metric?.[field]);
  }, 0);
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function splitPeriod(period, requestedBuckets = 3) {
  const start = parseIsoDate(period?.start);
  const end = parseIsoDate(period?.end);
  if (!start || !end || start > end) throw new Error('Некорректный период для графика WB.');

  const days = Math.floor((end - start) / 86400000) + 1;
  const bucketCount = Math.max(1, Math.min(days, Math.trunc(requestedBuckets) || 1));
  const baseSize = Math.floor(days / bucketCount);
  const remainder = days % bucketCount;
  const ranges = [];
  let cursor = new Date(start);

  for (let index = 0; index < bucketCount; index++) {
    const size = baseSize + (index < remainder ? 1 : 0);
    const bucketStart = new Date(cursor);
    const bucketEnd = new Date(cursor);
    bucketEnd.setUTCDate(bucketEnd.getUTCDate() + size - 1);
    ranges.push({
      start: bucketStart.toISOString().slice(0, 10),
      end: bucketEnd.toISOString().slice(0, 10)
    });
    cursor.setUTCDate(cursor.getUTCDate() + size);
  }

  return ranges;
}

function metricKey(metric) {
  return metric.nmId ? `nm:${metric.nmId}` : `vendor:${metric.vendorCode}`;
}

function deriveRemainingProductMetrics(totalMetrics, bucketMetrics) {
  const used = new Map();
  for (const metrics of bucketMetrics) {
    for (const metric of metrics) {
      const key = metricKey(metric);
      used.set(key, (used.get(key) || 0) + number(metric.currentOrders));
    }
  }
  return totalMetrics.map(metric => ({
    nmId: metric.nmId,
    vendorCode: metric.vendorCode,
    currentOrders: Math.max(0, number(metric.currentOrders) - (used.get(metricKey(metric)) || 0)),
    previousOrders: 0
  }));
}

function createSalesFunnelService({ fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  async function fetchPage({ token, selectedPeriod, pastPeriod, offset, limit = PAGE_SIZE }) {
    const request = () => fetchImpl(SALES_FUNNEL_URL, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        selectedPeriod,
        pastPeriod,
        nmIds: [],
        brandNames: [],
        subjectIds: [],
        tagIds: [],
        skipDeletedNm: false,
        orderBy: { field: 'orderSum', mode: 'desc' },
        limit,
        offset
      }),
      signal: AbortSignal.timeout(15_000)
    });

    let response = await request();
    if (response.status === 429) {
      await wait(PAGE_DELAY_MS);
      response = await request();
    }

    if (!response.ok) throw wbAnalyticsError(response.status);
    const payload = await response.json();
    const data = payload?.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.products)) {
      const error = new Error('Некорректный ответ WB Analytics. Попробуйте обновить данные позже.');
      error.status = 502;
      throw error;
    }
    return {
      products: data.products,
      currency: String(data.currency || '').toUpperCase()
    };
  }

  async function getProducts({ token, selectedPeriod, pastPeriod }) {
    const products = [];
    let currency = '';

    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (offset > 0) await wait(PAGE_DELAY_MS);
      const page = await fetchPage({ token, selectedPeriod, pastPeriod, offset });
      if (page.currency) {
        if (currency && currency !== page.currency) {
          throw new Error('Валюта в ответе WB Analytics изменилась между страницами.');
        }
        currency = page.currency;
      }
      products.push(...page.products);
      if (page.products.length < PAGE_SIZE) break;
    }

    return { products, currency: currency || 'RUB' };
  }

  async function getPeriodSummary({ token, selectedPeriod, pastPeriod }) {
    const report = await getProducts({ token, selectedPeriod, pastPeriod });
    return {
      ...aggregateProducts(report.products),
      currency: report.currency,
      productCount: report.products.length,
      productMetrics: productOrderMetrics(report.products)
    };
  }

  async function getPeriodBuckets({ token, selectedPeriod, totalSummary, bucketCount = 3 }) {
    const ranges = splitPeriod(selectedPeriod, bucketCount);
    if (ranges.length === 1) {
      return {
        currency: totalSummary.currency,
        buckets: [{
          ...ranges[0],
          orders: number(totalSummary.current?.orders),
          revenue: number(totalSummary.current?.revenue),
          productMetrics: totalSummary.productMetrics || []
        }]
      };
    }

    const buckets = [];
    for (const range of ranges.slice(0, -1)) {
      const summary = await getPeriodSummary({ token, selectedPeriod: range });
      if (summary.currency !== totalSummary.currency) {
        throw new Error('Валюта WB Analytics изменилась между частями периода.');
      }
      buckets.push({
        ...range,
        orders: number(summary.current.orders),
        revenue: number(summary.current.revenue),
        productMetrics: summary.productMetrics
      });
    }

    const usedOrders = buckets.reduce((sum, bucket) => sum + bucket.orders, 0);
    const usedRevenue = buckets.reduce((sum, bucket) => sum + bucket.revenue, 0);
    const remainingOrders = number(totalSummary.current?.orders) - usedOrders;
    const remainingRevenue = number(totalSummary.current?.revenue) - usedRevenue;
    if (remainingOrders < 0 || remainingRevenue < 0) {
      return {
        currency: totalSummary.currency,
        reconciled: false,
        buckets: [{
          start: selectedPeriod.start,
          end: selectedPeriod.end,
          orders: number(totalSummary.current?.orders),
          revenue: number(totalSummary.current?.revenue),
          productMetrics: totalSummary.productMetrics || []
        }]
      };
    }

    buckets.push({
      ...ranges[ranges.length - 1],
      orders: remainingOrders,
      revenue: remainingRevenue,
      productMetrics: deriveRemainingProductMetrics(
        totalSummary.productMetrics || [],
        buckets.map(bucket => bucket.productMetrics)
      )
    });
    return { currency: totalSummary.currency, reconciled: true, buckets };
  }

  async function validateAccess({ token, date }) {
    await fetchPage({
      token,
      selectedPeriod: { start: date, end: date },
      offset: 0,
      limit: 1
    });
  }

  return { getProducts, getPeriodSummary, getPeriodBuckets, validateAccess };
}

module.exports = {
  createSalesFunnelService,
  aggregateProducts,
  productOrderMetrics,
  calculateProductCogs,
  splitPeriod,
  deriveRemainingProductMetrics,
  wbAnalyticsError,
  SALES_FUNNEL_URL,
  PAGE_SIZE
};
