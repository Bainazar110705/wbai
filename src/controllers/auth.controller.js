function subscriptionPayload(user) {
  const end = user.subscription_end ? new Date(user.subscription_end) : null;
  return { active: !!(end && end > new Date()), end };
}

function createAuthController(authService) {
  return {
    async register(req, res) {
      try {
        await authService.register(req.body);
        res.json({ ok: true, message: 'Регистрация успешна!' });
      } catch (error) {
        res.status(400).json({ error: 'Email уже зарегистрирован' });
      }
    },

    async login(req, res) {
      const result = await authService.login(req.body);
      if (!result) return res.status(401).json({ error: 'Неверный email или пароль' });
      const { token, user } = result;
      res.json({
        ok: true,
        token,
        user: { id: user.id, email: user.email, name: user.name },
        subscription: subscriptionPayload(user)
      });
    },

    async me(req, res) {
      const user = await authService.getProfile(req.user.id);
      if (!user) return res.status(404).json({ error: 'Не найден' });
      res.json({
        user: { ...user, plan: user.plan || 'start', photo_credits: user.photo_credits || 0 },
        subscription: subscriptionPayload(user)
      });
    },

    async changePassword(req, res) {
      const updated = await authService.changePassword({
        userId: req.user.id,
        oldPassword: req.body.currentPassword,
        newPassword: req.body.newPassword
      });
      if (!updated) return res.status(401).json({ error: 'Неверный текущий пароль' });
      res.json({ ok: true });
    }
  };
}

module.exports = { createAuthController };
