const test = require('node:test');
const assert = require('node:assert/strict');
const { createShopsService, cleanToken, shopLimit } = require('../src/services/shops.service');
const { createShopMiddleware } = require('../src/middleware/shop');
const { createRnpSyncService } = require('../src/services/wb-rnp-sync.service');

function fakeShops({ plan = 'start', shops = [], stored = {} } = {}) {
  const state = { shops: shops.map(shop => ({ ...shop })), calls: [], nextId: 100 };
  const repository = {
    listByUser: async userId => state.shops.filter(shop => shop.user_id === userId),
    findForUser: async (userId, id) => state.shops.find(shop => shop.user_id === userId && shop.id === id) || null,
    firstForUser: async userId => state.shops.filter(shop => shop.user_id === userId).sort((a, b) => a.id - b.id)[0] || null,
    countForUser: async userId => state.shops.filter(shop => shop.user_id === userId).length,
    findBySeller: async (userId, sellerId) => state.shops.find(shop => shop.user_id === userId && shop.seller_id === sellerId) || null,
    create: async ({ userId, name, sellerId, token }) => {
      const shop = { id: state.nextId++, user_id: userId, name, seller_id: sellerId, token };
      state.shops.push(shop);
      return shop;
    },
    update: async (id, fields) => {
      state.calls.push(['update', id, fields]);
      const shop = state.shops.find(item => item.id === id);
      for (const [key, value] of Object.entries(fields)) if (value !== undefined) shop[key] = value;
    },
    remove: async id => { state.calls.push(['remove', id]); state.shops = state.shops.filter(shop => shop.id !== id); },
    purgeData: async id => state.calls.push(['purge', id]),
    storedNmIds: async id => stored[id] || []
  };
  return { state, repository, usersRepository: { findById: async () => ({ plan }) } };
}

function service(fake, { seller = null, catalog = [], validate = async () => {} } = {}) {
  const sync = [];
  const svc = createShopsService({
    repository: fake.repository,
    usersRepository: fake.usersRepository,
    validateToken: validate,
    getSellerInfo: async () => seller,
    getCatalogNmIds: async () => {
      if (catalog instanceof Error) throw catalog;
      return catalog;
    },
    syncService: { restart: async id => sync.push(['restart', id]), stop: async id => sync.push(['stop', id]) },
    logger: { info() {}, warn() {} }
  });
  return { svc, sync };
}

test('tariff limits are start 3, pro 6, max 12', async () => {
  assert.deepEqual(['start', 'pro', 'max', 'unknown'].map(shopLimit), [3, 6, 12, 3]);
  const fake = fakeShops({ shops: [1, 2, 3].map(id => ({ id, user_id: 1, name: `M${id}`, token: 't' })) });
  await assert.rejects(service(fake).svc.add(1, 'new-token'), error => error.status === 403 && /до 3 магазинов/.test(error.message));
});

test('a shop gets its WB seller name and starts importing; the same cabinet cannot be added twice', async () => {
  const fake = fakeShops({ plan: 'pro', shops: [{ id: 1, user_id: 1, name: 'Старый', seller_id: 'sid-1', token: 't1' }] });
  const { svc, sync } = service(fake, { seller: { sid: 'sid-2', name: 'PURO' } });
  const shop = await svc.add(1, ' Bearer abcdef123456 ');
  assert.equal(shop.name, 'PURO');
  assert.equal(shop.tokenPreview, '****123456');
  assert.equal(fake.state.shops.at(-1).token, 'abcdef123456');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sync, [['restart', shop.id]]);

  const again = service(fake, { seller: { sid: 'sid-1', name: 'Старый' } }).svc;
  await assert.rejects(again.add(1, 'other-token'), error => error.status === 409 && /уже подключён как «Старый»/.test(error.message));

  const noInfo = service(fakeShops(), { seller: null }).svc;
  assert.equal((await noInfo.add(1, 'x')).name, 'Магазин 1');
  assert.equal(cleanToken('  Bearer  abc '), 'abc');
});

test('replacing the token with the same cabinet keeps everything', async () => {
  const fake = fakeShops({ shops: [{ id: 5, user_id: 1, name: 'PURO', seller_id: 'sid-1', token: 'old' }] });
  const { svc, sync } = service(fake, { seller: { sid: 'sid-1', name: 'PURO' } });
  const result = await svc.replaceToken(1, 5, 'new-token');
  assert.equal(result.sameCabinet, true);
  assert.equal(fake.state.calls.some(call => call[0] === 'purge'), false);
  assert.equal(fake.state.shops[0].token, 'new-token');
  assert.deepEqual(sync[0], ['stop', 5], 'старая загрузка прервана до замены');
});

test('replacing the token with another cabinet wipes all shop data and renames the shop', async () => {
  const fake = fakeShops({ shops: [{ id: 5, user_id: 1, name: 'PURO', seller_id: 'sid-1', token: 'old' }] });
  const { svc } = service(fake, { seller: { sid: 'sid-9', name: 'Kenya' } });
  const result = await svc.replaceToken(1, 5, 'new-token');
  assert.equal(result.sameCabinet, false);
  assert.deepEqual(fake.state.calls.filter(call => call[0] === 'purge'), [['purge', 5]]);
  assert.equal(fake.state.shops[0].name, 'Kenya');
  assert.equal(fake.state.shops[0].seller_id, 'sid-9');
});

