// Магазин запроса: заголовок X-Shop-Id (или ?shop=), только свой магазин
// пользователя; без заголовка — первый магазин. req.shop = null, если магазинов нет.
function createShopMiddleware({ repository }) {
  return async function resolveShop(req, res, next) {
    try {
      const raw = req.get('x-shop-id') ?? req.query?.shop;
      let shop;
      if (raw !== undefined && raw !== null && raw !== '') {
        const id = Number(raw);
        shop = Number.isSafeInteger(id) && id > 0 ? await repository.findForUser(req.user.id, id) : null;
        if (!shop) return res.status(404).json({ error: 'Магазин не найден.', shopNotFound: true });
      } else {
        shop = await repository.firstForUser(req.user.id);
      }
      req.shop = shop ? { id: shop.id, name: shop.name, token: shop.token, sellerId: shop.seller_id, taxRate: Number(shop.tax_rate) || 0 } : null;
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createShopMiddleware };
