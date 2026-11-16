const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaidStorageService, aggregateStorageRows, splitStoragePeriod } = require('../src/services/wb-paid-storage.service');

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });

test('storage rows are summed per product and day', () => {
  assert.deepEqual(aggregateStorageRows([
    { date: '2026-10-21T00:00:00', nmId: 11, warehousePrice: 1.5 },
    { date: '2026-10-21', nmId: 11, warehousePrice: 2 },
    { date: '2026-10-21', nmId: 22, warehousePrice: 0 },
    { date: 'bad', nmId: 11, warehousePrice: 9 }
  ]), [{ day: '2026-10-21', nmId: 11, cost: 3.5 }]);
});

test('storage periods are split into reports of at most 8 days', () => {
  assert.deepEqual(splitStoragePeriod('2026-10-01', '2026-10-17'), [
    { from: '2026-10-01', to: '2026-10-08' }, { from: '2026-10-09', to: '2026-10-16' }, { from: '2026-10-17', to: '2026-10-17' }
  ]);
});

test('a storage report is created, awaited and downloaded', async () => {
  const urls = [];
  const statuses = ['processing', 'done'];
  const service = createPaidStorageService({
    wait: async () => {},
    fetchImpl: async url => {
      urls.push(url.replace('https://seller-analytics-api.wildberries.ru/api/v1/paid_storage', ''));
      if (url.includes('/download')) return json(200, [{ date: '2026-10-21', nmId: 11, warehousePrice: 4 }]);
      if (url.includes('/status')) return json(200, { data: { status: statuses.shift() } });
      return json(200, { data: { taskId: 'abc' } });
    }
  });
  const rows = await service.getChunk({ token: 't', dateFrom: '2026-10-21', dateTo: '2026-10-28' });
  assert.deepEqual(rows, [{ day: '2026-10-21', nmId: 11, cost: 4 }]);
  assert.deepEqual(urls, ['?dateFrom=2026-10-21&dateTo=2026-10-28', '/tasks/abc/status', '/tasks/abc/status', '/tasks/abc/download']);
});

test('missing Analytics access gives a readable error', async () => {
  const service = createPaidStorageService({ wait: async () => {}, fetchImpl: async () => json(403, {}) });
  await assert.rejects(service.getChunk({ token: 't', dateFrom: '2026-10-21', dateTo: '2026-10-28' }), /Аналитика/);
});
