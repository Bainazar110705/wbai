const express = require('express');
const { asyncHandler } = require('../platform/errors');

function registerAnalyticsProductsRoutes(app, { controller, auth, shop, access }) {
  const router = express.Router();
  router.get('/wb-analytics/products', auth, access, shop, asyncHandler(controller.list));
  app.use('/api', router);
}

module.exports = { registerAnalyticsProductsRoutes };
