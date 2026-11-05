const express = require('express');
const { asyncHandler } = require('../platform/errors');

function registerRnpRoutes(app, { controller, auth }) {
  const router = express.Router();
  router.get('/rnp', auth, asyncHandler(controller.report));
  router.get('/rnp/status', auth, asyncHandler(controller.status));
  router.post('/rnp/refresh', auth, asyncHandler(controller.refresh));
  router.get('/rnp/plans', auth, asyncHandler(controller.plans));
  router.post('/rnp/plans', auth, asyncHandler(controller.savePlans));
  router.post('/rnp/labels', auth, asyncHandler(controller.saveLabels));
  app.use('/api', router);
}

module.exports = { registerRnpRoutes };
