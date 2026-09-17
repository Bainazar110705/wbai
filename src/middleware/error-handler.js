const logger = require('../platform/logger');

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  logger.error('http_error', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status: err.status || 500,
    code: err.code,
    message: err.message
  });
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Внутренняя ошибка сервера. Попробуйте снова.' });
}

module.exports = errorHandler;
