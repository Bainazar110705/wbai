// Остатки на складах продавца: таблица товаров по размерам, массовое сохранение
// в WB, история «было → стало» и отмена последнего сохранения.
const { AppError } = require('../platform/errors');
const { MAX_AMOUNT } = require('./wb-marketplace.service');

const MAX_SAVE_ITEMS = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const SOURCES = new Set(['manual', 'import', 'copy', 'bulk']);

function positiveInt(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Проверка позиций для сохранения: целые остатки 0…100 000, без повторов.
function parseSaveItems(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new AppError(400, 'Нет изменений для сохранения.', 'VALIDATION_ERROR');
  if (raw.length > MAX_SAVE_ITEMS) throw new AppError(400, `За один раз можно сохранить до ${MAX_SAVE_ITEMS} позиций.`, 'VALIDATION_ERROR');
  const byChrt = new Map();
  for (const item of raw) {
    const chrtId = positiveInt(item?.chrtId);
    const amount = Number(item?.amount);
    if (!chrtId) throw new AppError(400, 'Неверный размер товара в данных.', 'VALIDATION_ERROR');
    if (!Number.isInteger(amount) || amount < 0 || amount > MAX_AMOUNT) {
      throw new AppError(400, `Остаток должен быть целым числом от 0 до ${MAX_AMOUNT.toLocaleString('ru-RU')}.`, 'VALIDATION_ERROR');
    }
    byChrt.set(chrtId, { chrtId, amount });
  }
  return [...byChrt.values()];
}

function createStocksService({ repository, marketplace, content, now = () => Date.now() }) {
  const cache = new Map();

  // Кэш на 10 минут по магазину; одновременные запросы ждут одну загрузку.
  async function cached(key, load, fresh) {
    const hit = cache.get(key);
    if (!fresh && hit && (hit.promise || now() - hit.at < CACHE_TTL_MS)) return hit.promise || hit.value;
    const promise = load();
    cache.set(key, { promise });
    try {
      const value = await promise;
      cache.set(key, { value, at: now() });
      return value;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }

  const warehousesOf = (shop, fresh) => cached(`wh:${shop.id}:${shop.token.slice(-12)}`, () => marketplace.listWarehouses(shop.token), fresh);
  const sizesOf = (shop, fresh) => cached(`sz:${shop.id}:${shop.token.slice(-12)}`, () => content.listSizes(shop.token), fresh);

  async function findWarehouse(shop, warehouseId) {
    const id = positiveInt(warehouseId);
    const list = id ? await warehousesOf(shop) : [];
    const warehouse = list.find(item => item.id === id);
    if (!warehouse) throw new AppError(404, 'Склад не найден. Обновите страницу.', 'WAREHOUSE_NOT_FOUND');
    return warehouse;
  }

  function sizeIndex(sizes) {
    return new Map(sizes.map(size => [size.chrtId, size]));
  }

  async function write({ shop, userId, warehouse, items, source, undoOf = null }) {
    const sizes = sizeIndex(await sizesOf(shop));
    const unknown = items.filter(item => !sizes.has(item.chrtId));
    const known = items.filter(item => sizes.has(item.chrtId));
    const before = known.length ? await marketplace.getStocks(shop.token, warehouse.id, known.map(item => item.chrtId)) : new Map();
    const changed = known.filter(item => (before.get(item.chrtId)?.amount || 0) !== item.amount);
    const payload = changed.map(item => ({ chrtId: item.chrtId, sku: sizes.get(item.chrtId).skus[0] || '', amount: item.amount }));
    const { saved, failed } = payload.length ? await marketplace.setStocks(shop.token, warehouse.id, payload) : { saved: [], failed: [] };

    const describe = item => {
      const size = sizes.get(item.chrtId) || {};
      return { chrtId: item.chrtId, sku: item.sku || size.skus?.[0] || '', nmId: size.nmId || null, vendorCode: size.vendorCode || '', size: size.size || '' };
    };
    const failures = [
      ...unknown.map(item => ({ ...describe(item), code: 'NotInCards', message: 'Размера нет в карточках магазина' })),
      ...failed.map(item => ({ ...describe(item), code: item.code, message: item.message }))
    ];
    let batch = null;
    if (saved.length || undoOf) {
      batch = await repository.createBatch({
        shopId: shop.id,
        userId,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        source,
        savedCount: saved.length,
        failedCount: failures.length,
        undoOf,
        items: saved.map(item => ({ ...describe(item), before: before.get(item.chrtId)?.amount || 0, after: item.amount }))
      });
    }
    return {
      batchId: batch?.id || null,
      saved: saved.length,
      unchanged: known.length - changed.length,
      failed: failures,
      stocks: saved.map(item => ({ chrtId: item.chrtId, amount: item.amount }))
    };
  }

  return {
    async warehouses(shop, { fresh = false } = {}) {
      return { warehouses: await warehousesOf(shop, fresh) };
    },

    // Все размеры товаров магазина с остатком на выбранном складе.
    async list(shop, warehouseId, { fresh = false } = {}) {
      const warehouse = await findWarehouse(shop, warehouseId);
      const [sizes, wbStocks] = await Promise.all([sizesOf(shop, fresh), repository.wbStocks(shop.id)]);
      const stocks = await marketplace.getStocks(shop.token, warehouse.id, sizes.map(size => size.chrtId));
      const items = sizes.map(size => ({
        nmId: size.nmId,
        vendorCode: size.vendorCode,
        title: size.title,
        brand: size.brand,
        subject: size.subject,
        photo: size.photo,
        size: size.size,
        chrtId: size.chrtId,
        sku: size.skus[0] || '',
        skus: size.skus,
        amount: stocks.get(size.chrtId)?.amount || 0,
        wbStock: wbStocks.has(size.nmId) ? wbStocks.get(size.nmId) : null
      })).sort((a, b) => a.vendorCode.localeCompare(b.vendorCode, 'ru') || a.size.localeCompare(b.size, 'ru', { numeric: true }));
      return { warehouse, items, loadedAt: new Date(now()).toISOString() };
    },

    async save(shop, userId, body) {
      const warehouse = await findWarehouse(shop, body?.warehouseId);
      const items = parseSaveItems(body?.items);
      const source = SOURCES.has(body?.source) ? body.source : 'manual';
      return write({ shop, userId, warehouse, items, source });
    },

    async history(shop) {
      const batches = await repository.listBatches(shop.id);
      return {
        batches: batches.map(batch => ({
          id: batch.id,
          warehouseId: Number(batch.warehouse_id),
          warehouseName: batch.warehouse_name,
          source: batch.source,
          saved: Number(batch.saved_count) || 0,
          failed: Number(batch.failed_count) || 0,
          undoOf: batch.undo_of || null,
          undoneAt: batch.undone_at ? new Date(batch.undone_at).toISOString() : null,
          createdAt: new Date(batch.created_at).toISOString()
        }))
      };
    },

    async historyItems(shop, batchId) {
      const id = positiveInt(batchId);
      const batch = id ? await repository.findBatch(shop.id, id) : null;
      if (!batch) throw new AppError(404, 'Запись истории не найдена.', 'STOCK_BATCH_NOT_FOUND');
      const items = await repository.batchItems(batch.id);
      return {
        items: items.map(item => ({
          chrtId: Number(item.chrt_id), sku: item.sku, nmId: Number(item.nm_id) || null, vendorCode: item.vendor_code, size: item.size,
          before: Number(item.amount_before), after: Number(item.amount_after)
        }))
      };
    },

    // Отмена последнего сохранения по складу. Позиции, которые после него
    // изменили (например, в WB Partners), не трогаем — чтобы не затереть свежие данные.
    async undo(shop, userId, batchId) {
      const id = positiveInt(batchId);
      const batch = id ? await repository.findBatch(shop.id, id) : null;
      if (!batch) throw new AppError(404, 'Запись истории не найдена.', 'STOCK_BATCH_NOT_FOUND');
      if (batch.undone_at) throw new AppError(409, 'Это сохранение уже отменено.', 'STOCK_BATCH_UNDONE');
      if (batch.undo_of) throw new AppError(409, 'Отмену отменить нельзя — измените остатки заново.', 'STOCK_BATCH_IS_UNDO');
      const latest = await repository.latestBatchId(shop.id, batch.warehouse_id);
      if (latest !== batch.id) throw new AppError(409, 'Отменить можно только последнее сохранение по этому складу.', 'STOCK_BATCH_NOT_LATEST');
      const warehouse = await findWarehouse(shop, batch.warehouse_id);
      const items = await repository.batchItems(batch.id);
      const current = await marketplace.getStocks(shop.token, warehouse.id, items.map(item => Number(item.chrt_id)));
      const restorable = items.filter(item => (current.get(Number(item.chrt_id))?.amount || 0) === Number(item.amount_after));
      const result = await write({
        shop,
        userId,
        warehouse,
        items: restorable.map(item => ({ chrtId: Number(item.chrt_id), amount: Number(item.amount_before) })),
        source: 'undo',
        undoOf: batch.id
      });
      return { ...result, skipped: items.length - restorable.length };
    },

    clearCache: shopId => {
      for (const key of cache.keys()) if (key.split(':')[1] === String(shopId)) cache.delete(key);
    }
  };
}

module.exports = { createStocksService, parseSaveItems, MAX_SAVE_ITEMS };
