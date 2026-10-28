const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFinanceService,
  normalizeFinanceRows,
  calculateRealizedCogs,
  convertMoneyToKzt,
  FINANCE_DETAILS_URL,
  FINANCE_PAGE_LIMIT
} = require('../src/services/wb-finance.service');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('normalizeFinanceRows maps current Finance API fields without losing decimals', () => {
  const report = normalizeFinanceRows([{
    currency: 'KZT',
    rrDate: '2026-10-01',
    vendorCode: ' PURO FX-200 ',
    quantity: '2',
    docTypeName: 'Продажа',
    sellerOperName: 'Продажа',
    retailAmount: '1500.50',
    retailPriceWithDisc: '900.00',
    forPay: '1000.25',
    ppvzSalesCommission: '120.10',
    acquiringFee: '14.40',
    deliveryService: '60.50',
    paidStorage: '10.25',
    penalty: '3.00',
    deduction: '4.50',
    paidAcceptance: '2.25',
    additionalPayment: '25.00'
  }]);

  assert.equal(report.currency, 'KZT');
  assert.deepEqual(report.rows, [{
    date: '2026-10-01',
    currency: 'KZT',
    vendorCode: 'PURO FX-200',
    quantity: 2,
    operation: 'Продажа',
    documentType: 'Продажа',
    retailAmount: 1500.5,
    sales: 1800,
    payable: 1000.25,
    commission: 500.25,
    logistics: 60.5,
    storage: 10.25,
    penalty: 3,
    deduction: 4.5,
    acceptance: 2.25,
    additionalPayment: 25,
    margin: 944.75
  }]);
});

test('calculateRealizedCogs matches realized sales and returns instead of funnel orders', () => {
  const result = calculateRealizedCogs([
    { operation: 'Продажа', vendorCode: 'a', quantity: 3 },
    { operation: 'Возврат', vendorCode: ' A ', quantity: 1 },
    { operation: 'Логистика', vendorCode: 'A', quantity: 10 },
    { operation: 'Продажа', vendorCode: 'NO_COST', quantity: 2 }
  ], { A: 29_000 });

  assert.deepEqual(result, {
    cogs: 58_000,
    soldUnits: 5,
    returnedUnits: 1,
    netUnits: 4,
    unpricedUnits: 2,
    unpricedArticles: ['NO_COST'],
    complete: false
  });
});

test('convertMoneyToKzt does not convert KZT twice and converts RUB once', () => {
  assert.equal(convertMoneyToKzt(1000.4, 'KZT', 5.39), 1000);
  assert.equal(convertMoneyToKzt(100, 'RUB', 5.39), 539);
  assert.throws(() => convertMoneyToKzt(100, 'USD', 5.39), /Неподдерживаемая валюта/);
});

test('getDetailedReport uses the new Finance API and a bounded daily report', async () => {
  let request;
  const service = createFinanceService({
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return jsonResponse(200, [{
        currency: 'KZT',
        rrDate: '2026-10-01',
        forPay: '100',
        ppvzSalesCommission: '10',
        acquiringFee: '2',
        deliveryService: '5',
        paidStorage: '1',
        penalty: '0',
        deduction: '0',
        paidAcceptance: '0',
        additionalPayment: '0'
      }]);
    }
  });

  const result = await service.getDetailedReport({
    token: 'secret-token',
    dateFrom: '2026-09-07',
    dateTo: '2026-10-04'
  });

  assert.equal(request.url, FINANCE_DETAILS_URL);
  assert.equal(request.body.limit, FINANCE_PAGE_LIMIT);
  assert.equal(request.body.period, 'daily');
  assert.equal(request.body.rrdId, 0);
  assert.ok(request.body.fields.includes('vendorCode'));
  assert.ok(request.body.fields.includes('sellerOperName'));
  assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
  assert.equal(result.currency, 'KZT');
  assert.equal(result.rows.length, 1);
});

