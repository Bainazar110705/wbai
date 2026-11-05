// Этап 0 для РНП («Рука на пульсе»): проверяет, какие данные по дням отдаёт WB.
// Запуск локально:  WB_TOKEN=... node scripts/wb-rnp-diagnose.js --from 2026-10-01 --to 2026-10-29
// Или на сервере:   docker compose exec app node scripts/wb-rnp-diagnose.js --email user@mail --from ... --to ...
// Печатает только суммы и названия полей, токен не выводится. Работает несколько минут из-за лимитов WB.
// Только часть шагов: --only stocks (шаги: orders, sales, ads, stocks, funnel).
require('dotenv').config();
const { createSalesFunnelService, normalizeFunnelProduct } = require('../src/services/wb-sales-funnel.service');
const { extractAdvertisingCampaigns, splitAdvertisingPeriod } = require('../src/services/wb-advertising.service');

const STATISTICS_API = 'https://statistics-api.wildberries.ru';
const ADVERT_API = 'https://advert-api.wildberries.ru';

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

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const fmt = value => Math.round(value * 100) / 100;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const day = value => String(value || '').slice(0, 10);

async function wbGet(url, token) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { Authorization: token }, signal: AbortSignal.timeout(120_000) });
    if (response.status === 429 && attempt < 6) {
      const retrySeconds = Math.max(num(response.headers.get('x-ratelimit-retry')) || 61, 1) + 1;
      console.log(`  WB 429: жду ${retrySeconds} с…`);
      await wait(retrySeconds * 1000);
      continue;
    }
    if (!response.ok) {
      const error = new Error(`${url.split('?')[0]} → ${response.status}: ${(await response.text()).slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
}

// flag=0: строки, изменённые после dateFrom; листаем по lastChangeDate последней строки.
async function loadStatistics(method, from, token) {
  const rows = [];
  let cursor = from;
  for (let page = 1; page <= 20; page++) {
    const batch = await wbGet(`${STATISTICS_API}/api/v1/supplier/${method}?dateFrom=${encodeURIComponent(cursor)}&flag=0`, token);
    const list = Array.isArray(batch) ? batch : [];
    rows.push(...list);
    console.log(`  ${method}: страница ${page}, строк ${list.length}`);
    if (list.length < 50_000) break;
    cursor = list[list.length - 1].lastChangeDate;
    await wait(61_000);
  }
  return rows;
}

function groupByDay(rows, from, to, init, add) {
  const days = new Map();
  for (const row of rows) {
    const key = day(row.date);
    if (key < from || key > to) continue;
    if (!days.has(key)) days.set(key, init());
    add(days.get(key), row);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ date, ...totals }));
}

function printTotals(title, table) {
  console.table(table.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? fmt(value) : value]))));
  const totals = {};
  for (const row of table) for (const [key, value] of Object.entries(row)) if (typeof value === 'number') totals[key] = (totals[key] || 0) + value;
  console.log(`${title} — итого:`, Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, fmt(value)])));
}

async function checkOrders(from, to, token) {
  console.log('\n=== 1. Заказы /supplier/orders ===');
  const orders = await loadStatistics('orders', from, token);
  if (orders[0]) console.log('Поля строки:', Object.keys(orders[0]).join(', '));
  const inPeriod = orders.filter(row => day(row.date) >= from && day(row.date) <= to);
  console.log(`Строк всего ${orders.length}, в периоде ${inPeriod.length}, уникальных srid ${new Set(inPeriod.map(row => row.srid)).size}`);
  printTotals('Заказы', groupByDay(orders, from, to,
    () => ({ count: 0, priceWithDisc: 0, finishedPrice: 0, cancels: 0 }),
    (totals, row) => {
      totals.count++;
      totals.priceWithDisc += num(row.priceWithDisc);
      totals.finishedPrice += num(row.finishedPrice);
      if (row.isCancel) totals.cancels++;
    }));
  return orders;
}

async function checkSales(from, to, token) {
  console.log('\n=== 2. Выкупы и возвраты /supplier/sales ===');
  const sales = await loadStatistics('sales', from, token);
  if (sales[0]) console.log('Поля строки:', Object.keys(sales[0]).join(', '));
  printTotals('Выкупы', groupByDay(sales, from, to,
    () => ({ sales: 0, returns: 0, priceWithDisc: 0, forPay: 0, finishedPrice: 0 }),
    (totals, row) => {
      if (String(row.saleID || '').startsWith('R')) totals.returns++;
      else totals.sales++;
      totals.priceWithDisc += num(row.priceWithDisc);
      totals.forPay += num(row.forPay);
      totals.finishedPrice += num(row.finishedPrice);
    }));
}

async function checkAds(from, to, token) {
  console.log('\n=== 3. Реклама по дням и артикулам /adv/v3/fullstats ===');
  const campaigns = extractAdvertisingCampaigns(await wbGet(`${ADVERT_API}/api/advert/v2/adverts`, token));
  const byDay = new Map();
  const byNm = new Map();
  let campaignTotal = 0;
  let nmTotal = 0;
  let sample = null;
  for (const period of splitAdvertisingPeriod(from, to)) {
    const ids = new Set(campaigns.map(campaign => campaign.id));
    const charges = await wbGet(`${ADVERT_API}/adv/v1/upd?from=${period.from}&to=${period.to}`, token);
    for (const charge of Array.isArray(charges) ? charges : []) if (num(charge?.advertId) > 0) ids.add(num(charge.advertId));
    const idList = [...ids];
    for (let index = 0; index < idList.length; index += 50) {
      const stats = await wbGet(`${ADVERT_API}/adv/v3/fullstats?ids=${idList.slice(index, index + 50).join(',')}&beginDate=${period.from}&endDate=${period.to}`, token);
      for (const item of Array.isArray(stats) ? stats : []) {
        campaignTotal += num(item.sum);
        for (const dayStats of Array.isArray(item.days) ? item.days : []) {
          byDay.set(day(dayStats.date), (byDay.get(day(dayStats.date)) || 0) + num(dayStats.sum));
          for (const app of Array.isArray(dayStats.apps) ? dayStats.apps : []) {
            for (const nm of Array.isArray(app.nms) ? app.nms : (Array.isArray(app.nm) ? app.nm : [])) {
              if (!sample) sample = { day: Object.keys(dayStats), app: Object.keys(app), nm: Object.keys(nm) };
              byNm.set(nm.nmId, (byNm.get(nm.nmId) || 0) + num(nm.sum));
              nmTotal += num(nm.sum);
            }
          }
        }
      }
      await wait(20_000);
    }
  }
  console.log('Поля:', sample ? JSON.stringify(sample) : 'разбивки по артикулам нет');
  printTotals('Реклама', [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, spend]) => ({ date, spend })));
  console.log(`Сумма по кампаниям ${fmt(campaignTotal)}, сумма по артикулам ${fmt(nmTotal)} (должны совпадать)`);
  console.table([...byNm].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([nmId, spend]) => ({ nmId, spend: fmt(spend) })));
}

// Старый отчёт /supplier/stocks WB отключил; остатки и названия теперь берём из воронки.
async function checkStocks(token) {
  console.log('\n=== 4. Названия и остатки из воронки продаж ===');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const funnel = await createSalesFunnelService().getProducts({ token, selectedPeriod: { start: today, end: today } });
  console.log(`Товаров ${funnel.products.length}`);
  console.log('Пример поля stocks:', JSON.stringify(funnel.products.slice(0, 3).map(item => ({ nmId: item?.product?.nmId, title: item?.product?.title, stocks: item?.product?.stocks })), null, 1));
  const normalized = funnel.products.map(normalizeFunnelProduct).filter(Boolean);
  console.log(`Как прочитал сайт: всего WB ${normalized.reduce((s, p) => s + p.stockWb, 0)} шт, FBS ${normalized.reduce((s, p) => s + p.stockMp, 0)} шт`);
}

async function checkFunnel(from, to, token) {
  console.log('\n=== 5. Для сверки: Sales Funnel за весь период ===');
  const funnel = await createSalesFunnelService().getProducts({ token, selectedPeriod: { start: from, end: to } });
  const sum = field => funnel.products.reduce((s, item) => s + num(item?.statistic?.selected?.[field]), 0);
  console.log(`Валюта ${funnel.currency}: заказы ${sum('orderCount')} шт на ${fmt(sum('orderSum'))}, выкупы ${sum('buyoutCount')} шт на ${fmt(sum('buyoutSum'))}`);
  const sample = funnel.products[0]?.product;
  if (sample) console.log('Поля товара:', Object.keys(sample).join(', '));
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  if (!from || !to) throw new Error('Укажите --from и --to (YYYY-MM-DD)');
  const token = await resolveToken(arg('email'));
  const steps = {
    orders: () => checkOrders(from, to, token),
    sales: () => checkSales(from, to, token),
    ads: () => checkAds(from, to, token),
    stocks: () => checkStocks(token),
    funnel: () => checkFunnel(from, to, token)
  };
  // --only stocks,funnel — запустить только нужные шаги.
  const only = arg('only') ? arg('only').split(',') : Object.keys(steps);
  for (const step of only.map(name => steps[name]).filter(Boolean)) {
    try {
      await step();
    } catch (error) {
      console.log('Ошибка шага:', error.message);
    }
  }
}

main().catch(error => {
  console.error('Ошибка:', error.message);
  process.exitCode = 1;
});
