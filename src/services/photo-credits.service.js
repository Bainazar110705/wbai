// Фото-кредиты пачками со сроком. Месячные фото тарифа начисляются каждый
// месяц подписки: Старт — 5, Про — 15, Макс — 40. Старт и Про сгорают через
// месяц, Макс — через 3 месяца; докупленные фото бессрочные. Тратятся сначала
// те, что сгорят раньше. users.photo_credits хранит итоговый баланс.
const PLAN_PHOTO_QUOTA = { start: 5, pro: 15, max: 40 };
const PLAN_PHOTO_LIFETIME_MONTHS = { start: 1, pro: 1, max: 3 };
// Защита от бесконечного цикла, если давно не заходили: не больше 2 лет начислений.
const MAX_GRANTS_PER_REFRESH = 24;

function addMonths(date, count) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + count);
  return result;
}

// Месячные пачки, положенные к моменту now: только при активной подписке и
// не раньше окончания прежних условий (legacy_terms_until).
function dueGrants(user, now) {
  if (!user?.plan_credits_next_at) return { grants: [], nextAt: null };
  let next = new Date(user.plan_credits_next_at);
  if (user.legacy_terms_until && new Date(user.legacy_terms_until) > now) return { grants: [], nextAt: next };
  const end = user.subscription_end ? new Date(user.subscription_end) : null;
  const plan = PLAN_PHOTO_QUOTA[user.plan] ? user.plan : 'start';
  const grants = [];
  while (end && next <= now && next < end && grants.length < MAX_GRANTS_PER_REFRESH) {
    grants.push({ amount: PLAN_PHOTO_QUOTA[plan], grantedAt: next, expiresAt: addMonths(next, PLAN_PHOTO_LIFETIME_MONTHS[plan]) });
    next = addMonths(next, 1);
  }
  return { grants, nextAt: next };
}

// Списание по пачкам в порядке сгорания. partial — снять сколько есть (админка).
function allocate(batches, amount, { partial = false } = {}) {
  const allocation = [];
  let left = amount;
  for (const batch of batches) {
    if (left <= 0) break;
    const take = Math.min(left, Number(batch.remaining) || 0);
    if (take > 0) {
      allocation.push({ id: batch.id, amount: take });
      left -= take;
    }
  }
  if (left > 0 && !partial) return null;
  return allocation;
}

const VALID_BATCHES = `user_id=? AND remaining > 0 AND (expires_at IS NULL OR expires_at > NOW())`;

