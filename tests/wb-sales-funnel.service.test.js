const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSalesFunnelService,
  aggregateProducts,
  calculateProductCogs,
  splitPeriod,
  PAGE_SIZE
} = require('../src/services/wb-sales-funnel.service');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('aggregateProducts sums selected and past funnel metrics', () => {
  const result = aggregateProducts([
    { statistic: { selected: { orderCount: 2, orderSum: 129702 }, past: { orderCount: 1, orderSum: 60000 } } },
    { statistic: { selected: { orderCount: 1, orderSum: 62494.53 }, past: { orderCount: 0, orderSum: 0 } } }
  ]);

  assert.deepEqual(result, {
    current: { orders: 3, revenue: 192196.53 },
    previous: { orders: 1, revenue: 60000 }
  });
});

test('getPeriodSummary preserves report currency and aggregates all pages', async () => {
  const requests = [];
  const firstPage = Array.from({ length: PAGE_SIZE }, () => ({
    statistic: { selected: { orderCount: 1, orderSum: 10 }, past: { orderCount: 0, orderSum: 0 } }
  }));
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.offset === 0) return jsonResponse(200, { data: { products: firstPage, currency: 'KZT' } });
    return jsonResponse(200, {
      data: {
        products: [{ statistic: { selected: { orderCount: 2, orderSum: 20 }, past: { orderCount: 1, orderSum: 5 } } }],
        currency: 'KZT'
      }
    });
  };
  const service = createSalesFunnelService({ fetchImpl, wait: async () => {} });

  const result = await service.getPeriodSummary({
    token: 'test-token',
    selectedPeriod: { start: '2026-10-04', end: '2026-10-04' },
    pastPeriod: { start: '2026-10-03', end: '2026-10-03' }
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].limit, PAGE_SIZE);
  assert.equal(requests[1].offset, PAGE_SIZE);
  assert.equal(result.currency, 'KZT');
  assert.equal(result.productCount, PAGE_SIZE + 1);
  assert.deepEqual(result.current, { orders: PAGE_SIZE + 2, revenue: PAGE_SIZE * 10 + 20 });
  assert.deepEqual(result.previous, { orders: 1, revenue: 5 });
});

test('getProducts returns the product records for filtering by monthly orders', async () => {
  const service = createSalesFunnelService({
    fetchImpl: async () => jsonResponse(200, {
      data: {
        products: [{ product: { vendorCode: 'PURO FX-201' }, statistic: { selected: { orderCount: 1 } } }],
        currency: 'KZT'
      }
    })
  });

  const result = await service.getProducts({
    token: 'test-token',
    selectedPeriod: { start: '2026-09-05', end: '2026-10-04' }
  });

  assert.equal(result.currency, 'KZT');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].product.vendorCode, 'PURO FX-201');
});

test('validateAccess sends a minimal request and identifies missing Analytics permission', async () => {
  let body;
  const service = createSalesFunnelService({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse(403, {});
    }
  });

  await assert.rejects(
    service.validateAccess({ token: 'test-token', date: '2026-10-04' }),
    error => error.status === 403 && error.needsAnalyticsPermission === true
  );
  assert.equal(body.limit, 1);
  assert.equal(body.pastPeriod, undefined);
});

test('getPeriodSummary retries one rate-limited WB request after the API interval', async () => {
  let requests = 0;
  const waits = [];
  const service = createSalesFunnelService({
    fetchImpl: async () => {
      requests++;
      if (requests === 1) return jsonResponse(429, {});
      return jsonResponse(200, { data: { products: [], currency: 'KZT' } });
    },
    wait: async milliseconds => { waits.push(milliseconds); }
  });

  const result = await service.getPeriodSummary({
    token: 'test-token',
    selectedPeriod: { start: '2026-10-04', end: '2026-10-04' }
  });

  assert.equal(requests, 2);
  assert.deepEqual(waits, [20_100]);
  assert.equal(result.currency, 'KZT');
});

test('splitPeriod creates balanced inclusive buckets without missing days', () => {
  assert.deepEqual(splitPeriod({ start: '2026-09-21', end: '2026-10-04' }, 3), [
    { start: '2026-09-21', end: '2026-09-25' },
    { start: '2026-09-26', end: '2026-09-30' },
    { start: '2026-10-01', end: '2026-10-04' }
  ]);
});

test('getPeriodBuckets reconciles bucket totals to the full-period summary', async () => {
  const responses = [
    {
      data: {
        products: [{
          product: { nmId: 1, vendorCode: 'A' },
          statistic: { selected: { orderCount: 3, orderSum: 300 } }
        }],
        currency: 'KZT'
      }
    },
    {
      data: {
        products: [{
          product: { nmId: 1, vendorCode: 'A' },
          statistic: { selected: { orderCount: 4, orderSum: 400 } }
        }],
        currency: 'KZT'
      }
    }
  ];
  const service = createSalesFunnelService({
    fetchImpl: async () => jsonResponse(200, responses.shift()),
    wait: async () => {}
  });

  const result = await service.getPeriodBuckets({
    token: 'token',
    selectedPeriod: { start: '2026-09-21', end: '2026-10-04' },
    totalSummary: {
      current: { orders: 10, revenue: 1000 },
      currency: 'KZT',
      productMetrics: [{ nmId: 1, vendorCode: 'A', currentOrders: 10, previousOrders: 0 }]
    }
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.buckets.length, 3);
  assert.deepEqual(result.buckets.map(bucket => bucket.orders), [3, 4, 3]);
  assert.deepEqual(result.buckets.map(bucket => bucket.revenue), [300, 400, 300]);
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.orders, 0), 10);
  assert.equal(result.buckets[2].productMetrics[0].currentOrders, 3);
});

test('calculateProductCogs uses funnel order counts and saved vendor costs', () => {
  const metrics = [
    { vendorCode: ' A ', currentOrders: 3, previousOrders: 2 },
    { vendorCode: 'B', currentOrders: 4, previousOrders: 1 },
    { vendorCode: 'UNKNOWN', currentOrders: 8, previousOrders: 8 }
  ];
  const costs = { A: 100, B: 250 };

  assert.equal(calculateProductCogs(metrics, costs), 1300);
  assert.equal(calculateProductCogs(metrics, costs, 'previousOrders'), 450);
});
