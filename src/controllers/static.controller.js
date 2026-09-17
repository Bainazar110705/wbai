const path = require('node:path');

function createStaticController(rootDir) {
  const page = name => (req, res) => res.sendFile(path.join(rootDir, 'public', name));
  return {
    privacy: page('privacy.html'),
    login: page('login.html'),
    dashboard: page('dashboard.html'),
    admin: page('admin.html'),
    index: page('index.html'),
    ping: (req, res) => res.json({ ok: true, ts: Date.now() })
  };
}

module.exports = { createStaticController };
