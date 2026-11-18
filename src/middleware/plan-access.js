// «Аналитика WB» и «Рука на пульсе» — на тарифах Про и Макс при активной
// подписке. Подписчики со старыми условиями (оплачено до смены тарифов)
// пользуются ими до конца оплаченного срока.
const ANALYTICS_PLANS = new Set(['pro', 'max']);

function hasAnalyticsAccess(user, now = new Date()) {
  if (!user) return false;
  if (user.legacy_terms_until && new Date(user.legacy_terms_until) > now) return true;
  const active = !!(user.subscription_end && new Date(user.subscription_end) > now);
  return active && ANALYTICS_PLANS.has(user.plan || 'start');
}

function createAnalyticsAccess({ usersRepository, now = () => new Date() }) {
  return async function requireAnalyticsPlan(req, res, next) {
    try {
      const user = await usersRepository.findById(req.user.id);
      if (hasAnalyticsAccess(user, now())) return next();
      res.status(403).json({
        error: '«Аналитика WB» и «Рука на пульсе» доступны на тарифах Про и Макс.',
        plan_required: 'pro',
        analyticsLocked: true
      });
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createAnalyticsAccess, hasAnalyticsAccess };
