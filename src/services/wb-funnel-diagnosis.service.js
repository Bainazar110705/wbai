// Вывод по воронке продаж WB: «трафик или конверсия» по методике
// «продажи = трафик × конверсия». Заказы раскладываются на шаги
// переходы × конверсия в корзину × конверсия в заказ, и сравниваются
// с прошлым периодом той же длины. Данных о рынке и конкурентах в API
// нет, поэтому вопрос «у нас или у всех» вывод честно оставляет открытым.

const DROP_THRESHOLD = -0.1;
const GROWTH_THRESHOLD = 0.1;
// Товар: переходы упали на 20 % и больше — сломан трафик; конверсия ниже 85 % от прошлой — конверсия.
const PRODUCT_TRAFFIC_DROP = -0.2;
const PRODUCT_CONVERSION_RATIO = 0.85;
const PRODUCT_MIN_PREV_ORDERS = 3;
// Товар попадает в «Где сломалось», если его заказы упали хотя бы на 10 %.
const PRODUCT_MIN_DROP = 0.1;
const STOCK_RISK_DAYS = 14;
const MAX_PRODUCTS = 7;
const MAX_ACTIONS = 3;

const STEPS = [
  { key: 'opens', name: 'Переходы в карточку', kind: 'трафик' },
  { key: 'cartRate', name: 'Конверсия в корзину', kind: 'конверсия' },
  { key: 'orderRate', name: 'Конверсия в заказ', kind: 'конверсия' }
];

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(part, total) {
  return total ? part / total : null;
}

function change(current, previous) {
  return current === null || previous === null || !previous ? null : current / previous - 1;
}

