const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

function safeEqual(value, expected) {
  if (typeof value !== 'string') return false;
  const actualBuffer = Buffer.from(value, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

// Пропуск админа «только чтение»: смотреть кабинет пользователя можно, менять — нет.
// Разрешено только чтение и обновление данных WB (это не меняет настройки пользователя).
const VIEW_SESSION_TTL_SECONDS = 60 * 60;
const VIEW_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const VIEW_ALLOWED_WRITES = new Set(['POST /api/rnp/refresh']);

function viewRequestAllowed(method, path) {
  const verb = String(method || '').toUpperCase();
  if (VIEW_READ_METHODS.has(verb)) return true;
  const cleanPath = String(path || '').split('?')[0].replace(/\/+$/, '');
  return VIEW_ALLOWED_WRITES.has(`${verb} ${cleanPath}`);
}

function createViewToken({ jwt: signer = jwt, jwtSecret, user, shopId = null }) {
  return signer.sign(
    { id: user.id, email: user.email, view: true, shopId: shopId || null },
    jwtSecret,
    { expiresIn: VIEW_SESSION_TTL_SECONDS }
  );
}

function createAuthMiddleware({ usersRepository, jwtSecret, adminKey }) {
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Нет токена' });
    try {
      req.user = jwt.verify(token, jwtSecret);
    } catch (error) {
      return res.status(401).json({ error: 'Недействительный токен' });
    }
    if (req.user?.view && !viewRequestAllowed(req.method, req.originalUrl || req.url)) {
      return res.status(403).json({ error: 'Режим просмотра: изменения недоступны.', readOnly: true });
    }
    next();
  }

  async function subscription(req, res, next) {
    try {
      const user = await usersRepository.findById(req.user.id);
      if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
      if (!user.subscription_end || new Date(user.subscription_end) < new Date()) {
        return res.status(403).json({ error: 'Подписка истекла', expired: true });
      }
      req.dbUser = user;
      next();
    } catch (error) {
      next(error);
    }
  }

  function requirePlan(minPlan) {
    const order = { start: 1, pro: 2, max: 3 };
    return (req, res, next) => {
      const plan = req.dbUser?.plan || 'start';
      if ((order[plan] || 1) >= (order[minPlan] || 1)) return next();
      const names = { pro: 'Про', max: 'Макс' };
      return res.status(403).json({
        error: `Эта функция доступна только на тарифе ${names[minPlan] || minPlan} и выше`,
        plan_required: minPlan
      });
    };
  }

  function admin(req, res, next) {
    const headerKey = req.get('x-admin-key');
    const bodyKey = typeof req.body?.adminKey === 'string' ? req.body.adminKey : undefined;
    if (!safeEqual(headerKey || bodyKey, adminKey)) return res.status(403).json({ error: 'Нет доступа' });
    next();
  }

  return { auth, subscription, requirePlan, admin };
}

module.exports = { createAuthMiddleware, createViewToken, viewRequestAllowed, VIEW_SESSION_TTL_SECONDS };
