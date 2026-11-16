const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseFunnel, productBreak } = require('../src/services/wb-funnel-diagnosis.service');
const { productFunnelMetrics } = require('../src/services/wb-sales-funnel.service');

const product = (nmId, current, previous, extra = {}) => ({ nmId, vendorCode: `art-${nmId}`, title: `Товар ${nmId}`, current, previous, ...extra });
const step = (opens, carts, orders, orderSum = orders * 1000) => ({ opens, carts, orders, orderSum });

test('a drop in cart conversion is called conversion and blocks raising ad bids', () => {
  const result = diagnoseFunnel({
    products: [product(1, step(1000, 50, 20), step(1000, 100, 40))]
  });
  assert.equal(result.available, true);
  assert.equal(result.mode, 'drop');
  assert.equal(result.kind, 'конверсия');
  assert.equal(result.worst, 'cartRate');
  assert.equal(result.headline, 'Вывод: конверсия. Заказы −50%: заходят, но реже кладут в корзину (−50%).');
  assert.equal(result.steps.find(s => s.key === 'cartRate').share, 1);
  assert.deepEqual(result.actions.map(a => [a.stageName, a.title]), [
    ['Конверсии', 'Дожать карточку: заходят, но не кладут в корзину'],
    ['Реклама', 'Ставки в рекламе пока не поднимать']
  ]);
  assert.equal(result.products[0].break.text, 'конверсия в корзину −50%');
  assert.equal(result.products[0].lostSum, 20000);
});

test('a traffic drop with steady conversion suggests getting traffic back', () => {
  const result = diagnoseFunnel({
    products: [product(1, step(600, 60, 30), step(1000, 100, 50))]
  });
  assert.equal(result.kind, 'трафик');
  assert.equal(result.headline, 'Вывод: трафик. Заказы −40%: в карточки стали меньше заходить (переходы −40%).');
  assert.equal(result.actions.at(-1).title, 'Вернуть трафик');
  assert.equal(result.products[0].break.text, 'трафик: переходы −40%');
});

test('low stock comes first, before conversion and ads', () => {
  const stocks = new Map([[1, { daysLeft: 5, quantity: 10 }], [2, { daysLeft: 60, quantity: 300 }]]);
  const result = diagnoseFunnel({
    products: [
      product(1, step(1000, 100, 20), step(1000, 100, 40)),
      product(2, step(500, 50, 10), step(500, 50, 10))
    ],
    stocks
  });
  assert.equal(result.actions[0].stageName, 'Склады');
  assert.match(result.actions[0].why, /Товар 1 — 5 дн\. Кончится/);
  assert.equal(result.worst, 'orderRate');
  assert.equal(result.actions[1].title, 'Поднять конверсию в заказ');
});

test('growth and steady periods are described without false alarms', () => {
  const growth = diagnoseFunnel({ products: [product(1, step(1300, 130, 65), step(1000, 100, 50))] });
  assert.equal(growth.mode, 'growth');
  assert.equal(growth.headline, 'Заказы растут: +30%. Рост дал трафик: переходы +30%.');
  assert.deepEqual(growth.products, []);
  const small = diagnoseFunnel({ products: [product(1, step(1000, 100, 40), step(1000, 100, 41)), product(2, step(500, 50, 5), step(1000, 100, 20))] });
  assert.deepEqual(small.products.map(p => p.nmId), [2], 'падение 41 → 40 — шум, в таблицу не попадает');
  const steady = diagnoseFunnel({ products: [product(1, step(1000, 100, 51), step(1000, 100, 50))] });
  assert.equal(steady.mode, 'stable');
  assert.equal(steady.headline, 'Заказы ровные: +2% к прошлому периоду.');
});

test('no verdict without funnel steps or a previous period', () => {
  assert.equal(diagnoseFunnel({ products: [product(1, { opens: null, carts: null, orders: 5 }, { orders: 5 })] }).available, false);
  assert.match(diagnoseFunnel({ products: [product(1, step(100, 10, 5), step(0, 0, 0))] }).reason, /не было/);
  assert.match(diagnoseFunnel({}).limits[0], /конкурентах/);
});

test('productBreak finds the first broken step and ignores small changes', () => {
  assert.equal(productBreak(product(1, step(1000, 95, 40), step(1000, 100, 42))), null);
  assert.equal(productBreak(product(1, step(1000, 100, 30), step(1000, 100, 40))).text, 'конверсия в заказ −25%');
});

test('productFunnelMetrics reads opens and carts from the WB sales funnel', () => {
  const metrics = productFunnelMetrics([
    { product: { nmId: 5, vendorCode: 'fx-200', title: 'Пылесос' }, statistic: {
      selected: { openCount: 120, cartCount: 30, orderCount: 6, orderSum: 72000 },
      past: { openCount: 100, cartCount: 25, orderCount: 5, orderSum: 60000 }
    } },
    { product: { nmId: 6 }, statistic: { selected: { orderCount: 0 }, past: { orderCount: 0 } } }
  ]);
  assert.deepEqual(metrics, [{
    nmId: 5, vendorCode: 'fx-200', title: 'Пылесос',
    current: { opens: 120, carts: 30, orders: 6, orderSum: 72000 },
    previous: { opens: 100, carts: 25, orders: 5, orderSum: 60000 }
  }]);
});
