const express = require('express');
const { asyncHandler } = require('../platform/errors');

function registerRnpRoutes(app, { controller, auth, shop, access }) {
  const router = express.Router();
  router.get('/rnp', auth, access, shop, asyncHandler(controller.report));
  router.get('/rnp/status', auth, access, shop, asyncHandler(controller.status));
  router.post('/rnp/refresh', auth, access, shop, asyncHandler(controller.refresh));
  router.get('/rnp/plans', auth, access, shop, asyncHandler(controller.plans));
  router.post('/rnp/plans', auth, access, shop, asyncHandler(controller.savePlans));
  router.post('/rnp/labels', auth, access, shop, asyncHandler(controller.saveLabels));
  app.use('/api', router);
}

module.exports = { registerRnpRoutes };
