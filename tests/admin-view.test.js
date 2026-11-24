const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createAuthMiddleware, createViewToken, viewRequestAllowed, VIEW_SESSION_TTL_SECONDS } = require('../src/middleware/auth');
const { createAnalyticsAccess } = require('../src/middleware/plan-access');
const { createAdminUsersService, shopSyncState } = require('../src/services/admin-users.service');

const SECRET = 'x'.repeat(40);
const ADMIN_KEY = 'y'.repeat(40);

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function runAuth(token, method, url) {
  const { auth } = createAuthMiddleware({ usersRepository: {}, jwtSecret: SECRET, adminKey: ADMIN_KEY });
  const req = { headers: { authorization: `Bearer ${token}` }, method, originalUrl: url, url };
  const res = fakeRes();
  let passed = false;
  auth(req, res, () => { passed = true; });
  return { passed, res, req };
}

test('view pass allows reading and WB refresh, blocks every change', () => {
  assert.equal(viewRequestAllowed('GET', '/api/wb-analytics?from=1'), true);
  assert.equal(viewRequestAllowed('HEAD', '/api/rnp'), true);
  assert.equal(viewRequestAllowed('POST', '/api/rnp/refresh'), true);
  assert.equal(viewRequestAllowed('POST', '/api/rnp/refresh/'), true);
  assert.equal(viewRequestAllowed('POST', '/api/product-costs'), false);
  assert.equal(viewRequestAllowed('POST', '/api/rnp/plans'), false);
  assert.equal(viewRequestAllowed('PUT', '/api/shops/1/token'), false);
  assert.equal(viewRequestAllowed('PATCH', '/api/shops/1'), false);
  assert.equal(viewRequestAllowed('DELETE', '/api/wb-token'), false);
  assert.equal(viewRequestAllowed('POST', '/api/generate-image'), false);
  assert.equal(viewRequestAllowed('POST', '/api/change-password'), false);
});

test('auth middleware: view token reads, cannot write; normal token unchanged', () => {
  const user = { id: 7, email: 'a@b.kz' };
  const view = createViewToken({ jwtSecret: SECRET, user, shopId: 3 });
  const payload = jwt.verify(view, SECRET);
  assert.equal(payload.view, true);
  assert.equal(payload.id, 7);
  assert.equal(payload.shopId, 3);
  assert.equal(payload.exp - payload.iat, VIEW_SESSION_TTL_SECONDS);
  assert.equal(VIEW_SESSION_TTL_SECONDS, 3600);

  const read = runAuth(view, 'GET', '/api/rnp');
  assert.equal(read.passed, true);
  assert.equal(read.req.user.id, 7);

  const write = runAuth(view, 'POST', '/api/product-costs');
  assert.equal(write.passed, false);
  assert.equal(write.res.statusCode, 403);
  assert.equal(write.res.body.readOnly, true);

  const remove = runAuth(view, 'DELETE', '/api/shops/3');
  assert.equal(remove.passed, false);

  assert.equal(runAuth(view, 'POST', '/api/rnp/refresh').passed, true);

  const normal = jwt.sign({ id: 7, email: 'a@b.kz' }, SECRET, { expiresIn: '30d' });
  assert.equal(runAuth(normal, 'POST', '/api/product-costs').passed, true);
});

test('expired or forged view token is rejected', () => {
  const expired = jwt.sign({ id: 7, view: true }, SECRET, { expiresIn: -10 });
  const r1 = runAuth(expired, 'GET', '/api/rnp');
  assert.equal(r1.passed, false);
  assert.equal(r1.res.statusCode, 401);
  const forged = jwt.sign({ id: 7, view: true }, 'z'.repeat(40));
  assert.equal(runAuth(forged, 'GET', '/api/rnp').res.statusCode, 401);
});

test('view pass opens analytics regardless of the user plan', async () => {
  const access = createAnalyticsAccess({ usersRepository: { findById: async () => ({ plan: 'start', subscription_end: null }) } });
  let passed = false;
  await access({ user: { id: 1, view: true } }, fakeRes(), () => { passed = true; });
  assert.equal(passed, true);
  const res = fakeRes();
  passed = false;
  await access({ user: { id: 1 } }, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

function adminService(overrides = {}) {
  const repository = {
    findUser: async id => (id === 5 ? { id: 5, email: 'u@x.kz', name: 'Аня', plan: 'pro', subscription_end: '2027-01-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', legacy_terms_until: null } : null),
    listShops: async () => [{
      id: 11, name: 'Магазин', seller_id: 'abc', token_tail: '123456', tax_rate: '4.00', created_at: '2026-10-02T00:00:00Z',
      sync_status: 'running', sync_progress: JSON.stringify({ steps: { orders: 'done' } }), last_success_at: null, last_error: null,
      products_count: 12, orders_30d: '40'
    }],
    findShop: async (userId, shopId) => (userId === 5 && shopId === 11 ? { id: 11 } : null),
    creditHistory: async () => [{ id: 1, amount: -3, note: 'снятие', created_at: '2026-11-01T00:00:00Z' }],
    ...overrides
  };
  return createAdminUsersService({
    repository,
    creditsSummary: async () => ({ total: 9, expiring: null }),
    createViewToken: ({ user, shopId }) => createViewToken({ jwtSecret: SECRET, user, shopId })
  });
}

test('admin user details: shops without full token, sync and counters', async () => {
  const details = await adminService().details('5');
  assert.equal(details.user.email, 'u@x.kz');
  assert.equal(details.user.plan, 'pro');
  assert.equal(details.credits.total, 9);
  assert.equal(details.history[0].amount, -3);
  const [shop] = details.shops;
  assert.equal(shop.tokenPreview, '****123456');
  assert.equal(shop.taxRate, 4);
  assert.equal(shop.orders30d, 40);
  assert.equal(shop.productsCount, 12);
  assert.equal(shop.sync.state, 'running');
  assert.ok(shop.sync.percent > 0 && shop.sync.percent < 100);
  assert.equal(JSON.stringify(details).includes('token_tail'), false);
  assert.equal('token' in shop, false);
});

test('admin details and view pass: unknown user and foreign shop are 404', async () => {
  const service = adminService();
  await assert.rejects(service.details('999'), { status: 404 });
  await assert.rejects(service.details('abc'), { status: 404 });
  await assert.rejects(service.viewSession(5, 99), { status: 404 });
  await assert.rejects(service.viewSession(999, 11), { status: 404 });
  const session = await service.viewSession(5, 11);
  assert.equal(session.shopId, 11);
  assert.equal(session.email, 'u@x.kz');
  const payload = jwt.verify(session.token, SECRET);
  assert.equal(payload.view, true);
  assert.equal(payload.id, 5);
  const noShop = await service.viewSession(5);
  assert.equal(noShop.shopId, null);
});

test('shop sync state for admin', () => {
  assert.equal(shopSyncState({}).state, 'none');
  assert.equal(shopSyncState({ sync_status: 'idle', last_success_at: '2026-11-20T00:00:00Z' }).state, 'ok');
  assert.equal(shopSyncState({ sync_status: 'idle', last_success_at: '2026-11-20T00:00:00Z' }).percent, 100);
  const failed = shopSyncState({ sync_status: 'error', last_error: 'WB 401' });
  assert.equal(failed.state, 'error');
  assert.equal(failed.error, 'WB 401');
  // Старая ошибка при уже загруженных данных — не повод пугать админа.
  assert.equal(shopSyncState({ sync_status: 'idle', last_success_at: '2026-11-20T00:00:00Z', last_error: 'old' }).state, 'ok');
});
