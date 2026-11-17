// Магазины WB аккаунта: добавление, замена токена, переименование, удаление.
// Данные магазина изолированы по shop_id; если новый токен от другого кабинета,
// всё старое удаляется, если от того же — сохраняется.
const crypto = require('node:crypto');
const { AppError } = require('../platform/errors');

const PLAN_SHOP_LIMITS = { start: 3, pro: 6, max: 12 };
const PLAN_NAMES = { start: 'Старт', pro: 'Про', max: 'Макс' };
const MAX_NAME_LENGTH = 100;

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

function cleanToken(raw) {
  return String(raw || '').trim().replace(/^Bearer\s+/i, '');
}

function shopLimit(plan) {
  return PLAN_SHOP_LIMITS[plan] || PLAN_SHOP_LIMITS.start;
}

function publicShop(shop) {
  return {
    id: shop.id,
    name: shop.name,
    sellerId: shop.seller_id || null,
    tokenPreview: shop.token ? `****${shop.token.slice(-6)}` : null,
    createdAt: shop.created_at
  };
}

function createShopsService({ repository, usersRepository, validateToken, getSellerInfo, getCatalogNmIds, syncService, logger }) {
  async function limitFor(userId) {
    const user = await usersRepository.findById(userId);
    const plan = user?.plan || 'start';
    return { plan, planName: PLAN_NAMES[plan] || plan, limit: shopLimit(plan) };
  }

  async function ownShop(userId, shopId) {
    const id = Number(shopId);
    const shop = Number.isSafeInteger(id) && id > 0 ? await repository.findForUser(userId, id) : null;
    if (!shop) throw new AppError(404, 'Магазин не найден.', 'SHOP_NOT_FOUND');
    return shop;
  }

  // Тот же кабинет WB? Сначала по номеру продавца, иначе по общим товарам.
  async function isSameCabinet(shop, info, token) {
    if (shop.seller_id && info?.sid) return shop.seller_id === info.sid;
    const stored = await repository.storedNmIds(shop.id);
    if (!stored.length) return true;
    let fresh;
    try {
      fresh = await getCatalogNmIds(token);
    } catch (error) {
      throw new AppError(503, 'WB не ответил, не удалось проверить, тот ли это кабинет. Попробуйте через минуту.', 'SHOP_CHECK_UNAVAILABLE');
    }
    const storedSet = new Set(stored);
    return fresh.some(nmId => storedSet.has(nmId));
  }

  // Магазин из прошлой версии (один токен на аккаунт) без номера продавца:
  // дописываем название и номер при первой возможности.
  async function fillSellerInfo(shop) {
    if (shop.seller_id) return;
    const info = await getSellerInfo(shop.token);
    if (!info) return;
    await repository.update(shop.id, {
      seller_id: info.sid || undefined,
      name: shop.name === 'Мой магазин' && info.name ? info.name : undefined
    });
  }

  function startImport(shopId) {
    Promise.resolve(syncService.restart(shopId))
      .catch(error => logger.warn('shop_import_start_failed', { shopId, error: error.message }));
  }

  return {
    async list(userId) {
      const [shops, limits] = await Promise.all([repository.listByUser(userId), limitFor(userId)]);
      shops.filter(shop => !shop.seller_id).forEach(shop => fillSellerInfo(shop)
        .catch(error => logger.warn('shop_seller_info_failed', { shopId: shop.id, error: error.message })));
      return { shops: shops.map(publicShop), count: shops.length, ...limits };
    },

    async add(userId, rawToken) {
      const token = cleanToken(rawToken);
      if (!token) throw new AppError(400, 'Введите токен.', 'VALIDATION_ERROR');
      const [{ limit, planName }, count] = await Promise.all([limitFor(userId), repository.countForUser(userId)]);
      if (count >= limit) {
        throw Object.assign(new AppError(403, `На тарифе «${planName}» можно подключить до ${limit} магазинов. Удалите ненужный или перейдите на тариф выше.`, 'SHOP_LIMIT'), { limit });
      }
      await validateToken(token);
      const info = await getSellerInfo(token);
      if (info?.sid) {
        const existing = await repository.findBySeller(userId, info.sid);
        if (existing) throw new AppError(409, `Этот кабинет WB уже подключён как «${existing.name}».`, 'SHOP_EXISTS');
      }
      const shop = await repository.create({
        userId,
        name: info?.name || `Магазин ${count + 1}`,
        sellerId: info?.sid || null,
        token,
        fingerprint: tokenFingerprint(token)
      });
      startImport(shop.id);
      return publicShop(shop);
    },

    async replaceToken(userId, shopId, rawToken) {
      const shop = await ownShop(userId, shopId);
      const token = cleanToken(rawToken);
      if (!token) throw new AppError(400, 'Введите токен.', 'VALIDATION_ERROR');
      await validateToken(token);
      const info = await getSellerInfo(token);
      if (info?.sid) {
        const other = await repository.findBySeller(userId, info.sid);
        if (other && other.id !== shop.id) throw new AppError(409, `Этот кабинет WB уже подключён как «${other.name}».`, 'SHOP_EXISTS');
      }
      const sameCabinet = await isSameCabinet(shop, info, token);
      // Загрузку со старым токеном прерываем до любых изменений.
      await syncService.stop(shop.id);
      if (!sameCabinet) await repository.purgeData(shop.id);
      await repository.update(shop.id, {
        token,
        token_fingerprint: tokenFingerprint(token),
        seller_id: info?.sid || (sameCabinet ? shop.seller_id : null),
        name: !sameCabinet && info?.name ? info.name : undefined
      });
      logger.info('shop_token_replaced', { userId, shopId: shop.id, sameCabinet });
      startImport(shop.id);
      return { ...publicShop({ ...shop, token, name: !sameCabinet && info?.name ? info.name : shop.name }), sameCabinet };
    },

    async rename(userId, shopId, rawName) {
      const shop = await ownShop(userId, shopId);
      const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
      if (!name) throw new AppError(400, 'Введите название магазина.', 'VALIDATION_ERROR');
      await repository.update(shop.id, { name });
      return publicShop({ ...shop, name });
    },

    async remove(userId, shopId) {
      const shop = await ownShop(userId, shopId);
      await syncService.stop(shop.id);
      await repository.remove(shop.id);
      logger.info('shop_removed', { userId, shopId: shop.id });
    },

    fillSellerInfo
  };
}

module.exports = { createShopsService, tokenFingerprint, cleanToken, shopLimit, PLAN_SHOP_LIMITS };
