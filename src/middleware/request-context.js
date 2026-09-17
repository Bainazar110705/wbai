const crypto = require('node:crypto');
const logger = require('../platform/logger');

function requestContext(req, res, next) {
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info('http_request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      ip: req.ip
    });
  });
  next();
}

module.exports = requestContext;
