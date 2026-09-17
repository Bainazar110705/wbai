const { start } = require('./src/app');

start().catch(error => {
  console.error('[WBai] Startup failed:', error.message);
  process.exitCode = 1;
});
