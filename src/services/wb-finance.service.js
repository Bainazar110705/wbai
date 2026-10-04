const FINANCE_DETAILS_URL = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';
const FINANCE_PAGE_LIMIT = 100_000;
const FINANCE_FIELDS = [
  'rrdId',
  'currency',
  'rrDate',
  'vendorCode',
  'quantity',
  'docTypeName',
  'sellerOperName',
  'retailAmount',
  'forPay',
  'ppvzSalesCommission',
  'acquiringFee',
  'deliveryService',
  'paidStorage',
  'penalty',
  'deduction',
  'paidAcceptance',
  'additionalPayment'
];

function financeApiError(status) {
  const messages = {
    400: 'WB отклонил период финансового отчёта.',
    401: 'Токен WB недействителен или не является персональным/сервисным.',
    402: 'Финансовый API WB недоступен для этого кабинета.',
    403: 'В токене WB нет доступа к категории «Финансы».',
    429: 'Лимит финансового API WB. Повторите обновление через минуту.'
  };
  const error = new Error(messages[status] || `WB Finance API вернул ошибку ${status}`);
  error.status = status === 429 ? 429 : (status >= 400 && status < 500 ? status : 502);
  error.code = `WB_FINANCE_${status}`;
  return error;
}

function moneyNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeFinanceRows(rows) {
  const currencies = new Set();
  const normalized = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row?.rrDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const currency = String(row?.currency || '').trim().toUpperCase();
    if (!currency) {
      const error = new Error('WB Finance API вернул строку без валюты.');
      error.status = 502;
      error.code = 'WB_FINANCE_CURRENCY_MISSING';
      throw error;
    }
    currencies.add(currency);

    const payable = moneyNumber(row.forPay);
    const retailAmount = moneyNumber(row.retailAmount);
    const commission = moneyNumber(row.ppvzSalesCommission) + moneyNumber(row.acquiringFee);
    const logistics = moneyNumber(row.deliveryService);
    const storage = moneyNumber(row.paidStorage);
    const penalty = moneyNumber(row.penalty);
    const deduction = moneyNumber(row.deduction);
    const acceptance = moneyNumber(row.paidAcceptance);
    const additionalPayment = moneyNumber(row.additionalPayment);
    const expenses = logistics + storage + penalty + deduction + acceptance;

    normalized.push({
      date,
      currency,
      vendorCode: String(row.vendorCode || '').trim(),
      quantity: Math.abs(moneyNumber(row.quantity)),
      operation: String(row.sellerOperName || '').trim(),
      documentType: String(row.docTypeName || '').trim(),
      retailAmount,
      payable,
      commission,
      logistics,
      storage,
      penalty,
      deduction,
      acceptance,
      additionalPayment,
      margin: payable + additionalPayment - expenses
    });
  }

  if (currencies.size > 1) {
    const error = new Error('WB Finance API вернул смешанные валюты за один период.');
    error.status = 502;
    error.code = 'WB_FINANCE_MIXED_CURRENCIES';
    throw error;
  }

  return {
    rows: normalized,
    currency: currencies.values().next().value || null
  };
}

function realizedOperationDirection(operation) {
  const normalized = String(operation || '').trim().toLocaleLowerCase('ru');
  if (normalized === 'продажа') return 1;
  if (normalized === 'возврат') return -1;
  return 0;
}

function normalizeVendorCode(value) {
  return String(value || '').trim().toLocaleLowerCase('ru');
}

function calculateRealizedCogs(rows, costsByVendorCode) {
  const normalizedCosts = new Map(
    Object.entries(costsByVendorCode || {}).map(([vendorCode, cost]) => [normalizeVendorCode(vendorCode), moneyNumber(cost)])
  );
  const result = {
    cogs: 0,
    soldUnits: 0,
    returnedUnits: 0,
    netUnits: 0,
    unpricedUnits: 0,
    unpricedArticles: [],
    complete: true
  };
  const unpricedArticles = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const direction = realizedOperationDirection(row?.operation);
    const quantity = Math.abs(moneyNumber(row?.quantity));
    if (!direction || !quantity) continue;

    if (direction > 0) result.soldUnits += quantity;
    else result.returnedUnits += quantity;
    result.netUnits += direction * quantity;

    const vendorCode = normalizeVendorCode(row?.vendorCode);
    const unitCost = normalizedCosts.get(vendorCode) || 0;
    if (unitCost > 0) result.cogs += direction * quantity * unitCost;
    else {
      result.unpricedUnits += quantity;
      unpricedArticles.add(String(row?.vendorCode || '').trim() || 'без артикула');
    }
  }

  result.unpricedArticles = [...unpricedArticles].sort((left, right) => left.localeCompare(right, 'ru'));
  result.complete = result.unpricedUnits === 0;
  return result;
}

function convertMoneyToKzt(value, currency, rubKztRate) {
  const amount = moneyNumber(value);
  const normalizedCurrency = String(currency || '').trim().toUpperCase();
  if (normalizedCurrency === 'KZT') return Math.round(amount);
  if (normalizedCurrency === 'RUB') return Math.round(amount * moneyNumber(rubKztRate));
  const error = new Error(`Неподдерживаемая валюта WB: ${normalizedCurrency || 'не указана'}`);
  error.status = 502;
  error.code = 'WB_CURRENCY_UNSUPPORTED';
  throw error;
}

function createFinanceService({ fetchImpl = fetch } = {}) {
  async function getDetailedReport({ token, dateFrom, dateTo }) {
    const response = await fetchImpl(FINANCE_DETAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        dateFrom,
        dateTo,
        limit: FINANCE_PAGE_LIMIT,
        rrdId: 0,
        period: 'daily',
        fields: FINANCE_FIELDS
      }),
      signal: AbortSignal.timeout(30_000)
    });

    if (response.status === 204) return { rows: [], currency: null };
    if (!response.ok) throw financeApiError(response.status);

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      const error = new Error('Некорректный ответ WB Finance API.');
      error.status = 502;
      error.code = 'WB_FINANCE_INVALID_RESPONSE';
      throw error;
    }
    if (payload.length >= FINANCE_PAGE_LIMIT) {
      const error = new Error('Финансовый отчёт WB превышает лимит одной выгрузки. Выберите меньший период.');
      error.status = 400;
      error.code = 'WB_FINANCE_PERIOD_TOO_LARGE';
      throw error;
    }

    return normalizeFinanceRows(payload);
  }

  return { getDetailedReport };
}

module.exports = {
  createFinanceService,
  normalizeFinanceRows,
  calculateRealizedCogs,
  realizedOperationDirection,
  normalizeVendorCode,
  convertMoneyToKzt,
  financeApiError,
  FINANCE_DETAILS_URL,
  FINANCE_PAGE_LIMIT,
  FINANCE_FIELDS
};