function createPhotoCreditsService({ db, now = () => new Date() }) {
  async function updateTotal(tx, userId) {
    const row = await tx.getAsync(
      `UPDATE users SET photo_credits = (
         SELECT COALESCE(SUM(remaining), 0) FROM photo_credit_batches WHERE ${VALID_BATCHES}
       ) WHERE id=? RETURNING photo_credits`,
      [userId, userId]
    );
    return Number(row?.photo_credits) || 0;
  }

  async function refreshWith(tx, userId) {
    const user = await tx.getAsync(
      'SELECT id, plan, subscription_end, plan_credits_next_at, legacy_terms_until FROM users WHERE id=? FOR UPDATE',
      [userId]
    );
    if (!user) return null;
    const { grants, nextAt } = dueGrants(user, now());
    for (const grant of grants) {
      await tx.runAsync(
        `INSERT INTO photo_credit_batches (user_id, source, amount, remaining, granted_at, expires_at)
         VALUES (?, 'plan', ?, ?, ?, ?)`,
        [userId, grant.amount, grant.amount, grant.grantedAt.toISOString(), grant.expiresAt.toISOString()]
      );
    }
    if (grants.length) await tx.runAsync('UPDATE users SET plan_credits_next_at=? WHERE id=?', [nextAt.toISOString(), userId]);
    return updateTotal(tx, userId);
  }

  async function validBatches(tx, userId) {
    return tx.allAsync(
      `SELECT id, remaining, expires_at FROM photo_credit_batches WHERE ${VALID_BATCHES}
       ORDER BY expires_at ASC NULLS LAST, id FOR UPDATE`,
      [userId]
    );
  }

  async function spend(tx, allocation) {
    for (const part of allocation) {
      await tx.runAsync('UPDATE photo_credit_batches SET remaining = remaining - ? WHERE id=?', [part.amount, part.id]);
    }
  }

  return {
    // Начислить положенное, убрать сгоревшее; баланс и ближайшее сгорание.
    async summary(userId) {
      const total = await db.transaction(tx => refreshWith(tx, userId));
      const next = await db.getAsync(
        `SELECT expires_at, SUM(remaining)::int AS amount FROM photo_credit_batches
         WHERE ${VALID_BATCHES} AND expires_at IS NOT NULL
         GROUP BY expires_at ORDER BY expires_at LIMIT 1`,
        [userId]
      );
      return {
        total: total || 0,
        expiring: next ? { amount: Number(next.amount) || 0, at: new Date(next.expires_at).toISOString() } : null
      };
    },

    // Зарезервировать фото перед генерацией. null — фото не хватает.
    reserve(userId, amount) {
      return db.transaction(async tx => {
        await refreshWith(tx, userId);
        const allocation = allocate(await validBatches(tx, userId), amount);
        if (!allocation) return null;
        await spend(tx, allocation);
        return { photo_credits: await updateTotal(tx, userId), allocation };
      });
    },

    // Вернуть неиспользованные фото в те же пачки (последние списанные — первыми).
    async release(userId, amount, reservation) {
      if (!(amount > 0)) return;
      await db.transaction(async tx => {
        let left = amount;
        for (const part of [...(reservation?.allocation || [])].reverse()) {
          if (left <= 0) break;
          const give = Math.min(left, part.amount);
          if (give <= 0) continue;
          await tx.runAsync('UPDATE photo_credit_batches SET remaining = remaining + ? WHERE id=? AND user_id=?', [give, part.id, userId]);
          // Возвращённое больше не числится в резерве — повторный возврат не задвоится.
          part.amount -= give;
          left -= give;
        }
        // По резерву нельзя вернуть больше, чем по нему списано. Без резерва
        // (старый вызов) возвращаем отдельной бессрочной пачкой.
        if (left > 0 && !reservation) {
          await tx.runAsync(
            `INSERT INTO photo_credit_batches (user_id, source, amount, remaining) VALUES (?, 'refund', ?, ?)`,
            [userId, left, left]
          );
        }
        await updateTotal(tx, userId);
      });
    },

    // Докупленные фото — бессрочные.
    addPurchase(userId, amount, source = 'purchase') {
      return db.transaction(async tx => {
        await tx.runAsync(
          'INSERT INTO photo_credit_batches (user_id, source, amount, remaining) VALUES (?, ?, ?, ?)',
          [userId, source, amount, amount]
        );
        return refreshWith(tx, userId);
      });
    },

    // Снять фото вручную (админка): сколько есть, но не ниже нуля.
    deduct(userId, amount) {
      return db.transaction(async tx => {
        await refreshWith(tx, userId);
        await spend(tx, allocate(await validBatches(tx, userId), amount, { partial: true }));
        return updateTotal(tx, userId);
      });
    },

    // Оплата тарифа: новые условия. Новый тариф, первая оплата или продление
    // после перерыва — месячные фото начисляются сразу (за перерыв не начисляем).
    // Продление того же тарифа без перерыва сохраняет расписание.
    activatePlan(userId, { planChanged, wasActive }) {
      return db.transaction(async tx => {
        const restart = !!planChanged || !wasActive;
        await tx.runAsync(
          `UPDATE users SET legacy_terms_until=NULL,
             plan_credits_next_at = CASE WHEN ? OR plan_credits_next_at IS NULL THEN NOW() ELSE plan_credits_next_at END
           WHERE id=?`,
          [restart, userId]
        );
        return refreshWith(tx, userId);
      });
    }
  };
}

module.exports = {
  createPhotoCreditsService,
  dueGrants,
  allocate,
  addMonths,
  PLAN_PHOTO_QUOTA,
  PLAN_PHOTO_LIFETIME_MONTHS
};
