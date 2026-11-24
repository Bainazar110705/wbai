// Админка: карточка пользователя (подписка, фото, магазины WB) и пропуск
// «только чтение», чтобы открыть кабинет пользователя и смотреть его аналитику.
const { AppError } = require('../platform/errors');
const { importPercent } = require('../controllers/rnp.controller');

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseProgress(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Состояние загрузки данных магазина для админки.
function shopSyncState(row) {
  const status = row.sync_status || null;
  const running = status === 'running';
  const hasData = !!row.last_success_at;
  let state = 'none';
  if (running) state = 'running';
  else if (status === 'error' || (row.last_error && !hasData)) state = 'error';
  else if (hasData) state = 'ok';
  return {
    state,
    percent: running ? importPercent(parseProgress(row.sync_progress)) : (hasData ? 100 : 0),
    lastSuccessAt: iso(row.last_success_at),
    finishedAt: iso(row.finished_at),
    lastViewedAt: iso(row.last_viewed_at),
    error: state === 'error' ? String(row.last_error || 'Ошибка загрузки') : null
  };
}

function adminShop(row) {
  return {
    id: row.id,
    name: row.name,
    sellerId: row.seller_id || null,
    tokenPreview: row.token_tail ? `****${row.token_tail}` : null,
    taxRate: Number(row.tax_rate) || 0,
    createdAt: iso(row.created_at),
    productsCount: Number(row.products_count) || 0,
    orders30d: Number(row.orders_30d) || 0,
    sync: shopSyncState(row)
  };
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function createAdminUsersService({ repository, creditsSummary, createViewToken }) {
  async function findUser(userId) {
    const id = positiveId(userId);
    const user = id ? await repository.findUser(id) : null;
    if (!user) throw new AppError(404, 'Пользователь не найден', 'USER_NOT_FOUND');
    return user;
  }

  return {
    listUsers: () => repository.listUsers(),

    async details(userId) {
      const user = await findUser(userId);
      const [shops, history, credits] = await Promise.all([
        repository.listShops(user.id),
        repository.creditHistory(user.id),
        creditsSummary(user.id)
      ]);
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name || '',
          plan: user.plan || 'start',
          subscriptionEnd: iso(user.subscription_end),
          legacyTermsUntil: iso(user.legacy_terms_until),
          createdAt: iso(user.created_at)
        },
        credits,
        shops: shops.map(adminShop),
        history: history.map(row => ({ id: row.id, amount: Number(row.amount) || 0, note: row.note || '', createdAt: iso(row.created_at) }))
      };
    },

    // Пропуск на час: кабинет пользователя открывается только для чтения.
    async viewSession(userId, shopId) {
      const user = await findUser(userId);
      let shop = null;
      if (shopId !== undefined && shopId !== null && shopId !== '') {
        const id = positiveId(shopId);
        shop = id ? await repository.findShop(user.id, id) : null;
        if (!shop) throw new AppError(404, 'Магазин не найден.', 'SHOP_NOT_FOUND');
      }
      const token = createViewToken({ user, shopId: shop?.id || null });
      return { token, userId: user.id, email: user.email, shopId: shop?.id || null };
    }
  };
}

module.exports = { createAdminUsersService, adminShop, shopSyncState };