test('getDetailedReport treats 204 as available report with no rows', async () => {
  const service = createFinanceService({ fetchImpl: async () => ({ ok: true, status: 204 }) });
  const result = await service.getDetailedReport({ token: 'token', dateFrom: '2026-10-04', dateTo: '2026-10-04' });
  assert.deepEqual(result, { rows: [], currency: null });
});

test('getDetailedReport preserves Finance API permission errors', async () => {
  const service = createFinanceService({ fetchImpl: async () => jsonResponse(403, {}) });
  await assert.rejects(
    service.getDetailedReport({ token: 'token', dateFrom: '2026-10-01', dateTo: '2026-10-04' }),
    error => error.status === 403 && error.code === 'WB_FINANCE_403'
  );
});

test('normalizeFinanceRows subtracts WB returns like the realization report', () => {
  // Реальная сверка октября 2026: 263 продажи и 5 возвратов дают «Продажа» 13 496 880,62
  // и «К перечислению» 12 934 868,44 в списке финансовых отчётов WB Partners.
  const { rows } = normalizeFinanceRows([
    {
      currency: 'KZT', rrDate: '2026-10-20', docTypeName: 'Продажа', sellerOperName: 'Продажа', quantity: 263,
      retailAmount: '13762098.72', forPay: '13185970.70', ppvzSalesCommission: '-9850.61', acquiringFee: '587554.90'
    },
    {
      currency: 'KZT', rrDate: '2026-10-20', docTypeName: 'Возврат', sellerOperName: 'Возврат', quantity: 5,
      retailAmount: '265218.10', forPay: '251102.26', ppvzSalesCommission: '2233.20', acquiringFee: '11525.34'
    },
    { currency: 'KZT', rrDate: '2026-10-20', sellerOperName: 'Логистика', deliveryService: '1319034.13' }
  ]);
  const total = field => Math.round(rows.reduce((sum, row) => sum + row[field], 0) * 100) / 100;

  assert.equal(total('retailAmount'), 13496880.62);
  assert.equal(total('payable'), 12934868.44);
  assert.equal(total('logistics'), 1319034.13);
  assert.equal(total('margin'), 11615834.31);
});

test('normalizeFinanceRows keeps seller-price sales and takes commission from the daily report', () => {
  // Строки PURO FX-200 из отчёта 01.10.2026: покупатель заплатил 52 933,15 со скидкой WB 17%,
  // «Баланс» WB показывает продажу по цене продавца 63 777,96, а комиссия в ежедневном
  // отчёте — «Продажа» 52 933,15 минус «К перечислению» 49 064,5.
  const { rows } = normalizeFinanceRows([
    {
      currency: 'KZT', rrDate: '2026-10-01', docTypeName: 'Продажа', sellerOperName: 'Продажа', quantity: 1,
      retailAmount: '52933.15', retailPriceWithDisc: '63777.96', forPay: '49064.5', ppvzSalesCommission: '1509.77', acquiringFee: '2117.32'
    },
    {
      currency: 'KZT', rrDate: '2026-10-02', docTypeName: 'Возврат', sellerOperName: 'Возврат', quantity: 1,
      retailAmount: '52933.15', retailPriceWithDisc: '63777.96', forPay: '49064.5'
    },
    {
      currency: 'KZT', rrDate: '2026-10-02', docTypeName: 'Продажа', sellerOperName: 'Возмещение за выдачу и возврат товаров на ПВЗ',
      quantity: 0, retailPriceWithDisc: '63777.96', ppvzReward: '40'
    }
  ]);

  assert.equal(rows[0].sales, 63777.96);
  assert.equal(Math.round(rows[0].commission * 100) / 100, 3868.65);
  assert.equal(rows[1].sales, -63777.96);
  assert.equal(Math.round(rows[1].commission * 100) / 100, -3868.65);
  assert.equal(rows[2].sales, 0);
  assert.equal(rows[2].commission, 0);
});