function round(value, digits = 1) {
  if (value === null || value === undefined) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pct(value) {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}%`;
}

function share(value) {
  return `${(Math.round(value * 1000) / 10).toLocaleString('ru-RU')}%`;
}

function funnelOf(totals) {
  return {
    opens: totals.opens,
    carts: totals.carts,
    orders: totals.orders,
    cartRate: ratio(totals.carts, totals.opens),
    orderRate: ratio(totals.orders, totals.carts)
  };
}

function sumTotals(products, period, toKzt) {
  const totals = { opens: 0, carts: 0, orders: 0, orderSum: 0, hasOpens: false, hasCarts: false };
  for (const product of products) {
    const values = product[period] || {};
    if (values.opens !== null && values.opens !== undefined) totals.hasOpens = true;
    if (values.carts !== null && values.carts !== undefined) totals.hasCarts = true;
    totals.opens += number(values.opens);
    totals.carts += number(values.carts);
    totals.orders += number(values.orders);
    totals.orderSum += toKzt(values.orderSum);
  }
  return totals;
}

// Вклад шагов в изменение заказов через логарифмы: сумма долей = 100 %.
function splitSteps(current, previous) {
  return STEPS.map(step => {
    const cur = current[step.key];
    const prev = previous[step.key];
    const stepChange = change(cur, prev);
    const log = cur > 0 && prev > 0 ? Math.log(cur / prev) : null;
    return { ...step, current: cur, previous: prev, change: stepChange, log };
  });
}

function productBreak(product) {
  const cur = funnelOf(product.current);
  const prev = funnelOf(product.previous);
  const opensChange = change(cur.opens, prev.opens);
  if (opensChange !== null && opensChange <= PRODUCT_TRAFFIC_DROP) {
    return { kind: 'трафик', text: `трафик: переходы ${pct(opensChange)}` };
  }
  if (cur.cartRate !== null && prev.cartRate && cur.cartRate / prev.cartRate <= PRODUCT_CONVERSION_RATIO) {
    return { kind: 'конверсия', text: `конверсия в корзину ${pct(cur.cartRate / prev.cartRate - 1)}` };
  }
  if (cur.orderRate !== null && prev.orderRate && cur.orderRate / prev.orderRate <= PRODUCT_CONVERSION_RATIO) {
    return { kind: 'конверсия', text: `конверсия в заказ ${pct(cur.orderRate / prev.orderRate - 1)}` };
  }
  return null;
}

function headlineFor(mode, worst, best, ordersChange) {
  if (mode === 'drop' && worst) {
    const what = {
      opens: `в карточки стали меньше заходить (переходы ${pct(worst.change)})`,
      cartRate: `заходят, но реже кладут в корзину (${pct(worst.change)})`,
      orderRate: `кладут в корзину, но реже заказывают (${pct(worst.change)})`
    }[worst.key];
    return `Вывод: ${worst.kind}. Заказы ${pct(ordersChange)}: ${what}.`;
  }
  if (mode === 'drop') return `Заказы ${pct(ordersChange)}. Шаг, на котором теряем, по данным WB не определить.`;
  if (mode === 'growth' && best) {
    const what = { opens: 'трафик: переходы', cartRate: 'конверсия в корзину', orderRate: 'конверсия в заказ' }[best.key];
    return `Заказы растут: ${pct(ordersChange)}. Рост дал ${what} ${pct(best.change)}.`;
  }
  if (mode === 'growth') return `Заказы растут: ${pct(ordersChange)}.`;
  return `Заказы ровные: ${pct(ordersChange)} к прошлому периоду.`;
}

function buildActions({ mode, worst, steps, risky, breaks }) {
  const candidates = [];
  if (risky.length) {
    const names = risky.slice(0, 3).map(item => `${item.name} — ${item.stock.daysLeft} дн`).join(', ');
    candidates.push({
      stage: 1,
      title: 'Довезти товар, пока он не кончился',
      why: `Запаса меньше чем на ${STOCK_RISK_DAYS} дней: ${names}. Кончится товар — карточка потеряет позиции, и остальные правки не сработают.`,
      do: 'Отгрузить на склады WB запас на 30–45 дней и раскидать по регионам, а не только в один склад.',
      measure: 'Запас в днях выше 30, срок доставки не вырос.'
    });
  }
  const conversionStep = mode === 'drop' && worst?.kind === 'конверсия' ? worst.key
    : breaks.find(item => item.break?.kind === 'конверсия') ? 'products' : null;
  if (conversionStep === 'cartRate' || conversionStep === 'products') {
    candidates.push({
      stage: 3,
      title: 'Дожать карточку: заходят, но не кладут в корзину',
      why: conversionStep === 'cartRate'
        ? `Конверсия в корзину ${pct(worst.change)} к прошлому периоду.`
        : 'У части товаров упала конверсия, они отмечены в таблице «Где сломалось».',
      do: 'Пересобрать слайды: почему именно ваш товар, размерная сетка не дальше 4-го слайда, ответы на частые вопросы из отзывов.',
      measure: 'Конверсия в корзину через неделю.'
    });
  }
  if (conversionStep === 'orderRate') {
    candidates.push({
      stage: 3,
      title: 'Поднять конверсию в заказ',
      why: `Из корзины заказывают реже: ${pct(worst.change)}. В корзине покупатель видит только цену, срок доставки и первый слайд.`,
      do: 'Проверить три рычага: цену против конкурентов, срок доставки и первый слайд.',
      measure: 'Конверсия из корзины в заказ через неделю.'
    });
  }
  const conversionFell = steps.some(step => step.kind === 'конверсия' && step.change !== null && step.change <= -0.1);
  const trafficFell = steps[0].change !== null && steps[0].change <= -0.1;
  if (conversionFell) {
    candidates.push({
      stage: 4,
      title: 'Ставки в рекламе пока не поднимать',
      why: 'Конверсия просела. Пустую карточку рекламой не вытащишь: деньги уйдут, а заказов не прибавится.',
      do: 'Сначала вернуть конверсию правками карточки, потом добавлять трафик.',
      measure: 'Конверсия после правок контента.'
    });
  } else if (trafficFell) {
    candidates.push({
      stage: 4,
      title: 'Вернуть трафик',
      why: `Переходы ${pct(steps[0].change)}, а конверсия держится. Карточка продаёт, её просто меньше видят — реклама сработает поверх органики.`,
      do: 'Проверить остатки по регионам и участие в акциях, затем реклама в поиске на главные запросы.',
      measure: 'Переходы и позиции по главным запросам через неделю.'
    });
  }

  const picked = [];
  const stages = new Set();
  for (const action of candidates) {
    if (picked.length < MAX_ACTIONS && !stages.has(action.stage)) {
      picked.push(action);
      stages.add(action.stage);
    }
  }
  for (const action of candidates) if (picked.length < MAX_ACTIONS && !picked.includes(action)) picked.push(action);
  const stageNames = { 1: 'Склады', 3: 'Конверсии', 4: 'Реклама' };
  return picked.sort((a, b) => a.stage - b.stage).map(action => ({ ...action, stageName: stageNames[action.stage] }));
}

function diagnoseFunnel({ products = [], toKzt = number, stocks = null } = {}) {
  const current = sumTotals(products, 'current', toKzt);
  const previous = sumTotals(products, 'previous', toKzt);
  const limits = ['Сравниваем с прошлым периодом той же длины. Данных о конкурентах и спросе в API WB нет, поэтому «у нас или у всех» проверьте в «Аналитике поиска» или «Сравнении карточек» WB.'];
  if (!current.hasOpens || !current.hasCarts) {
    return { available: false, reason: 'WB не отдал переходы и корзины по товарам.', limits };
  }
  if (!previous.orders) {
    return { available: false, reason: 'В прошлом периоде заказов не было — сравнивать не с чем.', limits };
  }

  const steps = splitSteps(funnelOf(current), funnelOf(previous));
  const ordersChange = change(current.orders, previous.orders);
  const mode = ordersChange <= DROP_THRESHOLD ? 'drop' : ordersChange >= GROWTH_THRESHOLD ? 'growth' : 'stable';
  const measured = steps.filter(step => step.log !== null);
  const worst = measured.length ? measured.reduce((a, b) => (b.log < a.log ? b : a)) : null;
  const best = measured.length ? measured.reduce((a, b) => (b.log > a.log ? b : a)) : null;
  const totalLog = measured.reduce((sum, step) => sum + step.log, 0);

  const stockOf = nmId => (stocks ? stocks.get(nmId) || null : null);
  const named = product => product.title || product.vendorCode || `арт. ${product.nmId}`;
  const breaks = products
    .filter(product => number(product.previous.orders) >= PRODUCT_MIN_PREV_ORDERS
      && number(product.current.orders) <= number(product.previous.orders) * (1 - PRODUCT_MIN_DROP))
    .map(product => {
      const lostSum = toKzt(product.previous.orderSum) - toKzt(product.current.orderSum);
      const stock = stockOf(product.nmId);
      const found = productBreak(product);
      return {
        nmId: product.nmId,
        name: named(product),
        vendorCode: product.vendorCode,
        orders: number(product.current.orders),
        ordersPrev: number(product.previous.orders),
        lostSum: Math.round(lostSum),
        break: found || (stock?.daysLeft !== null && stock?.daysLeft !== undefined && stock.daysLeft < STOCK_RISK_DAYS
          ? { kind: 'склад', text: `мало остатков: на ${stock.daysLeft} дн.` }
          : null),
        stockDays: stock?.daysLeft ?? null
      };
    })
    .sort((a, b) => b.lostSum - a.lostSum)
    .slice(0, MAX_PRODUCTS);

  const risky = products
    .map(product => ({ name: named(product), orders: number(product.current.orders), stock: stockOf(product.nmId) }))
    .filter(item => item.orders > 0 && item.stock?.daysLeft !== null && item.stock?.daysLeft !== undefined && item.stock.daysLeft < STOCK_RISK_DAYS)
    .sort((a, b) => a.stock.daysLeft - b.stock.daysLeft);

  return {
    available: true,
    mode,
    kind: mode === 'drop' && worst ? worst.kind : null,
    headline: headlineFor(mode, worst, best, ordersChange),
    orders: current.orders,
    ordersPrev: previous.orders,
    ordersChange: round(ordersChange, 4),
    steps: steps.map(step => ({
      key: step.key,
      name: step.name,
      kind: step.kind,
      current: step.key === 'opens' ? step.current : round(step.current, 4),
      previous: step.key === 'opens' ? step.previous : round(step.previous, 4),
      change: round(step.change, 4),
      // Доля шага в изменении заказов; при почти нулевом изменении доли не показываем.
      share: Math.abs(totalLog) > 0.01 && step.log !== null ? round(step.log / totalLog, 3) : null
    })),
    worst: mode === 'drop' && worst ? worst.key : null,
    products: breaks,
    actions: buildActions({ mode, worst, steps, risky, breaks }),
    limits,
    shareText: Math.abs(totalLog) > 0.01
      ? measured.filter(step => step.log / totalLog > 0.05).map(step => `${step.name.toLowerCase()} — ${share(step.log / totalLog)}`).join(', ')
      : null
  };
}

module.exports = { diagnoseFunnel, productBreak, STOCK_RISK_DAYS };