test('without a seller id the cabinet is recognised by shared products', async () => {
  const shops = [{ id: 5, user_id: 1, name: 'Мой магазин', seller_id: null, token: 'old' }];
  const same = fakeShops({ shops, stored: { 5: [11, 22] } });
  assert.equal((await service(same, { catalog: [22, 33] }).svc.replaceToken(1, 5, 't')).sameCabinet, true);
  const other = fakeShops({ shops, stored: { 5: [11, 22] } });
  assert.equal((await service(other, { catalog: [44] }).svc.replaceToken(1, 5, 't')).sameCabinet, false);
  assert.ok(other.state.calls.some(call => call[0] === 'purge'));
  const down = fakeShops({ shops, stored: { 5: [11] } });
  await assert.rejects(service(down, { catalog: new Error('WB down') }).svc.replaceToken(1, 5, 't'), error => error.status === 503);
  assert.equal(down.state.calls.length, 0, 'без ответа WB ничего не меняем');
});

test('a cabinet already connected as another shop cannot replace a token; foreign shops are hidden', async () => {
  const fake = fakeShops({ plan: 'pro', shops: [
    { id: 5, user_id: 1, name: 'PURO', seller_id: 'sid-1', token: 'a' },
    { id: 6, user_id: 1, name: 'Kenya', seller_id: 'sid-2', token: 'b' },
    { id: 7, user_id: 2, name: 'Чужой', seller_id: 'sid-3', token: 'c' }
  ] });
  await assert.rejects(service(fake, { seller: { sid: 'sid-2' } }).svc.replaceToken(1, 5, 't'), error => error.status === 409);
  await assert.rejects(service(fake).svc.rename(1, 7, 'Моё'), error => error.status === 404);
  await assert.rejects(service(fake).svc.remove(1, 7), error => error.status === 404);
});

test('rename trims the name, remove stops the import first', async () => {
  const fake = fakeShops({ shops: [{ id: 5, user_id: 1, name: 'PURO', seller_id: 's', token: 'a' }] });
  const { svc, sync } = service(fake);
  assert.equal((await svc.rename(1, 5, '  Новый   магазин ')).name, 'Новый магазин');
  await assert.rejects(svc.rename(1, 5, '   '), error => error.status === 400);
  await svc.remove(1, 5);
  assert.deepEqual(sync, [['stop', 5]]);
  assert.deepEqual(fake.state.calls.at(-1), ['remove', 5]);
});

test('the shop middleware picks the requested own shop or the first one', async () => {
  const fake = fakeShops({ shops: [
    { id: 5, user_id: 1, name: 'A', token: 'ta' }, { id: 6, user_id: 1, name: 'B', token: 'tb' }, { id: 7, user_id: 2, name: 'C', token: 'tc' }
  ] });
  const resolve = createShopMiddleware({ repository: fake.repository });
  const run = async (header, userId = 1) => {
    const req = { user: { id: userId }, query: {}, get: name => (name === 'x-shop-id' ? header : undefined) };
    let status = 200; let body = null; let nextCalled = false;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; } };
    await resolve(req, res, () => { nextCalled = true; });
    return { status, body, shop: req.shop, nextCalled };
  };
  assert.equal((await run(undefined)).shop.id, 5);
  assert.equal((await run('6')).shop.token, 'tb');
  assert.equal((await run('7')).status, 404, 'чужой магазин');
  assert.equal((await run('abc')).status, 404);
  assert.equal((await run(undefined, 3)).shop, null, 'магазинов нет');
});

test('restart interrupts a running import and starts a fresh one', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const repository = {
    getToken: async () => 'token',
    ensureSync: async () => {},
    getSync: async () => ({ status: 'idle' }),
    claimSync: async () => ({}),
    updateSync: async (id, fields) => { if (fields.status) calls.push(fields.status); },
    upsertOrders: async () => {},
    upsertSales: async () => {},
    replaceProducts: async () => {},
    replaceFinanceRows: async () => {},
    listFinanceRows: async () => []
  };
  let first = true;
  const statisticsService = {
    loadSince: async ({ onPage }) => {
      if (first) { first = false; await gate; }
      await onPage([], 'c');
      return 'c';
    }
  };
  const sync = createRnpSyncService({
    repository, statisticsService, salesFunnelService: { getCatalog: async () => [] },
    advertisingService: { getDailySpend: async () => {} },
    financeService: { getDetailedReportPage: async () => ({ rows: [], nextRrdId: null }) },
    logger: { info() {}, warn() {}, error() {} }, wait: async () => {}
  });
  sync.syncShop(1);
  const restarted = sync.restart(1);
  release();
  await restarted;
  await new Promise(resolve => setImmediate(resolve));
  await sync.syncShop(1);
  assert.equal(calls[0], 'idle', 'первая загрузка прервана без ошибки');
  assert.ok(!calls.includes('error'));
});
