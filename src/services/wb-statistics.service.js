// Отчёты «Заказы» и «Продажи» Statistics API WB. Методы отдают строки,
// изменённые после dateFrom (flag=0), поэтому повторная загрузка с курсора
// приносит только новые и обновлённые строки.
const STATISTICS_API_URL = 'https://statistics-api.wildberries.ru';
// Лимит WB — 1 запрос в минуту на метод.
const STATISTICS_INTERVAL_MS = 61_000;
// WB отдаёт до ~80 000 строк за запрос; полная страница значит, что есть продолжение.
const STATISTICS_PAGE_THRESHOLD = 50_000;
const MAX_PAGES = 30;
const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;
// Суммы отчётов «Заказы» и «Продажи» WB отдаёт в рублях, даже для кабинета в тенге.
const STATISTICS_CURRENCY = 'RUB';

function statisticsApiError(status) {
  const messages = {
    401: 'Токен WB недействителен.',
    403: 'В токене WB нет доступа «Статистика». Добавьте его в настройках WB.',
    429: 'WB временно ограничил запросы статистики. Данные догрузятся позже.'
  };
  const error = new Error(messages[status] || `Statistics API WB вернул ошибку ${status}.`);
  error.status = status === 401 ? 400 : (status === 403 || status === 429 ? status : 502);
  error.code = `WB_STATISTICS_${status}`;
  return error;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value, maxLength = 255) {
  return String(value ?? '').trim().slice(0, maxLength);
}

// WB присылает время МСК без часового пояса: «2026-10-29T11:52:37».
function wbDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(String(value || ''));
  return match ? `${match[1]}T${match[2] || '00:00:00'}` : null;
}

function normalizeOrder(row) {
  const orderDate = wbDateTime(row?.date);
  const nmId = number(row?.nmId);
  const srid = text(row?.srid, 120);
  if (!orderDate || !nmId || !srid) return null;
  return {
    srid,
    orderDate,
    lastChangeDate: wbDateTime(row.lastChangeDate) || orderDate,
    nmId,
    supplierArticle: text(row.supplierArticle),
    brand: text(row.brand),
    subject: text(row.subject),
    priceWithDisc: Math.abs(number(row.priceWithDisc)),
    finishedPrice: Math.abs(number(row.finishedPrice)),
    isCancel: !!row.isCancel,
    region: text(row.regionName || row.oblastOkrugName),
    warehouse: text(row.warehouseName)
  };
}

// Возвраты WB присылает строками с saleID на «R» и отрицательными суммами;
// храним суммы без знака и отдельный признак возврата.
function normalizeSale(row) {
  const saleDate = wbDateTime(row?.date);
  const nmId = number(row?.nmId);
  const saleId = text(row?.saleID, 120);
  if (!saleDate || !nmId || !saleId) return null;
  return {
    saleId,
    srid: text(row.srid, 120),
    saleDate,
    lastChangeDate: wbDateTime(row.lastChangeDate) || saleDate,
    nmId,
    supplierArticle: text(row.supplierArticle),
    brand: text(row.brand),
    subject: text(row.subject),
    isReturn: saleId.startsWith('R'),
    priceWithDisc: Math.abs(number(row.priceWithDisc)),
    forPay: Math.abs(number(row.forPay)),
    finishedPrice: Math.abs(number(row.finishedPrice))
  };
}

function maxCursor(rows, current) {
  return rows.reduce((max, row) => (row.lastChangeDate > max ? row.lastChangeDate : max), current || '');
}

function createStatisticsService({
  fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  async function request(method, dateFrom, token) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(
        `${STATISTICS_API_URL}/api/v1/supplier/${method}?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`,
        { headers: { Authorization: token, Accept: 'application/json' }, signal: AbortSignal.timeout(120_000) }
      );
      if (response.status === 429 && attempt < 3) {
        const retryMs = (number(response.headers?.get?.('x-ratelimit-retry')) || 60) * 1000 + 1000;
        if (retryMs <= MAX_RATE_LIMIT_WAIT_MS) {
          await wait(retryMs);
          continue;
        }
      }
      if (!response.ok) throw statisticsApiError(response.status);
      const payload = await response.json();
      return Array.isArray(payload) ? payload : [];
    }
  }

  // onPage сохраняет каждую страницу сразу: прерванная загрузка продолжится с курсора.
  async function loadSince({ method, token, cursor, onPage }) {
    const normalize = method === 'orders' ? normalizeOrder : normalizeSale;
    let dateFrom = cursor;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) await wait(STATISTICS_INTERVAL_MS);
      const raw = await request(method, dateFrom, token);
      const rows = raw.map(normalize).filter(Boolean);
      const nextCursor = maxCursor(rows, dateFrom);
      await onPage(rows, nextCursor);
      if (raw.length < STATISTICS_PAGE_THRESHOLD || nextCursor === dateFrom) return nextCursor;
      dateFrom = nextCursor;
    }
    return dateFrom;
  }

  return { loadSince };
}

module.exports = {
  createStatisticsService,
  normalizeOrder,
  normalizeSale,
  wbDateTime,
  statisticsApiError,
  STATISTICS_CURRENCY,
  STATISTICS_INTERVAL_MS
};
