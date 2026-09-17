function registerStaticRoutes(app, controller) {
  app.get('/privacy', controller.privacy);
  app.get('/api/ping', controller.ping);
  app.get('/login', controller.login);
  app.get('/dashboard', controller.dashboard);
  app.get('/admin', controller.admin);
  app.get('*', controller.index);
}

module.exports = { registerStaticRoutes };
