const { AppError } = require('../platform/errors');

function requireShop(req) {
  if (!req.shop) throw Object.assign(new AppError(400, 'Подключите магазин WB, чтобы управлять остатками.', 'NO_SHOP'), { noToken: true });
  return req.shop;
}

function createStocksController(stocksService) {
  return {
    async warehouses(req, res) {
      res.json(await stocksService.warehouses(requireShop(req), { fresh: req.query.fresh === '1' }));
    },
    async list(req, res) {
      res.json(await stocksService.list(requireShop(req), req.query.warehouseId, { fresh: req.query.fresh === '1' }));
    },
    async save(req, res) {
      res.json({ ok: true, ...(await stocksService.save(requireShop(req), req.user.id, req.body)) });
    },
    async history(req, res) {
      res.json(await stocksService.history(requireShop(req)));
    },
    async historyItems(req, res) {
      res.json(await stocksService.historyItems(requireShop(req), req.params.id));
    },
    async undo(req, res) {
      res.json({ ok: true, ...(await stocksService.undo(requireShop(req), req.user.id, req.params.id)) });
    }
  };
}

module.exports = { createStocksController };
