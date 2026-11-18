// Фото-кредиты пачками со сроком: месячные фото тарифа сгорают (Старт и Про —
// через месяц, Макс — через 3 месяца), докупленные — бессрочные.
// users.photo_credits остаётся итоговым балансом для кабинета и расширения.
module.exports = {
  id: '009_photo_credit_batches',
  async up(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS photo_credit_batches (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source VARCHAR(20) NOT NULL,
        amount INTEGER NOT NULL,
        remaining INTEGER NOT NULL,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS photo_credit_batches_user_idx ON photo_credit_batches (user_id, expires_at)');
    // Когда начислить следующие месячные фото тарифа.
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_credits_next_at TIMESTAMPTZ');
    // До этой даты у подписчика прежние условия тарифа (оплачено до смены тарифов).
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_terms_until TIMESTAMPTZ');

    // Уже начисленные и докупленные фото не сгорают.
    await pool.query(`
      INSERT INTO photo_credit_batches (user_id, source, amount, remaining)
      SELECT id, 'legacy', photo_credits, photo_credits FROM users WHERE COALESCE(photo_credits, 0) > 0
    `);
    await pool.query(`UPDATE users SET legacy_terms_until = subscription_end WHERE subscription_end > NOW()`);
  }
};
