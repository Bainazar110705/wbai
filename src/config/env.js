require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[WBai] Missing required environment variable: ${name}`);
  return value;
}

function requireSecret(name) {
  const value = requireEnv(name);
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`[WBai] ${name} must be at least 32 bytes long`);
  }
  return value;
}

function parseHttpOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[WBai] ${name} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`[WBai] ${name} must use HTTP or HTTPS`);
  }
  return url.origin;
}

function parseAllowedOrigin(value) {
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(value)) return value;
  return parseHttpOrigin(value, 'CORS_ALLOWED_ORIGINS entry');
}

const databaseUrl = requireEnv('DATABASE_URL');
if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
  throw new Error('[WBai] DATABASE_URL must use the postgres or postgresql scheme');
}

const appUrl = requireEnv('APP_URL');
const allowedOrigins = new Set([parseHttpOrigin(appUrl, 'APP_URL')]);
for (const origin of (process.env.CORS_ALLOWED_ORIGINS || '').split(',')) {
  const value = origin.trim();
  if (value) allowedOrigins.add(parseAllowedOrigin(value));
}

module.exports = Object.freeze({
  appUrl,
  port: Number(process.env.PORT || 3000),
  databaseUrl,
  jwtSecret: requireSecret('JWT_SECRET'),
  adminKey: requireSecret('ADMIN_KEY'),
  claudeApiKey: requireEnv('CLAUDE_API_KEY'),
  falKey: requireEnv('FAL_KEY'),
  allowedOrigins
});
