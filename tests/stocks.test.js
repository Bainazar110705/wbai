const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarketplaceService, parseStockConflicts } = require('../src/services/wb-marketplace.service');
const { createContentService, cardSizes } = require('../src/services/wb-content.service');
const { createStocksService, parseSaveItems } = require('../src/services/stocks.service');
const { matchImport, applyBulk, parseAmount, normBarcode } = require('../public/wbai-stocks.js');
const Xlsx = require('../public/wbai-xlsx.js');

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    json: async () => body
  };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const call = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return handler(call, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const noWait = async () => {};

test('409 conflicts: WB format is parsed into rows with a reason', () => {
  const failed = parseStockConflicts([
    { data: [{ sku: '', chrtId: 1, amount: 0 }], code: 'NotFound', message: 'Not found' },
    { data: [{ sku: '42', chrtId: 0, amount: 5 }], code: 'SomethingNew', message: 'Новая причина' }
  ]);
  assert.deepEqual(failed, [
    { chrtId: 1, sku: '', code: 'NotFound', message: 'Товар или размер не найден в карточках WB' },
    { chrtId: null, sku: '42', code: 'SomethingNew', message: 'Новая причина' }
  ]);
});

test('setStocks: chunks by 1000, drops rejected items and resends the rest', async () => {
  const items = Array.from({ length: 1500 }, (_, i) => ({ chrtId: i + 1, sku: `b${i + 1}`, amount: 3 }));
  const fetchImpl = fakeFetch(call => {
    const ids = call.body.stocks.map(s => s.chrtId);
    if (ids.includes(7)) return response(409, [{ data: [{ sku: 'b7', chrtId: 7, amount: 3 }], code: 'NotFound', message: 'Not found' }]);
    return response(204);
  });
  const service = createMarketplaceService({ fetchImpl, wait: noWait });
  const { saved, failed } = await service.setStocks('t', 55, items);
  assert.equal(saved.length, 1499);
  assert.deepEqual(failed.map(f => [f.chrtId, f.code]), [[7, 'NotFound']]);
  assert.equal(fetchImpl.calls.length, 3, 'пачка 1000 с ошибкой, повтор без неё, вторая пачка 500');
  assert.equal(fetchImpl.calls[0].url, 'https://marketplace-api.wildberries.ru/api/v3/stocks/55');
  assert.equal(fetchImpl.calls[0].method, 'PUT');
  assert.equal(fetchImpl.calls[0].body.stocks.length, 1000);
  assert.deepEqual(fetchImpl.calls[0].body.stocks[0], { chrtId: 1, amount: 3 });
  assert.equal(fetchImpl.calls[1].body.stocks.length, 999);
  assert.equal(fetchImpl.calls[2].body.stocks.length, 500);
});

test('setStocks: 409 without item data rejects the batch, 429 is retried, 403 explains the token', async () => {
  let n = 0;
  const service = createMarketplaceService({
    fetchImpl: fakeFetch(() => (++n === 1 ? response(429, {}, { 'x-ratelimit-retry': '1' }) : response(409, { code: 'UploadDataLimit', message: 'x' }))),
    wait: noWait
  });
  const result = await service.setStocks('t', 1, [{ chrtId: 5, amount: 1 }]);
  assert.equal(result.saved.length, 0);
  assert.equal(result.failed[0].code, 'UploadDataLimit');
  assert.equal(n, 2);

  const forbidden = createMarketplaceService({ fetchImpl: fakeFetch(() => response(403, {})), wait: noWait });
  await assert.rejects(forbidden.listWarehouses('t'), err => err.status === 403 && /Маркетплейс/.test(err.message));
  const invalid = createMarketplaceService({ fetchImpl: fakeFetch(() => response(401, {})), wait: noWait });
  await assert.rejects(invalid.getStocks('t', 1, [1]), err => err.status === 400);
});

test('getStocks reads by chrtId in chunks; missing positions are absent (treated as 0)', async () => {
  const fetchImpl = fakeFetch(call => response(200, { stocks: call.body.chrtIds.filter(id => id % 2).map(id => ({ chrtId: id, sku: `s${id}`, amount: id })) }));
  const service = createMarketplaceService({ fetchImpl, wait: noWait });
  const stocks = await service.getStocks('t', 9, Array.from({ length: 1200 }, (_, i) => i + 1));
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.equal(stocks.get(3).amount, 3);
  assert.equal(stocks.has(2), false);
});

test('warehouses: deleted ones are hidden', async () => {
  const service = createMarketplaceService({
    fetchImpl: fakeFetch(() => response(200, [
      { name: 'Алматы', officeId: 1, id: 10, cargoType: 1, deliveryType: 1, isDeleting: false },
      { name: 'Старый', id: 11, isDeleting: true }
    ])),
    wait: noWait
  });
  assert.deepEqual(await service.listWarehouses('t'), [{ id: 10, name: 'Алматы', officeId: 1, cargoType: 1, deliveryType: 1 }]);
});

test('content: all card pages are loaded, sizes carry chrtId and barcodes', async () => {
  const card = (nm, sizes) => ({ nmID: nm, vendorCode: `v${nm}`, title: 'Платье', brand: 'B', subjectName: 'Платья', photos: [{ c246x328: 'p.webp' }], sizes });
  let page = 0;
  const fetchImpl = fakeFetch(call => {
    page++;
    if (page === 1) {
      assert.deepEqual(call.body.settings.cursor, { limit: 100 });
      return response(200, { cards: Array.from({ length: 100 }, (_, i) => card(i + 1, [{ chrtID: 1000 + i, techSize: 'M', skus: [`b${i}`] }])), cursor: { updatedAt: 'u1', nmID: 100, total: 100 } });
    }
    assert.deepEqual(call.body.settings.cursor, { limit: 100, updatedAt: 'u1', nmID: 100 });
    return response(200, { cards: [card(500, [{ chrtID: 7, techSize: '0', skus: ['x'] }, { chrtID: 0, skus: [] }])], cursor: { total: 1 } });
  });
  const rows = await createContentService({ fetchImpl, wait: noWait }).listSizes('t');
  assert.equal(rows.length, 101, 'размер без chrtID пропускаем');
  assert.deepEqual(rows[100], { nmId: 500, vendorCode: 'v500', title: 'Платье', brand: 'B', subject: 'Платья', photo: 'p.webp', size: '0', chrtId: 7, skus: ['x'] });
  assert.equal(cardSizes({}).length, 0);
});

test('save validation: integers 0…100000, no empty list, duplicates collapse', () => {
  assert.throws(() => parseSaveItems([]), { status: 400 });
  assert.throws(() => parseSaveItems([{ chrtId: 1, amount: -1 }]), { status: 400 });
  assert.throws(() => parseSaveItems([{ chrtId: 1, amount: 1.5 }]), { status: 400 });
  assert.throws(() => parseSaveItems([{ chrtId: 1, amount: 100001 }]), { status: 400 });
  assert.throws(() => parseSaveItems([{ chrtId: 'abc', amount: 1 }]), { status: 400 });
  assert.throws(() => parseSaveItems(Array.from({ length: 10001 }, (_, i) => ({ chrtId: i + 1, amount: 1 }))), { status: 400 });
  assert.deepEqual(parseSaveItems([{ chrtId: 1, amount: 2 }, { chrtId: '1', amount: 5 }]), [{ chrtId: 1, amount: 5 }]);
});

function stocksFixture({ current = { 1: 5, 2: 0, 3: 7 }, rejected = [] } = {}) {
  const wbStock = { ...current };
  const batches = [];
  const marketplace = {
    listWarehouses: async () => [{ id: 10, name: 'Алматы', deliveryType: 1 }, { id: 20, name: 'Астана', deliveryType: 1 }],
    getStocks: async (token, warehouseId, ids) => new Map(ids.filter(id => wbStock[id] !== undefined).map(id => [id, { sku: `b${id}`, amount: wbStock[id] }])),
    setStocks: async (token, warehouseId, items) => {
      const saved = items.filter(item => !rejected.includes(item.chrtId));
      saved.forEach(item => { wbStock[item.chrtId] = item.amount; });
      return { saved, failed: items.filter(item => rejected.includes(item.chrtId)).map(item => ({ ...item, code: 'NotFound', message: 'нет' })) };
    }
  };
  const content = {
    listSizes: async () => [1, 2, 3].map(id => ({ nmId: 100 + id, vendorCode: `v${id}`, title: 't', brand: '', subject: '', photo: '', size: 'M', chrtId: id, skus: [`b${id}`] }))
  };
  const repository = {
    wbStocks: async () => new Map([[101, 40]]),
    createBatch: async batch => { const row = { id: batches.length + 1, ...batch, created_at: new Date().toISOString(), undone_at: null }; batches.push(row); if (batch.undoOf) batches.find(b => b.id === batch.undoOf).undone_at = 'now'; return row; },
    findBatch: async (shopId, id) => {
      const b = batches.find(x => x.id === id && x.shopId === shopId);
      return b && { id: b.id, warehouse_id: b.warehouseId, undo_of: b.undoOf, undone_at: b.undone_at };
    },
    latestBatchId: async (shopId, warehouseId) => [...batches].reverse().find(b => b.shopId === shopId && b.warehouseId === Number(warehouseId))?.id || null,
    batchItems: async id => batches.find(b => b.id === id).items.map(item => ({ chrt_id: item.chrtId, amount_before: item.before, amount_after: item.after, sku: item.sku, nm_id: item.nmId, vendor_code: item.vendorCode, size: item.size })),
    listBatches: async () => batches
  };
  const service = createStocksService({ repository, marketplace, content });
  return { service, wbStock, batches, shop: { id: 1, token: 'token-abcdef123456' } };
}

test('list: every size with its stock on the warehouse, WB stock for reference', async () => {
  const { service, shop } = stocksFixture({ current: { 1: 5 } });
  const { items, warehouse } = await service.list(shop, '10');
  assert.equal(warehouse.name, 'Алматы');
  assert.deepEqual(items.map(i => [i.chrtId, i.amount, i.wbStock]), [[1, 5, 40], [2, 0, null], [3, 0, null]]);
  await assert.rejects(service.list(shop, 999), { status: 404 });
});

test('save: only real changes go to WB; unknown and rejected sizes are reported; history keeps before/after', async () => {
  const { service, shop, batches, wbStock } = stocksFixture({ rejected: [3] });
  const result = await service.save(shop, 9, { warehouseId: 10, source: 'import', items: [{ chrtId: 1, amount: 5 }, { chrtId: 2, amount: 4 }, { chrtId: 3, amount: 1 }, { chrtId: 77, amount: 1 }] });
  assert.equal(result.saved, 1);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.failed.map(f => [f.chrtId, f.code]), [[77, 'NotInCards'], [3, 'NotFound']]);
  assert.equal(wbStock[2], 4);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].source, 'import');
  assert.deepEqual(batches[0].items.map(i => [i.chrtId, i.before, i.after, i.vendorCode]), [[2, 0, 4, 'v2']]);
  await assert.rejects(service.save(shop, 9, { warehouseId: 999, items: [{ chrtId: 1, amount: 1 }] }), { status: 404 });
});

