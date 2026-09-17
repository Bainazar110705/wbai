const { AppError } = require('../platform/errors');

function validate(schema) {
  return (req, res, next) => {
    try {
      schema(req);
      next();
    } catch (error) {
      next(error instanceof AppError ? error : new AppError(400, error.message || 'Некорректный запрос', 'VALIDATION_ERROR'));
    }
  };
}

function requireString(value, message, { min = 1, max } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || (max && value.length > max)) {
    throw new AppError(400, message, 'VALIDATION_ERROR');
  }
  return value;
}

module.exports = { validate, requireString };
