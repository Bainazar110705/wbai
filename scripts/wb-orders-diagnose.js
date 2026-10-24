// Сверка заказов за день: Sales Funnel WB против отчёта «Заказы» Statistics API.
// Запуск на сервере:  docker compose exec app node scripts/wb-orders-diagnose.js --email user@mail --date 2026-10-23
// Или локально:       WB_TOKEN=... node scripts/wb-orders-diagnose.js --date 2026-10-23
// Печатает только цифры заказов, токен не выводится.
require('dotenv').config();
const { createSalesFunnelService } = require('../src/services/wb-sales-funnel.service');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

async function resolveToken(email) {
  if (process.env.WB_TOKEN) return process.env.WB_TOKEN.trim();
  if (!email) throw new Error('Укажите --email или WB_TOKEN');
  const db = require('../db');
  try {
    const row = await db.getAsync('SELECT wb_api_token FROM users WHERE LOWER(email)=LOWER(?)', [email]);
    if (!row?.wb_api_token) throw new Error('У пользователя нет WB-токена');
    return row.wb_api_token;
  } finally {
    await db.close();
  }
}

const moscowDate = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(date);

async function main() {
  const date = arg('date') || moscowDate(new Date());
  const token = await resolveToken(arg('email'));

  console.log(`\n=== Дата ${date} (МСК), сейчас ${new Date().toISOString()} ===`);

  const funnel = await createSalesFunnelService().getProducts({
    token,
    selectedPeriod: { start: date, end: date }
  });
  const funnelRows = funnel.products
    .map(item => ({
      nmId: item?.product?.nmId,
      vendorCode: item?.product?.vendorCode,
      orderCount: item?.statistic?.selected?.orderCount,
      orderSum: item?.statistic?.selected?.orderSum
    }))
    .filter(row => row.orderCount || row.orderSum);
  console.log(`\n--- Sales Funnel v3, валюта: ${funnel.currency} ---`);
  console.table(funnelRows);
  console.log('Итого:', funnelRows.reduce((s, r) => s + (r.orderCount || 0), 0), 'шт,',
    funnelRows.reduce((s, r) => s + (r.orderSum || 0), 0));

  const response = await fetch(
    `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${date}&flag=1`,
    { headers: { Authorization: token }, signal: AbortSignal.timeout(30_000) }
  );
  if (!response.ok) throw new Error(`Statistics API ${response.status}: ${await response.text()}`);
  const orders = await response.json();
  console.log(`\n--- Statistics /supplier/orders (flag=1), строк: ${orders.length} ---`);
  console.table(orders.map(o => ({
    date: o.date,
    lastChange: o.lastChangeDate,
    nmId: o.nmId,
    article: o.supplierArticle,
    totalPrice: o.totalPrice,
    discount: o.discountPercent,
    spp: o.spp,
    priceWithDisc: o.priceWithDisc,
    finishedPrice: o.finishedPrice,
    isCancel: o.isCancel,
    orderType: o.orderType
  })));
  const sum = field => orders.reduce((s, o) => s + Number(o[field] || 0), 0);
  console.log('Итого строк:', orders.length, '| отменённых:', orders.filter(o => o.isCancel).length);
  console.log('Σ totalPrice:', sum('totalPrice').toFixed(2),
    '| Σ priceWithDisc:', sum('priceWithDisc').toFixed(2),
    '| Σ finishedPrice:', sum('finishedPrice').toFixed(2));
}

main().catch(error => {
  console.error('Ошибка:', error.message);
  process.exitCode = 1;
});
