const { asyncHandler } = require('../platform/errors');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function wrapAsyncRoutes(app) {
  for (const method of HTTP_METHODS) {
    const original = app[method].bind(app);
    app[method] = (route, ...handlers) => original(
      route,
      ...handlers.map(handler => handler?.constructor?.name === 'AsyncFunction' ? asyncHandler(handler) : handler)
    );
  }
}

module.exports = { wrapAsyncRoutes };
