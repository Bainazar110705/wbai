const express = require('express');
const { asyncHandler } = require('../platform/errors');
const { validate, requireString } = require('../middleware/validate');

function registerAuthRoutes(app, { controller, auth }) {
  const router = express.Router();
  router.post('/register',
    validate(req => {
      requireString(req.body?.email, 'Email и пароль обязательны');
      requireString(req.body?.password, 'Email и пароль обязательны');
    }),
    asyncHandler(controller.register)
  );
  router.post('/login', asyncHandler(controller.login));
  router.get('/me', auth, asyncHandler(controller.me));
  router.post('/change-password', auth,
    validate(req => {
      requireString(req.body?.currentPassword, 'Заполните все поля');
      requireString(req.body?.newPassword, 'Заполните все поля');
      requireString(req.body.newPassword, 'Пароль минимум 6 символов', { min: 6 });
    }),
    asyncHandler(controller.changePassword)
  );
  app.use('/api', router);
}

module.exports = { registerAuthRoutes };
