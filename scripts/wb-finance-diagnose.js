// Сверка финотчёта WB с экраном «Баланс» в WB Partners.
// Запуск на сервере:  docker compose exec app node scripts/wb-finance-diagnose.js --email user@mail --from 2026-09-27 --to 2026-10-26
// Или локально:       WB_TOKEN=... node scripts/wb-finance-diagnose.js --from 2026-09-27 --to 2026-10-26 [--period weekly] [--dump rows.json]
// Печатает только суммы по типам операций, токен не выводится.
require('dotenv').config();
const { FINANCE_DETAILS_URL, FINANCE_PAGE_LIMIT, normalizeFinanceRows } = require('../src/services/wb-finance.service');

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

const MONEY_FIELDS = [
  'retailAmount', 'forPay', 'ppvzSalesCommission', 'acquiringFee', 'ppvzReward', 'vw', 'vwNds',
  'deliveryService', 'rebillLogisticCost', 'paidStorage', 'penalty', 'deduction', 'paidAcceptance',
  'additionalPayment', 'cashbackAmount'
];
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const fmt = value => Math.round(value * 100) / 100;

async function main() {
  const dateFrom = arg('from');
  const dateTo = arg('to');
  const period = arg('period') || 'daily';
  if (!dateFrom || !dateTo) throw new Error('Укажите --from и --to (YYYY-MM-DD)');
  const token = await resolveToken(arg('email'));

  // Без fields WB возвращает все поля строки. На 429 ждём столько, сколько просит WB.
  let response;
  for (let attempt = 1; ; attempt++) {
    response = await fetch(FINANCE_DETAILS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ dateFrom, dateTo, limit: FINANCE_PAGE_LIMIT, rrdId: 0, period }),
      signal: AbortSignal.timeout(60_000)
    });
    if (response.status !== 429 || attempt >= 5) break;
    const retrySeconds = Math.max(Number(response.headers.get('x-ratelimit-retry')) || 60, 1) + 1;
    if (retrySeconds > 300) {
      const until = new Date(Date.now() + retrySeconds * 1000).toLocaleString('ru-RU');
      throw new Error(`WB ограничил Finance API на ${Math.ceil(retrySeconds / 60)} мин. Повторите после ${until}.`);
    }
    console.log(`WB 429: жду ${retrySeconds} с и повторяю (попытка ${attempt + 1} из 5)`);
    await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
  }
  if (response.status === 204) return console.log('WB вернул 204: строк за период нет.');
  if (!response.ok) throw new Error(`Finance API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const rows = await response.json();
  if (arg('dump')) {
    // Сырые строки для разбора; токена в них нет.
    require('fs').writeFileSync(arg('dump'), JSON.stringify(rows));
    console.log(`Сырые строки сохранены в ${arg('dump')}`);
  }

  const reportTypes = [...new Set(rows.map(row => row.reportType))];
  const dates = rows.map(row => String(row.rrDate || '').slice(0, 10)).filter(Boolean).sort();
  console.log(`\n=== Финотчёт ${dateFrom}…${dateTo}, period=${period}, строк: ${rows.length}, валюта: ${rows[0]?.currency} ===`);
  console.log(`rrDate от ${dates[0]} до ${dates[dates.length - 1]}, reportType: ${reportTypes.join(', ')}`);

  // Суммы по типу документа и обоснованию — по ним видно знаки у возвратов.
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.docTypeName || '—'} | ${row.sellerOperName || '—'}`;
    const group = groups.get(key) || { key, rows: 0, quantity: 0, ...Object.fromEntries(MONEY_FIELDS.map(f => [f, 0])) };
    group.rows++;
    group.quantity += num(row.quantity);
    MONEY_FIELDS.forEach(field => { group[field] += num(row[field]); });
    groups.set(key, group);
  }
  console.log('\n--- По типу документа | обоснованию ---');
  for (const group of [...groups.values()].sort((a, b) => b.rows - a.rows)) {
    console.log(`\n${group.key}: строк ${group.rows}, кол-во ${group.quantity}`);
    console.log(Object.fromEntries(MONEY_FIELDS.filter(f => group[f]).map(f => [f, fmt(group[f])])));
  }

  // Строки с удержаниями и штрафами — что именно WB удерживает.
  const reasons = new Map();
  for (const row of rows) {
    const amount = num(row.deduction) + num(row.penalty);
    if (!amount) continue;
    const key = `${row.sellerOperName || '—'} | ${row.bonusTypeName || '—'}`;
    reasons.set(key, (reasons.get(key) || 0) + amount);
  }
  if (reasons.size) {
    console.log('\n--- Удержания и штрафы по видам ---');
    console.table([...reasons].map(([key, amount]) => ({ key, amount: fmt(amount) })));
  }

  // Знак по типу документа: возврат вычитается из продаж и из «к перечислению».
  const sign = row => (String(row.docTypeName || '').trim().toLocaleLowerCase('ru') === 'возврат' ? -1 : 1);
  const signed = field => rows.reduce((sum, row) => sum + sign(row) * num(row[field]), 0);
  const plain = field => rows.reduce((sum, row) => sum + num(row[field]), 0);
  const sales = signed('retailAmount');
  const toPay = signed('forPay');
  console.log('\n--- Как в «Балансе» WB (возвраты со знаком минус) ---');
  console.table({
    'Продажи (retailAmount)': fmt(sales),
    'Продажи по цене продавца (retailPriceWithDisc × кол-во)': fmt(rows.reduce((sum, row) => sum + sign(row) * num(row.retailPriceWithDisc) * Math.abs(num(row.quantity)), 0)),
    'К перечислению': fmt(toPay),
    'Комиссия WB (продажи − к перечислению)': fmt(sales - toPay),
    'Логистика': fmt(plain('deliveryService')),
    'Хранение': fmt(plain('paidStorage')),
    'Операции при приёмке': fmt(plain('paidAcceptance')),
    'Штрафы': fmt(plain('penalty')),
    'Доплаты': fmt(plain('additionalPayment')),
    'Удержание': fmt(plain('deduction'))
  });

  // По дням и типу отчёта — для сверки со списком «Финансовые отчёты» в WB Partners.
  const days = new Map();
  for (const row of rows) {
    const key = `${String(row.rrDate || '').slice(0, 10)} ${row.reportType ?? '—'}`;
    const day = days.get(key) || { key, sale: 0, toPay: 0, priceWithDisc: 0, logistics: 0, storage: 0, deduction: 0, penalty: 0 };
    day.sale += sign(row) * num(row.retailAmount);
    day.toPay += sign(row) * num(row.forPay);
    day.priceWithDisc += sign(row) * num(row.retailPriceWithDisc) * Math.abs(num(row.quantity));
    day.logistics += num(row.deliveryService);
    day.storage += num(row.paidStorage);
    day.deduction += num(row.deduction);
    day.penalty += num(row.penalty);
    days.set(key, day);
  }
  console.log('\n--- По дням (rrDate) и типу отчёта ---');
  console.table([...days.values()].sort((a, b) => a.key.localeCompare(b.key)).map(day =>
    Object.fromEntries(Object.entries(day).map(([k, v]) => [k, typeof v === 'number' ? fmt(v) : v]))));

  const logisticsKinds = new Map();
  for (const row of rows) {
    if (!num(row.deliveryService)) continue;
    const key = `${row.sellerOperName || '—'} | ${row.bonusTypeName || '—'}`;
    logisticsKinds.set(key, (logisticsKinds.get(key) || 0) + num(row.deliveryService));
  }
  console.log('\n--- Логистика по видам ---');
  console.table([...logisticsKinds].map(([key, amount]) => ({ key, amount: fmt(amount) })));

  const ours = normalizeFinanceRows(rows).rows;
  const oursSum = field => ours.reduce((sum, row) => sum + row[field], 0);
  console.log('\n--- Как сейчас считает WBai ---');
  console.table({
    'Продажи (retailAmount)': fmt(oursSum('retailAmount')),
    'Комиссия (ppvzSalesCommission + acquiringFee)': fmt(oursSum('commission')),
    'Логистика': fmt(oursSum('logistics')),
    'Хранение': fmt(oursSum('storage')),
    'Штрафы': fmt(oursSum('penalty')),
    'Удержание': fmt(oursSum('deduction')),
    'К перечислению': fmt(oursSum('payable'))
  });
}

main().catch(error => {
  console.error('Ошибка:', error.message);
  process.exitCode = 1;
});
