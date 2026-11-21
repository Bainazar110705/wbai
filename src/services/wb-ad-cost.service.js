// Реклама в прибыли — фактический расход кампаний WB Продвижение по дням и
// товарам (статистика кампаний, совпадает со списаниями WB), а не удержания
// «WB Продвижение» в финотчёте. Удержание — это пополнение рекламного баланса:
// WB удерживает его раз в неделю, а часть баланса продавец пополняет картой,
// и тогда в финотчёте её нет вовсе. Поэтому:
//  - за дни, по которым загружена статистика рекламы, удержания «WB Продвижение»
//    убираем и добавляем строки «Реклама» с расходом каждого товара за день;
//  - за дни без статистики оставляем удержание как рекламу магазина без
//    разбивки по товарам (не делим его по продажам — это дало бы всем товарам
//    одинаковый ДРР).
// Строки «Реклама» имеют те же поля, что строки финотчёта, поэтому итоги
// магазина, график и прибыль по товарам считаются из одних и тех же строк.
const AD_OPERATION = 'Реклама WB Продвижение';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function adRow({ date, nmId = null, vendorCode = '', advertising, currency }) {
  return {
    date,
    nmId: nmId || null,
    vendorCode,
    currency,
    quantity: 0,
    operation: AD_OPERATION,
    documentType: '',
    deductionKind: 'ads',
    retailAmount: 0,
    sales: 0,
    payable: 0,
    commission: 0,
    logistics: 0,
    storage: 0,
    penalty: 0,
    deduction: 0,
    acceptance: 0,
    additionalPayment: 0,
    advertising,
    margin: -advertising,
    synthetic: true
  };
}

// rows — строки финотчёта; spendRows — [{ day, nm_id, spend }] из wb_ad_spend_daily;
// coverage — { from, to }: дни, за которые статистика рекламы загружена;
// spendToFinance — перевод расхода рекламы в валюту финотчёта.
function applyAdSpend(rows, { spendRows = [], coverage = null, spendToFinance = number, currency = null, vendorCodeOf = () => '' } = {}) {
  const source = Array.isArray(rows) ? rows : [];
  // Без типа удержаний рекламу из удержаний не отделить — оставляем как есть,
  // иначе реклама посчиталась бы дважды.
  const kindsKnown = source.some(row => row.deductionKind !== undefined);
  if (!kindsKnown) return { rows: source, adsReplaced: false, coverage: null };

  const covered = day => !!(coverage?.from && coverage?.to && day >= coverage.from && day <= coverage.to);
  const financeCurrency = currency || source.find(row => row.currency)?.currency || null;
  const result = [];
  for (const row of source) {
    if (row.deductionKind !== 'ads' || row.synthetic || !number(row.deduction)) {
      result.push(row);
      continue;
    }
    if (covered(row.date)) {
      // Удержание за пополнение баланса заменяется фактическим расходом ниже.
      result.push({ ...row, deduction: 0, advertising: 0, margin: number(row.margin) + number(row.deduction) });
    } else {
      // Дней без статистики: удержание и есть лучшая оценка рекламы магазина.
      result.push({ ...row, deduction: 0, advertising: number(row.deduction), nmId: null, vendorCode: '' });
    }
  }

  for (const spend of spendRows) {
    const day = String(spend.day || '').slice(0, 10);
    const amount = spendToFinance(number(spend.spend));
    if (!covered(day) || !amount) continue;
    const nmId = number(spend.nm_id ?? spend.nmId);
    result.push(adRow({ date: day, nmId, vendorCode: nmId ? vendorCodeOf(nmId) : '', advertising: amount, currency: financeCurrency }));
  }
  return { rows: result, adsReplaced: true, coverage: coverage?.from && coverage?.to ? { from: coverage.from, to: coverage.to } : null };
}

// Перевод расхода рекламы (валюта кабинета рекламы) в валюту финотчёта.
function spendConverter(adsCurrency, financeCurrency, rubKztRate) {
  const ads = String(adsCurrency || financeCurrency || '').toUpperCase();
  const finance = String(financeCurrency || ads || '').toUpperCase();
  if (!ads || ads === finance) return number;
  if (ads === 'RUB' && finance === 'KZT') return value => number(value) * rubKztRate;
  if (ads === 'KZT' && finance === 'RUB') return value => (rubKztRate ? number(value) / rubKztRate : 0);
  return number;
}

module.exports = { applyAdSpend, spendConverter, AD_OPERATION };
