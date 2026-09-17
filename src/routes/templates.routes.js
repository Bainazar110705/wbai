const express = require('express');
const { asyncHandler } = require('../platform/errors');
const { validate, requireString } = require('../middleware/validate');

function registerTemplatesRoutes(app, { controller, auth, subscription }) {
  const router = express.Router();
  router.get('/templates', auth, asyncHandler(controller.list));
  router.post('/templates', auth, subscription,
    validate(req => requireString(req.body?.name, 'Название обязательно')),
    asyncHandler(controller.save)
  );
  router.delete('/templates/:name', auth, subscription, asyncHandler(controller.remove));
  app.use('/api', router);
}

module.exports = { registerTemplatesRoutes };