test('undo: restores only positions nobody changed since; only the latest save per warehouse', async () => {
  const { service, shop, wbStock } = stocksFixture({ current: { 1: 5, 2: 0, 3: 7 } });
  const first = await service.save(shop, 9, { warehouseId: 10, items: [{ chrtId: 1, amount: 1 }] });
  const second = await service.save(shop, 9, { warehouseId: 10, items: [{ chrtId: 2, amount: 3 }, { chrtId: 3, amount: 9 }] });
  await assert.rejects(service.undo(shop, 9, first.batchId), { status: 409 });
  wbStock[3] = 11; // поменяли в WB Partners после сохранения
  const undo = await service.undo(shop, 9, second.batchId);
  assert.equal(undo.saved, 1);
  assert.equal(undo.skipped, 1);
  assert.equal(wbStock[2], 0);
  assert.equal(wbStock[3], 11);
  await assert.rejects(service.undo(shop, 9, second.batchId), { status: 409 });
  await assert.rejects(service.undo(shop, 9, undo.batchId), { status: 409 });
  await assert.rejects(service.undo({ id: 2, token: 'other-token-xx' }, 9, second.batchId), { status: 404 });
});

const ITEMS = [
  { chrtId: 1, nmId: 101, vendorCode: 'FX-200', size: 'M', sku: '2062619127170', skus: ['2062619127170'], amount: 5 },
  { chrtId: 2, nmId: 101, vendorCode: 'FX-200', size: 'L', sku: '2062619127171', skus: ['2062619127171', '999'], amount: 0 },
  { chrtId: 3, nmId: 102, vendorCode: 'fx-201', size: '0', sku: '2054816631789', skus: ['2054816631789'], amount: 2 }
];

