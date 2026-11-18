const test = require('node:test');
const assert = require('node:assert/strict');
const { dueGrants, allocate, PLAN_PHOTO_QUOTA } = require('../src/services/photo-credits.service');
const { hasAnalyticsAccess } = require('../src/middleware/plan-access');

const at = value => new Date(value);

test('plans give 5 / 15 / 40 photos a month', () => {
  assert.deepEqual(PLAN_PHOTO_QUOTA, { start: 5, pro: 15, max: 40 });
});

test('Start and Pro photos burn after a month, Max photos after three months', () => {
  const base = { plan_credits_next_at: '2026-11-01T10:00:00Z', subscription_end: '2027-02-01T10:00:00Z' };
  const pro = dueGrants({ ...base, plan: 'pro' }, at('2026-11-18T00:00:00Z'));
  assert.deepEqual(pro.grants.map(g => [g.amount, g.expiresAt.toISOString()]), [[15, '2026-12-01T10:00:00.000Z']]);
  assert.equal(pro.nextAt.toISOString(), '2026-12-01T10:00:00.000Z');

  const max = dueGrants({ ...base, plan: 'max' }, at('2027-01-15T00:00:00Z'));
  assert.deepEqual(max.grants.map(g => [g.amount, g.grantedAt.toISOString().slice(0, 10), g.expiresAt.toISOString().slice(0, 10)]), [
    [40, '2026-11-01', '2027-02-01'],
    [40, '2026-12-01', '2027-03-01'],
    [40, '2027-01-01', '2027-04-01']
  ]);
});

test('no monthly photos after the subscription ends or while the old terms last', () => {
  const ended = dueGrants({ plan: 'max', plan_credits_next_at: '2026-11-01T00:00:00Z', subscription_end: '2026-12-01T00:00:00Z' }, at('2027-03-01T00:00:00Z'));
  assert.equal(ended.grants.length, 1, 'только за оплаченный месяц');
  const legacy = dueGrants({ plan: 'max', plan_credits_next_at: '2026-11-01T00:00:00Z', subscription_end: '2027-01-01T00:00:00Z', legacy_terms_until: '2026-12-01T00:00:00Z' }, at('2026-11-18T00:00:00Z'));
  assert.equal(legacy.grants.length, 0);
  assert.deepEqual(dueGrants({ plan: 'pro', plan_credits_next_at: null, subscription_end: '2027-01-01' }, at('2026-11-18')), { grants: [], nextAt: null });
});

test('photos are spent from the batch that burns first; purchased photos last', () => {
  const batches = [{ id: 1, remaining: 3 }, { id: 2, remaining: 10 }, { id: 3, remaining: 50 }];
  assert.deepEqual(allocate(batches, 5), [{ id: 1, amount: 3 }, { id: 2, amount: 2 }]);
  assert.equal(allocate(batches, 100), null, 'не хватает — ничего не списываем');
  assert.deepEqual(allocate([{ id: 1, remaining: 2 }], 5, { partial: true }), [{ id: 1, amount: 2 }]);
});

test('analytics and RNP need Pro or Max, old subscribers keep access until their paid period ends', () => {
  const now = at('2026-11-18T00:00:00Z');
  const active = '2026-12-18T00:00:00Z';
  assert.equal(hasAnalyticsAccess({ plan: 'start', subscription_end: active }, now), false);
  assert.equal(hasAnalyticsAccess({ plan: 'pro', subscription_end: active }, now), true);
  assert.equal(hasAnalyticsAccess({ plan: 'max', subscription_end: active }, now), true);
  assert.equal(hasAnalyticsAccess({ plan: 'max', subscription_end: '2026-11-01T00:00:00Z' }, now), false, 'подписка закончилась');
  assert.equal(hasAnalyticsAccess({ plan: 'start', subscription_end: active, legacy_terms_until: active }, now), true, 'прежние условия');
  assert.equal(hasAnalyticsAccess(null, now), false);
});
