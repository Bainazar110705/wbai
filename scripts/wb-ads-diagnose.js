// Сверка рекламных затрат с WB Продвижение («Статистика» и «Финансы → История затрат»).
// Запуск: WB_TOKEN=... node scripts/wb-ads-diagnose.js --from 2026-10-01 --to 2026-10-28
// Или на сервере: docker compose exec app node scripts/wb-ads-diagnose.js --email user@mail --from ... --to ...
// Период не больше 31 дня. Печатает только суммы, токен не выводится.
require('dotenv').config();

const ADVERT_API = 'https://advert-api.wildberries.ru';
const STATUS_NAMES = { '-1': 'удалена', 4: 'готова к запуску', 7: 'завершена (архив)', 8: 'отменена', 9: 'активна', 11: 'на паузе' };

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
const statusName = status => STATUS_NAMES[status] || `статус ${status}`;

async function wbGet(path, token) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${ADVERT_API}${path}`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(60_000)
    });
    if (response.status === 429 && attempt < 5) {
      const retrySeconds = Math.max(Number(response.headers.get('x-ratelimit-retry')) || 20, 1) + 1;
      if (retrySeconds > 300) throw new Error(`WB ограничил API рекламы на ${Math.ceil(retrySeconds / 60)} мин.`);
      console.log(`WB 429: жду ${retrySeconds} с`);
      await wait(retrySeconds * 1000);
      continue;
    }
    if (!response.ok) throw new Error(`${path.split('?')[0]} ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  }
}

function sumBy(items, keyOf, valueOf) {
  const totals = new Map();
  for (const item of items) {
    const key = keyOf(item);
    totals.set(key, (totals.get(key) || 0) + valueOf(item));
  }
  return [...totals].map(([key, amount]) => ({ key, amount: fmt(amount) })).sort((a, b) => b.amount - a.amount);
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  if (!from || !to) throw new Error('Укажите --from и --to (YYYY-MM-DD), период до 31 дня');
  const token = await resolveToken(arg('email'));

  // 1. Списания — то же, что «Финансы → История затрат» в WB Продвижение.
  const charges = await wbGet(`/adv/v1/upd?from=${from}&to=${to}`, token);
  const chargeList = Array.isArray(charges) ? charges : [];
  const chargeTotal = chargeList.reduce((sum, charge) => sum + num(charge.updSum), 0);
  console.log(`\n=== Списания /adv/v1/upd ${from}…${to}: строк ${chargeList.length}, сумма ${fmt(chargeTotal)} ===`);
  console.log('\nПо источнику списания:');
  console.table(sumBy(chargeList, charge => charge.paymentType || '—', charge => num(charge.updSum)));
  console.log('По статусу кампании:');
  console.table(sumBy(chargeList, charge => statusName(charge.advertStatus), charge => num(charge.updSum)));

  // 2. Статистика кампаний — то же, что страница «Статистика» в WB Продвижение.
  const campaignsPayload = await wbGet('/api/advert/v2/adverts', token);
  const groups = Array.isArray(campaignsPayload?.adverts) ? campaignsPayload.adverts : [];
  const campaigns = new Map();
  for (const group of groups) {
    for (const item of Array.isArray(group?.advert_list) ? group.advert_list.map(entry => ({ ...group, ...entry })) : [group]) {
      const id = num(item?.advertId ?? item?.id);
      if (id > 0) campaigns.set(id, { id, status: item.status ?? group?.status });
    }
  }
  // Кампании, по которым были списания, но которых нет в списке (например, удалённые).
  for (const charge of chargeList) {
    const id = num(charge.advertId);
    if (id > 0 && !campaigns.has(id)) campaigns.set(id, { id, status: charge.advertStatus });
  }
  console.log(`Кампаний: ${campaigns.size}`);
  console.table(sumBy([...campaigns.values()], campaign => statusName(campaign.status), () => 1));

  const ids = [...campaigns.keys()];
  const stats = [];
  for (let index = 0; index < ids.length; index += 50) {
    if (index > 0) await wait(20_000); // лимит fullstats — 1 запрос в 20 секунд
    const batch = await wbGet(`/adv/v3/fullstats?ids=${ids.slice(index, index + 50).join(',')}&beginDate=${from}&endDate=${to}`, token);
    stats.push(...(Array.isArray(batch) ? batch : []));
  }
  const rows = stats.map(item => ({
    status: statusName(campaigns.get(num(item.advertId))?.status),
    sum: num(item.sum),
    sumPrice: num(item.sum_price),
    views: num(item.views),
    clicks: num(item.clicks)
  }));
  const total = field => rows.reduce((sum, row) => sum + row[field], 0);
  console.log(`\n=== Статистика /adv/v3/fullstats: кампаний со статистикой ${rows.length} ===`);
  console.table({
    'Затраты': fmt(total('sum')),
    'Сумма заказов': fmt(total('sumPrice')),
    'Доля затрат, %': total('sumPrice') ? fmt(total('sum') / total('sumPrice') * 100) : 0,
    'ROAS': total('sum') ? fmt(total('sumPrice') / total('sum')) : 0,
    'CTR, %': total('views') ? fmt(total('clicks') / total('views') * 100) : 0
  });
  console.log('Затраты и сумма заказов по статусу кампании:');
  const byStatus = new Map();
  for (const row of rows) {
    const item = byStatus.get(row.status) || { status: row.status, campaigns: 0, sum: 0, sumPrice: 0 };
    item.campaigns++;
    item.sum += row.sum;
    item.sumPrice += row.sumPrice;
    byStatus.set(row.status, item);
  }
  console.table([...byStatus.values()].map(item => ({ ...item, sum: fmt(item.sum), sumPrice: fmt(item.sumPrice) })));
}

main().catch(error => {
  console.error('Ошибка:', error.message);
  process.exitCode = 1;
});
