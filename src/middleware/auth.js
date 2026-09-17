const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

function safeEqual(value, expected) {
  if (typeof value !== 'string') return false;
  const actualBuffer = Buffer.from(value, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function createAuthMiddleware({ usersRepository, jwtSecret, adminKey }) {
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Нет токена' });
    try {
      req.user = jwt.verify(token, jwtSecret);
      next();
    } catch (error) {
      res.status(401).json({ error: 'Недействительный токен' });
    }
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

module.exports = { createAuthMiddleware };
