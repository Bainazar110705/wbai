// Прибыль по каждому товару из строк финотчёта WB — те же статьи, что в
// «Отчёте о прибыли» магазина. Реклама — фактический расход кампаний товара
// (строки «Реклама» из wb-ad-cost.service), её не делим по продажам: реклама
// без товара и удержания за дни без статистики идут в «Общие расходы магазина».
// Остальные строки без товара делятся: хранение — по отчёту WB «Платное
// хранение», прочее — по продажам. Сумма по всем товарам = магазин.
const { calculateRealizedCogs, normalizeVendorCode } = require('./wb-finance.service');

const MONEY_FIELDS = [
  'retailAmount', 'commission', 'payable', 'logistics', 'storage', 'acceptance',
  'penalty', 'deduction', 'advertising', 'additionalPayment', 'margin'
];
// Товар, на который ложатся общие расходы, если в периоде не было ни одной продажи.
const SHOP_KEY = 'shop';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyMoney() {
  return Object.fromEntries(MONEY_FIELDS.map(field => [field, 0]));
}

function addRow(target, row) {
  for (const field of MONEY_FIELDS) target[field] += number(row[field]);
}

function ratio(part, total) {
  return total ? part / total : null;
}

function round(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundMoney(money) {
  return Object.fromEntries(Object.entries(money).map(([field, value]) => [field, round(value)]));
}

function weightsFrom(values) {
  const positive = [...values].filter(([, value]) => value > 0);
  const total = positive.reduce((sum, [, value]) => sum + value, 0);
  return total ? new Map(positive.map(([key, value]) => [key, value / total])) : null;
}

function buildProductPnl({
  rows = [],
  costsByVendorCode = {},
  adSpendByNm = new Map(),
  storageByNm = new Map(),
  catalog = [],
  toKzt = number,
  detailKey = null,
  // Дни, за которые реклама — фактический расход кампаний (null — нет статистики).
  adsCoverage = null,
  adsReplaced = false
} = {}) {
  const byVendor = new Map();
  for (const item of catalog) {
    const vendorCode = normalizeVendorCode(item.vendor_code ?? item.vendorCode);
    if (vendorCode) byVendor.set(vendorCode, number(item.nm_id ?? item.nmId));
  }
  const cardByNm = new Map(catalog.map(item => [number(item.nm_id ?? item.nmId), item]));
  const kindsKnown = rows.some(row => row.deductionKind !== undefined);

  const keyOf = row => {
    const nmId = number(row.nmId);
    if (nmId > 0) return `nm:${nmId}`;
    const vendorCode = normalizeVendorCode(row.vendorCode);
    if (!vendorCode) return null;
    const mapped = byVendor.get(vendorCode);
    return mapped ? `nm:${mapped}` : `vc:${vendorCode}`;
  };

  const products = new Map();
  const productFor = (key, row = {}) => {
    let product = products.get(key);
    if (!product) {
      const nmId = key.startsWith('nm:') ? number(key.slice(3)) : null;
      const card = nmId ? cardByNm.get(nmId) : null;
      product = {
        key,
        nmId,
        vendorCode: String(row.vendorCode || card?.vendor_code || card?.vendorCode || '').trim(),
        title: String(card?.title || '').trim(),
        subject: String(card?.subject || '').trim(),
        rows: [],
        days: new Map()
      };
      products.set(key, product);
    }
    if (!product.vendorCode && row.vendorCode) product.vendorCode = String(row.vendorCode).trim();
    return product;
  };
  const dayOf = (map, date) => {
    if (!map.has(date)) map.set(date, emptyMoney());
    return map.get(date);
  };

  // Общие расходы по дням: строки без товара. Реклама без товара сразу идёт
  // в «Общие расходы магазина» — по продажам её не делим.
  const pool = new Map();
  for (const row of rows) {
    const key = keyOf(row) || (number(row.advertising) ? SHOP_KEY : null);
    if (key) {
      const product = productFor(key, row);
      product.rows.push(row);
      addRow(dayOf(product.days, row.date), row);
    } else {
      addRow(dayOf(pool, row.date), row);
    }
  }
  // Товар с хранением, но без продаж в периоде, тоже получает свою долю.
  for (const [nmId, cost] of storageByNm) if (cost > 0 && !products.has(`nm:${nmId}`)) productFor(`nm:${nmId}`);

  const retailOf = product => [...product.days.values()].reduce((sum, money) => sum + money.retailAmount, 0);
  const salesWeights = weightsFrom([...products.values()].filter(product => product.key !== SHOP_KEY).map(product => [product.key, retailOf(product)]));
  const byNmWeights = source => weightsFrom([...products.values()].map(product => [product.key, product.nmId ? number(source.get(product.nmId)) : 0]));
  const storageWeights = byNmWeights(storageByNm) || salesWeights;
  if (!salesWeights && pool.size) productFor(SHOP_KEY);
  const adsCovered = date => !!(adsReplaced && adsCoverage?.from && adsCoverage?.to && date >= adsCoverage.from && date <= adsCoverage.to);

  // Хранение без товара — по расходу на хранение; итог «margin» строки переносится
  // вместе со своей статьёй, чтобы прибыль товара сходилась со статьями.
  const allocate = (source, weightsFor) => {
    for (const [date, money] of source) {
      for (const field of MONEY_FIELDS) {
        if (field === 'margin' || !money[field]) continue;
        const weights = weightsFor(field);
        // Вклад статьи в «Итого от WB»: доходы прибавляют, расходы вычитают.
        const marginSign = ['payable', 'additionalPayment'].includes(field) ? 1 : (['retailAmount', 'commission'].includes(field) ? 0 : -1);
        for (const product of products.values()) {
          const share = weights ? weights.get(product.key) || 0 : (product.key === SHOP_KEY ? 1 : 0);
          if (!share) continue;
          const day = dayOf(product.days, date);
          product.allocated = product.allocated || emptyMoney();
          const amount = money[field] * share;
          day[field] += amount;
          product.allocated[field] += amount;
          day.margin += marginSign * amount;
          product.allocated.margin += marginSign * amount;
        }
      }
    }
  };
  allocate(pool, field => (field === 'storage' ? storageWeights : salesWeights));

  const shop = emptyMoney();
  let shopCogs = 0;
  const list = [];
  for (const product of products.values()) {
    const totals = emptyMoney();
    for (const money of product.days.values()) for (const field of MONEY_FIELDS) totals[field] += money[field];
    for (const field of MONEY_FIELDS) shop[field] += totals[field];
    const cogs = calculateRealizedCogs(product.rows, costsByVendorCode);
    shopCogs += cogs.cogs;
    const retail = toKzt(totals.retailAmount);
    const profit = toKzt(totals.margin) - cogs.cogs;
    // ДРР — фактический расход товара на рекламу к его выручке за те же дни.
    // Без статистики рекламы (старые данные без типа удержаний) — расход по
    // кампаниям справочно, в прибыль он не входит.
    const advertising = toKzt(totals.advertising);
    const adSpend = adsReplaced ? advertising : (product.nmId ? number(adSpendByNm.get(product.nmId)) : 0);
    const retailForAds = adsReplaced
      ? toKzt([...product.days.entries()].reduce((sum, [date, money]) => sum + (adsCovered(date) ? money.retailAmount : 0), 0))
      : retail;
    const entry = {
      key: product.key,
      nmId: product.nmId,
      vendorCode: product.vendorCode,
      title: product.key === SHOP_KEY ? 'Общие расходы магазина' : product.title,
      subject: product.subject,
      totals: {
        ...roundMoney(Object.fromEntries(MONEY_FIELDS.map(field => [field, toKzt(totals[field])]))),
        otherDeduction: round(toKzt(totals.deduction)),
        // Расходы WB без рекламы: реклама — отдельной колонкой.
        wbCosts: round(toKzt(totals.retailAmount - totals.margin - totals.advertising)),
        cogs: round(cogs.cogs),
        profit: round(profit)
      },
      allocated: product.allocated ? roundMoney(Object.fromEntries(MONEY_FIELDS.map(field => [field, toKzt(product.allocated[field])]))) : null,
      units: { sold: cogs.soldUnits, returned: cogs.returnedUnits, net: cogs.netUnits },
      metrics: {
        marginPct: round(ratio(profit, retail) === null ? null : ratio(profit, retail) * 100, 1),
        roi: round(cogs.cogs > 0 ? (profit / cogs.cogs) * 100 : null, 1),
        profitPerUnit: round(cogs.netUnits > 0 ? profit / cogs.netUnits : null),
        avgPrice: round(cogs.netUnits > 0 ? retail / cogs.netUnits : null),
        adSpend: round(adSpend),
        drr: product.key === SHOP_KEY ? null : round(retailForAds > 0 ? (adSpend / retailForAds) * 100 : null, 1)
      },
      flags: {
        unpriced: cogs.unpricedUnits > 0,
        noSales: cogs.soldUnits === 0,
        allocated: !!product.allocated
      }
    };
    if (detailKey && product.key === detailKey) {
      entry.days = [...product.days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, money]) => {
          const dayCogs = calculateRealizedCogs(product.rows.filter(row => row.date === date), costsByVendorCode).cogs;
          return {
            date,
            retailAmount: round(toKzt(money.retailAmount)),
            wbCosts: round(toKzt(money.retailAmount - money.margin)),
            cogs: round(dayCogs),
            profit: round(toKzt(money.margin) - dayCogs)
          };
        });
    }
    // Копеечный расход без товара не стоит отдельной пустой строки.
    const empty = product.key === SHOP_KEY && Object.values(entry.totals).every(value => !value);
    if (!empty) list.push(entry);
  }

  // Контроль: товары в сумме дают магазин — по исходным строкам, без округлений.
  const source = emptyMoney();
  for (const row of rows) addRow(source, row);
  const diffs = MONEY_FIELDS
    .map(field => ({ field, diff: round(toKzt(shop[field] - source[field]), 2) }))
    .filter(item => Math.abs(item.diff) >= 1);

  return {
    kindsKnown,
    adsReplaced,
    products: list.sort((a, b) => (b.totals.profit ?? 0) - (a.totals.profit ?? 0)),
    shop: {
      ...roundMoney(Object.fromEntries(MONEY_FIELDS.map(field => [field, toKzt(shop[field])]))),
      wbCosts: round(toKzt(shop.retailAmount - shop.margin - shop.advertising)),
      cogs: round(shopCogs),
      profit: round(toKzt(shop.margin) - shopCogs)
    },
    check: { ok: diffs.length === 0, diffs }
  };
}

module.exports = { buildProductPnl, SHOP_KEY, MONEY_FIELDS };
