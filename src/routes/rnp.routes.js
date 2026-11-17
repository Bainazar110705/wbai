const express = require('express');
const { asyncHandler } = require('../platform/errors');

function registerRnpRoutes(app, { controller, auth, shop }) {
  const router = express.Router();
  router.get('/rnp', auth, shop, asyncHandler(controller.report));
  router.get('/rnp/status', auth, shop, asyncHandler(controller.status));
  router.post('/rnp/refresh', auth, shop, asyncHandler(controller.refresh));
  router.get('/rnp/plans', auth, shop, asyncHandler(controller.plans));
  router.post('/rnp/plans', auth, shop, asyncHandler(controller.savePlans));
  router.post('/rnp/labels', auth, shop, asyncHandler(controller.saveLabels));
  app.use('/api', router);
}

module.exports = { registerRnpRoutes };
