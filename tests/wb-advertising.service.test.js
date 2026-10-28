const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAdvertisingCampaigns,
  resolveAdvertisingCurrency,
  createAdvertisingStatsService,
  splitAdvertisingPeriod,
  FULLSTATS_INTERVAL_MS
} = require('../src/services/wb-advertising.service');

test('extractAdvertisingCampaigns supports current flat campaign schema', () => {
  const campaigns = extractAdvertisingCampaigns({ adverts: [{
    id: 39624033,
    currency: 'KZT',
    status: 11,
    settings: { name: 'Кампания от 20.08.2026' },
    nm_settings: [{ nm_id: 1429883545 }]
  }] });

  assert.deepEqual(campaigns, [{
    id: 39624033,
    name: 'Кампания от 20.08.2026',
    status: 11,
    type: null,
    currency: 'KZT',
    nmIds: [1429883545]
  }]);
});

test('extractAdvertisingCampaigns keeps compatibility with grouped schema', () => {
  const campaigns = extractAdvertisingCampaigns({ adverts: [{
    type: 9,
    status: 7,
    currency: 'RUB',
    advert_list: [{ advertId: 10, name: 'Поиск' }]
  }] });

  assert.equal(campaigns[0].id, 10);
  assert.equal(campaigns[0].type, 9);
  assert.equal(campaigns[0].currency, 'RUB');
});

test('resolveAdvertisingCurrency uses campaign currency or a single account currency', () => {
  assert.equal(resolveAdvertisingCurrency({ currency: 'KZT' }, ['RUB']), 'KZT');
  assert.equal(resolveAdvertisingCurrency({}, ['KZT', 'KZT']), 'KZT');
  assert.throws(() => resolveAdvertisingCurrency({}, ['KZT', 'RUB']), /однозначно определить валюту/);
});

test('splitAdvertisingPeriod keeps WB advert requests within 31 days', () => {
  assert.deepEqual(splitAdvertisingPeriod('2026-10-01', '2026-10-28'), [{ from: '2026-10-01', to: '2026-10-28' }]);
  assert.deepEqual(splitAdvertisingPeriod('2026-07-28', '2026-10-28'), [
    { from: '2026-07-28', to: '2026-08-27' },
    { from: '2026-08-28', to: '2026-09-27' },
    { from: '2026-09-28', to: '2026-10-28' }
  ]);
});

test('getPeriodStats sums fullstats like the WB Promotion statistics page', async () => {
  const requests = [];
  const waits = [];
  const ids = Array.from({ length: 50 }, (_, index) => index + 1);
  const fetchImpl = async url => {
    requests.push(url);
    const body = url.includes('/api/advert/v2/adverts')
      ? { adverts: ids.map(id => ({ id, currency: 'KZT', status: id === 1 ? 7 : 11 })) }
      : url.includes('/adv/v1/upd')
        // Удалённая кампания 99 есть только в списаниях.
        ? [{ advertId: 99, updSum: 500 }, { advertId: 2, updSum: 100 }]
        : url.includes('ids=99')
          ? [{ advertId: 99, sum: 500.5, sum_price: 0, views: 10, clicks: 1, orders: 0 }]
          : [
            { advertId: 1, sum: 9775.67, sum_price: 0, views: 100, clicks: 4, orders: 0 },
            { advertId: 2, sum: 927279.24, sum_price: 10659396, views: 200000, clicks: 9000, orders: 150 },
            { advertId: 3, sum: 0, sum_price: 0, views: 0, clicks: 0, orders: 0 }
          ];
    return { ok: true, status: 200, json: async () => body };
  };
  const service = createAdvertisingStatsService({ fetchImpl, wait: async ms => { waits.push(ms); } });

  const result = await service.getPeriodStats({ token: 'token', dateFrom: '2026-10-01', dateTo: '2026-10-28' });

  assert.equal(result.currency, 'KZT');
  assert.equal(result.campaignCount, 3);
  assert.equal(Math.round(result.totals.spend * 100) / 100, 937555.41);
  assert.equal(result.totals.orderSum, 10659396);
  assert.equal(result.totals.views, 200110);
  assert.equal(requests.filter(url => url.includes('/adv/v3/fullstats')).length, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 19_000 && waits[0] <= FULLSTATS_INTERVAL_MS);
});

test('getPeriodStats reports a missing Promotion permission', async () => {
  const service = createAdvertisingStatsService({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(
    service.getPeriodStats({ token: 'token', dateFrom: '2026-10-01', dateTo: '2026-10-28' }),
    error => error.status === 403 && /Продвижение/.test(error.message)
  );
});

test('getPeriodStats tells how long WB asked to wait after a long rate limit', async () => {
  const service = createAdvertisingStatsService({
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '600' } }),
    wait: async () => assert.fail('не ждём 10 минут внутри запроса')
  });
  await assert.rejects(
    service.getPeriodStats({ token: 'token', dateFrom: '2026-10-01', dateTo: '2026-10-28' }),
    error => error.status === 429 && /через 10 мин/.test(error.message)
  );
});
