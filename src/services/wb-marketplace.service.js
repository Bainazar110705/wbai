// Склады продавца и остатки на них (FBS/DBS): API WB «Маркетплейс».
// Остатки на складах WB (FBO) так не меняются — только поставками.
// Проверено на живом API: чтение и запись принимают и chrtId, и баркод (sku);
// ответ на запись — 204, отклонённые позиции — 409
// [{ data: [{ sku, chrtId, amount }], code, message }], неверное тело — 400.
const { AppError } = require('../platform/errors');

const MARKETPLACE_URL = 'https://marketplace-api.wildberries.ru/api/v3';
const STOCKS_CHUNK = 1000;
const MAX_AMOUNT = 100000;
const RATE_LIMIT_ATTEMPTS = 4;

// Понятные причины частых отказов WB.
const STOCK_ERROR_MESSAGES = {
  NotFound: 'Товар или размер не найден в карточках WB',
  CargoWarehouseRestriction: 'Склад не принимает товар этого габарита',
  CargoWarehouseRestrictionMGT: 'Склад не принимает малогабаритный товар',
  CargoWarehouseRestrictionSGT: 'Склад не принимает сверхгабаритный товар',
  CargoWarehouseRestrictionKGT: 'Склад не принимает крупногабаритный товар',
  CargoWarehouseRestrictionSGTKGT: 'Склад не принимает крупно- и сверхгабаритный товар',
  SubjectDBSRestriction: 'Этот предмет нельзя продавать со склада DBS',
  UploadDataLimit: 'Слишком много позиций за раз',
  NotFoundSku: 'Баркод не найден',
  NeedSgtin: 'Нужна маркировка «Честный знак»'
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chunks(list, size) {
  const result = [];
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
  return result;
}

function itemKey(item) {
  return number(item.chrtId) > 0 ? `c${number(item.chrtId)}` : `s${String(item.sku || '')}`;
}

function wbError(status, fallback) {
  if (status === 401) return new AppError(400, 'Токен магазина недействителен. Выпустите новый в WB Partners.', 'WB_TOKEN_INVALID');
  if (status === 403) {
    return new AppError(403, 'У токена магазина нет доступа к категории «Маркетплейс» или он только для чтения. Выпустите токен с категорией «Маркетплейс» без галочки «Только на чтение».', 'WB_MARKETPLACE_FORBIDDEN');
  }
  if (status === 429) return new AppError(429, 'WB временно ограничил запросы. Попробуйте через минуту.', 'WB_RATE_LIMIT');
  return new AppError(502, fallback || `WB ответил ошибкой ${status}. Попробуйте позже.`, 'WB_ERROR');
}

// Позиции, которые WB отклонил, с причиной.
function parseStockConflicts(payload) {
  const groups = Array.isArray(payload) ? payload : (payload && typeof payload === 'object' ? [payload] : []);
  const failed = [];
  for (const group of groups) {
    const code = String(group?.code || 'Error');
    const message = STOCK_ERROR_MESSAGES[code] || String(group?.message || 'WB отклонил позицию');
    const data = Array.isArray(group?.data) ? group.data : [];
    for (const item of data) {
      failed.push({ chrtId: number(item?.chrtId) || null, sku: String(item?.sku || ''), code, message });
    }
  }
  return failed;
}

// Причина отказа без списка позиций: { code, message } или [{ code, message }].
function conflictReason(payload) {
  const group = Array.isArray(payload) ? payload[0] : payload;
  const code = String(group?.code || 'Error');
  return { code, message: STOCK_ERROR_MESSAGES[code] || String(group?.message || 'WB отклонил остатки') };
}

function createMarketplaceService({ fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), baseUrl = MARKETPLACE_URL } = {}) {
  async function request(token, method, path, body) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000)
        });
      } catch (error) {
        throw new AppError(502, 'WB не ответил. Попробуйте через минуту.', 'WB_UNAVAILABLE');
      }
      if (response.status === 429 && attempt < RATE_LIMIT_ATTEMPTS) {
        const retrySeconds = number(response.headers?.get?.('x-ratelimit-retry')) || number(response.headers?.get?.('retry-after')) || 2 * attempt;
        await wait(Math.min(retrySeconds, 20) * 1000 + 250);
        continue;
      }
      const text = response.status === 204 ? '' : await response.text().catch(() => '');
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = null; } }
      return { status: response.status, data };
    }
  }

  async function listWarehouses(token) {
    const { status, data } = await request(token, 'GET', '/warehouses');
    if (status !== 200) throw wbError(status, 'Не удалось загрузить склады из WB.');
    return (Array.isArray(data) ? data : [])
      .filter(item => !item?.isDeleting)
      .map(item => ({
        id: number(item.id),
        name: String(item.name || `Склад ${item.id}`),
        officeId: number(item.officeId) || null,
        cargoType: number(item.cargoType) || null,
        deliveryType: number(item.deliveryType) || null
      }))
      .filter(item => item.id > 0);
  }

  // Остатки склада по chrtId: { chrtId → { sku, amount } }. Нет в ответе — 0.
  async function getStocks(token, warehouseId, chrtIds) {
    const ids = [...new Set(chrtIds.map(number).filter(id => id > 0))];
    const result = new Map();
    for (const part of chunks(ids, STOCKS_CHUNK)) {
      const { status, data } = await request(token, 'POST', `/stocks/${warehouseId}`, { chrtIds: part });
      if (status === 404) throw new AppError(404, 'Склад не найден в WB.', 'WAREHOUSE_NOT_FOUND');
      if (status !== 200) throw wbError(status, 'Не удалось загрузить остатки из WB.');
      for (const stock of data?.stocks || []) {
        const chrtId = number(stock.chrtId);
        if (chrtId) result.set(chrtId, { sku: String(stock.sku || ''), amount: number(stock.amount) });
      }
    }
    return result;
  }

  // Запись остатков. Отклонённые WB позиции отделяем и отправляем остальные ещё раз,
  // чтобы одна ошибочная позиция не мешала сохранить пачку.
  async function setStocks(token, warehouseId, items) {
    const saved = [];
    const failed = [];
    for (const part of chunks(items, STOCKS_CHUNK)) {
      let pending = part;
      for (let round = 0; pending.length && round < 3; round++) {
        const body = { stocks: pending.map(item => (number(item.chrtId) > 0 ? { chrtId: number(item.chrtId), amount: item.amount } : { sku: String(item.sku), amount: item.amount })) };
        const { status, data } = await request(token, 'PUT', `/stocks/${warehouseId}`, body);
        if (status === 204 || status === 200) { saved.push(...pending); pending = []; break; }
        if (status === 404) throw new AppError(404, 'Склад не найден в WB.', 'WAREHOUSE_NOT_FOUND');
        if (status !== 409) {
          if (status === 400) throw new AppError(400, 'WB не принял данные остатков. Проверьте значения.', 'WB_BAD_STOCKS');
          throw wbError(status, 'Не удалось сохранить остатки в WB.');
        }
        const conflicts = parseStockConflicts(data);
        const rejected = new Set();
        for (const conflict of conflicts) {
          const match = pending.find(item => (conflict.chrtId && number(item.chrtId) === conflict.chrtId) || (conflict.sku && String(item.sku || '') === conflict.sku));
          if (match && !rejected.has(itemKey(match))) {
            rejected.add(itemKey(match));
            failed.push({ ...match, code: conflict.code, message: conflict.message });
          }
        }
        // WB не сказал, какие позиции плохие, — считаем отклонённой всю пачку.
        if (!rejected.size) {
          const reason = conflicts[0] || conflictReason(data);
          failed.push(...pending.map(item => ({ ...item, code: reason.code, message: reason.message })));
          pending = [];
          break;
        }
        pending = pending.filter(item => !rejected.has(itemKey(item)));
      }
      if (pending.length) failed.push(...pending.map(item => ({ ...item, code: 'Error', message: 'WB отклонил остатки' })));
    }
    return { saved, failed };
  }

  return { listWarehouses, getStocks, setStocks };
}

module.exports = { createMarketplaceService, parseStockConflicts, STOCKS_CHUNK, MAX_AMOUNT, MARKETPLACE_URL };
