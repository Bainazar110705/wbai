const express = require('express');
const { asyncHandler } = require('../platform/errors');

// «Остатки» — на всех тарифах при активной подписке.
function registerStocksRoutes(app, { controller, auth, access, shop }) {
  const router = express.Router();
  router.get('/stocks/warehouses', auth, access, shop, asyncHandler(controller.warehouses));
  router.get('/stocks', auth, access, shop, asyncHandler(controller.list));
  router.put('/stocks', auth, access, shop, asyncHandler(controller.save));
  router.get('/stocks/history', auth, access, shop, asyncHandler(controller.history));
  router.get('/stocks/history/:id', auth, access, shop, asyncHandler(controller.historyItems));
  router.post('/stocks/history/:id/undo', auth, access, shop, asyncHandler(controller.undo));
  app.use('/api', router);
}

module.exports = { registerStocksRoutes };
