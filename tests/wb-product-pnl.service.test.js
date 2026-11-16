const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProductPnl, SHOP_KEY } = require('../src/services/wb-product-pnl.service');
const { normalizeFinanceRows } = require('../src/services/wb-finance.service');

// Строки в формате normalizeFinanceRows, как в «Аналитике WB».
const sale = (date, vendorCode, retail, payable, extra = {}) => ({
  date, currency: 'KZT', vendorCode, quantity: 1, operation: 'Продажа', documentType: 'Продажа',
  retailAmount: retail, sales: retail, payable, commission: retail - payable,
  logistics: 0, storage: 0, penalty: 0, deduction: 0, acceptance: 0, additionalPayment: 0,
  margin: payable, ...extra
});
const expense = (date, vendorCode, field, amount, extra = {}) => ({
  date, currency: 'KZT', vendorCode, quantity: 0, operation: 'Логистика', documentType: '',
  retailAmount: 0, sales: 0, payable: 0, commission: 0,
  logistics: 0, storage: 0, penalty: 0, deduction: 0, acceptance: 0, additionalPayment: 0,
  [field]: amount, margin: -amount, ...extra
});
const catalog = [
  { nm_id: '11', vendor_code: 'FX-200', title: 'Пылесос FX-200', subject: 'Пылесосы' },
  { nm_id: '22', vendor_code: 'FX-201', title: 'Пылесос FX-201', subject: 'Пылесосы' }
];
const sum = (products, pick) => products.reduce((total, product) => total + pick(product), 0);

test('every expense lands on a product and products add up to the shop', () => {
  const rows = [
    sale('2026-10-21', 'FX-200', 30000, 24000),
    sale('2026-10-21', 'FX-201', 10000, 8000),
    expense('2026-10-21', 'FX-200', 'logistics', 1500),
    expense('2026-10-22', '', 'storage', 400),
    expense('2026-10-22', '', 'deduction', 2000)
  ];
  const result = buildProductPnl({ rows, catalog, costsByVendorCode: { 'FX-200': 5000, 'fx-201': 4000 } });
  const [first, second] = result.products;

  assert.equal(result.check.ok, true);
  assert.equal(first.title, 'Пылесос FX-200');
  // Хранение и удержания без артикула делятся 3:1 — как продажи 30 000 и 10 000.
  assert.deepEqual([first.totals.storage, second.totals.storage], [300, 100]);
  assert.deepEqual([first.totals.deduction, second.totals.deduction], [1500, 500]);
  assert.equal(first.allocated.storage, 300);
  assert.equal(first.totals.logistics, 1500, 'своя логистика не делится');
  assert.equal(first.totals.cogs, 5000);
  assert.equal(first.totals.profit, 24000 - 1500 - 300 - 1500 - 5000);
  assert.equal(first.totals.wbCosts, 30000 - (24000 - 1500 - 300 - 1500));
  assert.equal(first.metrics.profitPerUnit, first.totals.profit);
  assert.equal(first.metrics.roi, Math.round(first.totals.profit / 5000 * 1000) / 10);
  assert.equal(sum(result.products, p => p.totals.profit), result.shop.profit);
  assert.equal(sum(result.products, p => p.totals.margin), 24000 + 8000 - 1500 - 400 - 2000);
});

test('returns reduce sales and cost of goods, products without cost are flagged', () => {
  const rows = normalizeFinanceRows([
    { rrDate: '2026-10-21', currency: 'KZT', vendorCode: 'FX-200', quantity: 2, docTypeName: 'Продажа', sellerOperName: 'Продажа', retailAmount: 60000, retailPriceWithDisc: 30000, forPay: 48000 },
    { rrDate: '2026-10-22', currency: 'KZT', vendorCode: 'FX-200', quantity: 1, docTypeName: 'Возврат', sellerOperName: 'Возврат', retailAmount: 30000, retailPriceWithDisc: 30000, forPay: 24000 },
    { rrDate: '2026-10-22', currency: 'KZT', vendorCode: 'FX-201', quantity: 1, docTypeName: 'Продажа', sellerOperName: 'Продажа', retailAmount: 10000, retailPriceWithDisc: 10000, forPay: 8000 }
  ]).rows;
  const result = buildProductPnl({ rows, catalog, costsByVendorCode: { 'FX-200': 5000 } });
  const fx200 = result.products.find(p => p.nmId === 11);
  const fx201 = result.products.find(p => p.nmId === 22);
  assert.deepEqual(fx200.units, { sold: 2, returned: 1, net: 1 });
  assert.equal(fx200.totals.retailAmount, 30000);
  assert.equal(fx200.totals.cogs, 5000);
  assert.equal(fx201.flags.unpriced, true);
  assert.equal(fx201.totals.cogs, 0);
});

