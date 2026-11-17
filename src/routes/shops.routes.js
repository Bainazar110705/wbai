const express = require('express');
const { asyncHandler } = require('../platform/errors');

function registerShopsRoutes(app, { controller, auth }) {
  const router = express.Router();
  router.get('/shops', auth, asyncHandler(controller.list));
  router.post('/shops', auth, asyncHandler(controller.add));
  router.put('/shops/:id/token', auth, asyncHandler(controller.replaceToken));
  router.patch('/shops/:id', auth, asyncHandler(controller.rename));
  router.delete('/shops/:id', auth, asyncHandler(controller.remove));
  app.use('/api', router);
}

module.exports = { registerShopsRoutes };
