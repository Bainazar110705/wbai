// Фоновая загрузка данных кабинета для РНП. Первый раз забираем историю за
// 90 дней (столько хранит Statistics API), дальше — только изменения после
// сохранённых курсоров. Каждая страница пишется в БД сразу, поэтому прерванная
// загрузка продолжается с места остановки.
const crypto = require('node:crypto');
const { realizedOperationDirection, normalizeVendorCode } = require('./wb-finance.service');

const HISTORY_DAYS = 90;
// Расход рекламы за последние дни WB ещё уточняет — перезапрашиваем их.
const ADS_OVERLAP_DAYS = 2;
const UNIT_COSTS_DAYS = 30;
const UNIT_COSTS_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MINUTES = 30;
const MANUAL_REFRESH_AFTER_MS = 5 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
// Фоном обновляем только тех, кто открывал РНП за последние 3 дня.
const VIEWED_WITHIN_HOURS = 72;
const STEPS = ['orders', 'sales', 'stocks', 'ads', 'costs'];

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

function moscowDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(date);
}

function addDays(day, count) {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Логистика, хранение и приёмка WB на один выкуп — из финотчёта за 30 дней.
// Строки без артикула (общее хранение) делятся на все выкупы магазина.
// Удержания не берём: там акты рекламы, а реклама в РНП считается отдельно.
function computeUnitCosts(financeRows, { currency, dateFrom, dateTo } = {}) {
  const vendors = new Map();
  let unattributed = 0;
  let soldTotal = 0;
  let costTotal = 0;

  for (const row of Array.isArray(financeRows) ? financeRows : []) {
    const cost = money(row.logistics) + money(row.storage) + money(row.acceptance);
    const sold = realizedOperationDirection(row.operation) > 0 ? Math.abs(money(row.quantity)) : 0;
    const vendorCode = normalizeVendorCode(row.vendorCode);
    soldTotal += sold;
    costTotal += cost;
    if (!vendorCode) {
      unattributed += cost;
      continue;
    }
    const vendor = vendors.get(vendorCode) || { cost: 0, sold: 0 };
    vendor.cost += cost;
    vendor.sold += sold;
    vendors.set(vendorCode, vendor);
  }

  const round = value => Math.round(value * 100) / 100;
  const sharedPerUnit = soldTotal ? unattributed / soldTotal : 0;
  const byVendor = {};
  for (const [vendorCode, vendor] of vendors) {
    if (vendor.sold > 0) byVendor[vendorCode] = round(vendor.cost / vendor.sold + sharedPerUnit);
  }
  return {
    currency: currency || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    soldUnits: soldTotal,
    shopPerUnit: soldTotal ? round(costTotal / soldTotal) : 0,
    byVendor
  };
}

function createRnpSyncService({
  repository,
  statisticsService,
  salesFunnelService,
  advertisingService,
  financeService,
  logger,
  now = () => new Date(),
  setIntervalImpl = setInterval
}) {
  const running = new Map();

  async function run(userId) {
    const token = await repository.getToken(userId);
    if (!token) return;
    await repository.ensureSync(userId);
    const fingerprint = tokenFingerprint(token);
    const previous = await repository.getSync(userId);
    const tokenChanged = previous.token_fingerprint !== fingerprint;
    if (tokenChanged) await repository.resetData(userId, fingerprint);

    const progress = {
      initial: tokenChanged || !previous.last_success_at,
      steps: Object.fromEntries(STEPS.map(step => [step, 'pending'])),
      counts: { orders: 0, sales: 0, ads: 0 }
    };
    const sync = await repository.claimSync(userId, progress);
    if (!sync) return;

    const saveProgress = () => repository.updateSync(userId, { progress });
    const setStep = async (step, state) => {
      progress.steps[step] = state;
      await saveProgress();
    };
    const today = moscowDate(now());
    const historyStart = addDays(today, -(HISTORY_DAYS - 1));
    const result = { ads_error: null, stocks_error: null };

    try {
      for (const [step, method, save] of [
        ['orders', 'orders', repository.upsertOrders],
        ['sales', 'sales', repository.upsertSales]
      ]) {
        await setStep(step, 'running');
        await statisticsService.loadSince({
          method,
          token,
          cursor: sync[`${step}_cursor`] || `${historyStart}T00:00:00`,
          onPage: async (rows, cursor) => {
            await save(userId, rows);
            progress.counts[step] += rows.length;
            await repository.updateSync(userId, { [`${step}_cursor`]: cursor, progress });
          }
        });
        await setStep(step, 'done');
      }

      // Названия и остатки — снимок из воронки WB на сейчас; ошибка не мешает остальной таблице.
      await setStep('stocks', 'running');
      try {
        const catalog = await salesFunnelService.getCatalog({ token, date: today });
        await repository.replaceProducts(userId, catalog);
        result.stocks_at = now().toISOString();
        await setStep('stocks', 'done');
      } catch (error) {
        result.stocks_error = error.message;
        logger.warn('rnp_stocks_sync_failed', { userId, code: error.code, error: error.message });
        await setStep('stocks', 'error');
      }

      // Без доступа «Продвижение» РНП всё равно показывает заказы и выкупы.
      await setStep('ads', 'running');
      try {
        const adsFrom = sync.ads_synced_to
          ? [historyStart, addDays(sync.ads_synced_to, -ADS_OVERLAP_DAYS)].sort().pop()
          : historyStart;
        await advertisingService.getDailySpend({
          token,
          dateFrom: adsFrom,
          dateTo: today,
          onChunk: async ({ period, rows, currency }) => {
            await repository.replaceAdSpend(userId, period.from, period.to, rows);
            progress.counts.ads += rows.length;
            await repository.updateSync(userId, { ads_synced_to: period.to, ads_currency: currency, progress });
          }
        });
        await setStep('ads', 'done');
      } catch (error) {
        result.ads_error = error.message;
        logger.warn('rnp_ads_sync_failed', { userId, code: error.code, error: error.message });
        await setStep('ads', 'error');
      }

      const costsFresh = sync.unit_costs_at && now() - new Date(sync.unit_costs_at) < UNIT_COSTS_TTL_MS;
      if (costsFresh) {
        await setStep('costs', 'done');
      } else {
        await setStep('costs', 'running');
        try {
          const dateTo = addDays(today, -1);
          const dateFrom = addDays(today, -UNIT_COSTS_DAYS);
          const report = await financeService.getDetailedReport({ token, dateFrom, dateTo });
          result.unit_costs = computeUnitCosts(report.rows, { currency: report.currency, dateFrom, dateTo });
          result.unit_costs_at = now().toISOString();
          await setStep('costs', 'done');
        } catch (error) {
          logger.warn('rnp_unit_costs_failed', { userId, code: error.code, error: error.message });
          await setStep('costs', 'error');
        }
      }

      await repository.updateSync(userId, {
        ...result,
        status: 'idle',
        finished_at: now().toISOString(),
        last_success_at: now().toISOString()
      });
      logger.info('rnp_sync_completed', { userId, ...progress.counts });
    } catch (error) {
      logger.warn('rnp_sync_failed', { userId, code: error.code, error: error.message });
      STEPS.forEach(step => { if (progress.steps[step] === 'running') progress.steps[step] = 'error'; });
      await repository.updateSync(userId, {
        status: 'error',
        progress,
        finished_at: now().toISOString(),
        last_error: error.status && error.status < 500 ? error.message : 'WB временно недоступен. Повторим загрузку автоматически.'
      });
    }
  }

  function syncUser(userId) {
    if (running.has(userId)) return running.get(userId);
    const task = run(userId)
      .catch(error => logger.error('rnp_sync_crashed', { userId, error: error.message }))
      .finally(() => running.delete(userId));
    running.set(userId, task);
    return task;
  }

  // Открытие страницы запускает догрузку, если данные старше 30 минут.
  function requestSync(userId, sync, { force = false } = {}) {
    if (running.has(userId) || sync?.status === 'running') return false;
    const lastSuccess = sync?.last_success_at ? new Date(sync.last_success_at).getTime() : 0;
    const age = now().getTime() - lastSuccess;
    const due = force ? age > MANUAL_REFRESH_AFTER_MS : age > REFRESH_AFTER_MINUTES * 60 * 1000;
    if (!due) return false;
    syncUser(userId);
    return true;
  }

  async function tick() {
    try {
      const userIds = await repository.listDueUserIds({
        viewedWithinHours: VIEWED_WITHIN_HOURS,
        refreshAfterMinutes: REFRESH_AFTER_MINUTES
      });
      userIds.forEach(syncUser);
    } catch (error) {
      logger.warn('rnp_scheduler_failed', { error: error.message });
    }
  }

  async function startScheduler() {
    await repository.resetRunning();
    const timer = setIntervalImpl(tick, SCHEDULER_INTERVAL_MS);
    timer?.unref?.();
    tick();
    return timer;
  }

  return { syncUser, requestSync, startScheduler, isRunning: userId => running.has(userId) };
}

module.exports = {
  createRnpSyncService,
  computeUnitCosts,
  tokenFingerprint,
  moscowDate,
  addDays,
  HISTORY_DAYS,
  STEPS
};