test('import: our own export round-trips through xlsx', async () => {
  const bytes = Xlsx.writeXlsx([
    ['Баркод', 'Артикул продавца', 'Размер', 'Название', 'Артикул WB', 'Остаток'],
    ['2062619127170', 'FX-200', 'M', 'Платье <красное> & "новое"', 101, 7],
    ['2054816631789', 'fx-201', '', 'Брюки', 102, 0]
  ]);
  const rows = await Xlsx.readXlsx(bytes.buffer);
  assert.equal(rows[1][3], 'Платье <красное> & "новое"');
  const m = matchImport(rows, ITEMS);
  assert.deepEqual(m.matched.map(x => [x.chrtId, x.amount]), [[1, 7], [3, 0]]);
  assert.equal(m.notFound.length, 0);
});

test('import: barcode, vendor code + size, WB article; bad rows are reported', () => {
  const rows = [
    ['Отчёт об остатках'],
    ['Артикул продавца', 'Размер', 'Баркод', 'Артикул WB', 'Количество'],
    ['', '', '2,06261912717E+12', '', '9'],
    ['fx-200', 'l', '', '', '1 200'],
    ['FX-201', '', '', '', '3'],
    ['', 'M', '', '101', '4'],
    ['нет-такого', 'S', '', '', '1'],
    ['FX-200', 'L', '', '', 'много'],
    ['FX-200', 'L', '', '', ''],
    ['FX-200', 'L', '', '', '6']
  ];
  const m = matchImport(rows, ITEMS);
  assert.equal(m.headerRow, 2);
  assert.deepEqual(m.matched.map(x => [x.chrtId, x.amount]).sort((a, b) => a[0] - b[0]), [[1, 4], [2, 6], [3, 3]]);
  assert.equal(m.duplicates, 2);
  assert.equal(m.notFound.length, 1);
  assert.equal(m.invalid.length, 1);
  assert.equal(m.empty, 1);
});

