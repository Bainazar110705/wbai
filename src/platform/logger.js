const SENSITIVE_KEYS = /authorization|password|secret|token|api[_-]?key|imagebase64|base64/i;

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEYS.test(key) ? '[REDACTED]' : sanitize(item)]));
}

function write(level, event, metadata = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitize(metadata)
  };
  const output = JSON.stringify(record);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

module.exports = {
  info: (event, metadata) => write('info', event, metadata),
  warn: (event, metadata) => write('warn', event, metadata),
  error: (event, metadata) => write('error', event, metadata)
};
