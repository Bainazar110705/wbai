// Отчёт WB «Платное хранение»: сколько стоило хранение каждого товара в каждый
// день. Отчёт асинхронный: создаём задание, ждём готовности, скачиваем.
// Период одного задания — не больше 8 дней; создание и скачивание — раз в минуту.
const PAID_STORAGE_URL = 'https://seller-analytics-api.wildberries.ru/api/v1/paid_storage';
const STORAGE_CHUNK_DAYS = 8;
const STORAGE_INTERVAL_MS = 61_000;
const STATUS_POLL_MS = 5_000;
const STATUS_POLL_ATTEMPTS = 36;

function storageApiError(status, message) {
  const messages = {
    401: 'Токен WB недействителен.',
    403: 'В токене WB нет доступа «Аналитика» для отчёта о платном хранении.',
    429: 'WB временно ограничил отчёт о платном хранении. Догрузим позже.'
  };
  const error = new Error(message || messages[status] || `Отчёт WB о платном хранении вернул ошибку ${status}.`);
  error.status = status === 401 ? 400 : (status === 403 || status === 429 ? status : 502);
  error.code = `WB_STORAGE_${status}`;
  return error;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Строки отчёта (склад × размер × день) складываем в «товар × день».
function aggregateStorageRows(rows) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = String(row?.date || '').slice(0, 10);
    const nmId = number(row?.nmId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !nmId) continue;
    const key = `${day}:${nmId}`;
    const item = byKey.get(key) || { day, nmId, cost: 0 };
    item.cost += number(row.warehousePrice);
    byKey.set(key, item);
  }
  return [...byKey.values()].filter(item => item.cost > 0);
}

function splitStoragePeriod(dateFrom, dateTo) {
  const chunks = [];
  const end = Date.parse(`${dateTo}T00:00:00.000Z`);
  for (let start = Date.parse(`${dateFrom}T00:00:00.000Z`); start <= end; start += STORAGE_CHUNK_DAYS * 86_400_000) {
    chunks.push({
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(Math.min(start + (STORAGE_CHUNK_DAYS - 1) * 86_400_000, end)).toISOString().slice(0, 10)
    });
  }
  return chunks;
}

function createPaidStorageService({
  fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  async function request(path, token) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(`${PAID_STORAGE_URL}${path}`, {
        headers: { Authorization: token, Accept: 'application/json' },
        signal: AbortSignal.timeout(120_000)
      });
      if (response.status === 429 && attempt < 3) {
        await wait((number(response.headers?.get?.('x-ratelimit-retry')) || 60) * 1000 + 1000);
        continue;
      }
      if (!response.ok) throw storageApiError(response.status);
      return response.json();
    }
  }

  // Расход на хранение по товарам и дням за период до 8 дней.
  async function getChunk({ token, dateFrom, dateTo }) {
    const created = await request(`?dateFrom=${dateFrom}&dateTo=${dateTo}`, token);
    const taskId = created?.data?.taskId;
    if (!taskId) throw storageApiError(502, 'WB не создал отчёт о платном хранении.');
    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
      await wait(STATUS_POLL_MS);
      const status = String((await request(`/tasks/${encodeURIComponent(taskId)}/status`, token))?.data?.status || '');
      if (status === 'done') return aggregateStorageRows(await request(`/tasks/${encodeURIComponent(taskId)}/download`, token));
      if (status === 'canceled' || status === 'purged') throw storageApiError(502, 'WB отменил отчёт о платном хранении.');
    }
    throw storageApiError(502, 'WB долго готовит отчёт о платном хранении. Догрузим позже.');
  }

  // onChunk сохраняет каждый кусок сразу: прерванная загрузка продолжится.
  async function loadPeriod({ token, dateFrom, dateTo, onChunk }) {
    const chunks = splitStoragePeriod(dateFrom, dateTo);
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) await wait(STORAGE_INTERVAL_MS);
      const rows = await getChunk({ token, dateFrom: chunk.from, dateTo: chunk.to });
      await onChunk({ period: chunk, rows });
    }
  }

  return { getChunk, loadPeriod };
}

module.exports = {
  createPaidStorageService,
  aggregateStorageRows,
  splitStoragePeriod,
  PAID_STORAGE_URL,
  STORAGE_CHUNK_DAYS
};