test('WB Promotion acts follow each product ad spend, other deductions follow sales', () => {
  const rows = [
    sale('2026-10-21', 'FX-200', 10000, 8000, { deductionKind: 'other' }),
    sale('2026-10-21', 'FX-201', 10000, 8000, { deductionKind: 'other' }),
    expense('2026-10-23', '', 'deduction', 900, { deductionKind: 'ads' }),
    expense('2026-10-23', '', 'deduction', 200, { deductionKind: 'other' })
  ];
  const result = buildProductPnl({ rows, catalog, adSpendByNm: new Map([[11, 800], [22, 100]]) });
  const fx200 = result.products.find(p => p.nmId === 11);
  const fx201 = result.products.find(p => p.nmId === 22);
  assert.equal(result.kindsKnown, true);
  assert.deepEqual([fx200.totals.adsDeduction, fx201.totals.adsDeduction], [800, 100]);
  assert.deepEqual([fx200.totals.otherDeduction, fx201.totals.otherDeduction], [100, 100]);
  assert.equal(fx200.metrics.drr, 8);
  assert.equal(result.check.ok, true);
});

test('a product with ad spend but no sales still carries its ads', () => {
  const rows = [
    sale('2026-10-21', 'FX-200', 10000, 8000, { deductionKind: 'other' }),
    expense('2026-10-23', '', 'deduction', 500, { deductionKind: 'ads' })
  ];
  const result = buildProductPnl({ rows, catalog, adSpendByNm: new Map([[11, 0], [22, 500]]) });
  const fx201 = result.products.find(p => p.nmId === 22);
  assert.equal(fx201.totals.adsDeduction, 500);
  assert.equal(fx201.totals.profit, -500);
  assert.equal(fx201.flags.noSales, true);
  assert.equal(fx201.metrics.marginPct, null, 'без продаж маржа не считается');
});

test('without any sales the shop expenses stay on one shop line', () => {
  const result = buildProductPnl({ rows: [expense('2026-10-22', '', 'storage', 300)], catalog });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].key, SHOP_KEY);
  assert.equal(result.products[0].title, 'Общие расходы магазина');
  assert.equal(result.products[0].totals.profit, -300);
  assert.equal(result.check.ok, true);
});

test('detail days split shared expenses by day and convert currency once', () => {
  const rows = [
    sale('2026-10-21', 'FX-200', 100, 80),
    expense('2026-10-22', '', 'storage', 10)
  ];
  const result = buildProductPnl({ rows, catalog, toKzt: value => value * 5, detailKey: 'nm:11' });
  const [product] = result.products;
  assert.deepEqual(product.days, [
    { date: '2026-10-21', retailAmount: 500, wbCosts: 100, cogs: 0, profit: 400 },
    { date: '2026-10-22', retailAmount: 0, wbCosts: 50, cogs: 0, profit: -50 }
  ]);
  assert.equal(product.totals.profit, 350);
  assert.equal(result.shop.profit, 350);
});

test('storage without an article follows each product storage cost, other expenses follow sales', () => {
  const rows = [
    sale('2026-10-21', 'FX-200', 30000, 24000),
    sale('2026-10-21', 'FX-201', 10000, 8000),
    expense('2026-10-22', '', 'storage', 1000),
    expense('2026-10-22', '', 'deduction', 400)
  ];
  // FX-201 продаётся меньше, но хранится дороже — хранение должно лечь на него.
  const result = buildProductPnl({ rows, catalog, storageByNm: new Map([[11, 20], [22, 80]]) });
  const fx200 = result.products.find(p => p.nmId === 11);
  const fx201 = result.products.find(p => p.nmId === 22);
  assert.deepEqual([fx200.totals.storage, fx201.totals.storage], [200, 800]);
  assert.deepEqual([fx200.totals.deduction, fx201.totals.deduction], [300, 100]);
  assert.equal(fx201.totals.margin, 8000 - 800 - 100, 'итого от WB считается из своих статей');
  assert.equal(result.check.ok, true);
  assert.equal(fx200.totals.profit + fx201.totals.profit, result.shop.profit);
});