test('import: WB template without header (barcode; amount) and unknown layout', () => {
  assert.deepEqual(matchImport([['2062619127171', '3'], ['2054816631789', '0']], ITEMS).matched.map(x => [x.chrtId, x.amount]), [[2, 3], [3, 0]]);
  assert.ok(matchImport([['Имя', 'Цена'], ['a', '1']], ITEMS).error);
});

test('helpers: amounts, barcodes and bulk operations', () => {
  assert.equal(parseAmount(' 1 200 '), 1200);
  assert.equal(parseAmount('5,0'), 5);
  assert.equal(parseAmount(''), null);
  assert.ok(Number.isNaN(parseAmount('-1')));
  assert.ok(Number.isNaN(parseAmount('2.5')));
  assert.ok(Number.isNaN(parseAmount('100001')));
  assert.equal(normBarcode('2062619127170.0'), '2062619127170');
  assert.equal(applyBulk('set', 10, 3), 10);
  assert.equal(applyBulk('add', 10, 3), 13);
  assert.equal(applyBulk('sub', 10, 3), 0);
  assert.equal(applyBulk('zero', 10, 3), 0);
  assert.equal(applyBulk('add', 100000, 5), 100000);
});

test('csv: separators, quotes and BOM', () => {
  assert.deepEqual(Xlsx.readCsv('﻿Баркод,Кол-во\n"12,3",4\n'), [['Баркод', 'Кол-во'], ['12,3', '4']]);
  assert.deepEqual(Xlsx.readCsv('a\tb\r\n1\t2'), [['a', 'b'], ['1', '2']]);
});
