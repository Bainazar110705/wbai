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
// Финотчёт: храним 2 года (Аналитика сравнивает «Год» с прошлым годом). Свежие
// 14 дней перезапрашиваем — WB дописывает корректировки; старое догружаем
// кусками по 92 дня, не больше трёх кусков за одну загрузку.
const FINANCE_HISTORY_DAYS = 730;
const FINANCE_CHUNK_DAYS = 92;
const FINANCE_OVERLAP_DAYS = 14;
const FINANCE_BACKFILL_CHUNKS = 3;
// Лимит Finance API — 1 запрос в минуту.
const FINANCE_INTERVAL_MS = 61_000;
const REFRESH_AFTER_MINUTES = 30;
const MANUAL_REFRESH_AFTER_MS = 5 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
// Фоном обновляем только тех, кто открывал РНП за последние 3 дня.
const VIEWED_WITHIN_HOURS = 72;
const STEPS = ['orders', 'sales', 'stocks', 'ads', 'finance', 'costs'];

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
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
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
      counts: { orders: 0, sales: 0, ads: 0, finance: 0 }
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
    const result = { ads_error: null, stocks_error: null, costs_error: null, finance_error: null };

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
        progress.steps[step] = 'done';
        await repository.updateSync(userId, { [`${step}_at`]: now().toISOString(), progress });
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
            const adsFromStored = !sync.ads_from || period.from < sync.ads_from ? period.from : sync.ads_from;
            sync.ads_from = adsFromStored;
            await repository.updateSync(userId, { ads_synced_to: period.to, ads_from: adsFromStored, ads_currency: currency, progress });
          }
        });
        result.ads_at = now().toISOString();
        await setStep('ads', 'done');
      } catch (error) {
        result.ads_error = error.message;
        logger.warn('rnp_ads_sync_failed', { userId, code: error.code, error: error.message });
        await setStep('ads', 'error');
      }

      await setStep('finance', 'running');
      try {
        await syncFinance({ userId, token, sync, today, progress });
        result.finance_at = now().toISOString();
        await setStep('finance', 'done');
      } catch (error) {
        result.finance_error = error.message;
        logger.warn('rnp_finance_sync_failed', { userId, code: error.code, error: error.message });
        await setStep('finance', 'error');
      }

      // Логистика на выкуп — из сохранённого финотчёта, без отдельного запроса к WB.
      await setStep('costs', 'running');
      const costsFrom = addDays(today, -UNIT_COSTS_DAYS);
      const costsTo = addDays(today, -1);
      const financeRows = await repository.listFinanceRows(userId, costsFrom, costsTo);
      if (financeRows.length) {
        result.unit_costs = computeUnitCosts(financeRows, { currency: financeRows[0].currency, dateFrom: costsFrom, dateTo: costsTo });
        result.unit_costs_at = now().toISOString();
        await setStep('costs', 'done');
      } else {
        result.costs_error = result.finance_error || 'В финотчёте WB за последние 30 дней нет строк.';
        await setStep('costs', 'error');
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

  async function loadFinanceWindow(token, window) {
    const rows = [];
    let currency = null;
    for (let rrdId = 0, page = 0; ; page++) {
      if (page > 0) await wait(FINANCE_INTERVAL_MS);
      const result = await financeService.getDetailedReportPage({ token, dateFrom: window.from, dateTo: window.to, rrdId });
      rows.push(...result.rows);
      currency = result.currency || currency;
      if (!result.nextRrdId) return { rows, currency };
      rrdId = result.nextRrdId;
    }
  }

  // Сначала свежий отрезок, затем — догрузка старых месяцев от новых к старым.
  async function syncFinance({ userId, token, sync, today, progress }) {
    const targetFrom = addDays(today, -(FINANCE_HISTORY_DAYS - 1));
    let financeFrom = sync.finance_to ? sync.finance_from : null;
    let financeTo = sync.finance_to || null;
    const recentFrom = financeTo
      ? [financeFrom || targetFrom, addDays(financeTo, -FINANCE_OVERLAP_DAYS)].sort().pop()
      : addDays(today, -(FINANCE_CHUNK_DAYS - 1));
    const windows = [{ from: recentFrom, to: today, recent: true }];
    let oldest = financeFrom && financeFrom < recentFrom ? financeFrom : recentFrom;
    for (let index = 0; index < FINANCE_BACKFILL_CHUNKS && oldest > targetFrom; index++) {
      const to = addDays(oldest, -1);
      const from = [targetFrom, addDays(to, -(FINANCE_CHUNK_DAYS - 1))].sort().pop();
      windows.push({ from, to });
      oldest = from;
    }

    for (const [index, window] of windows.entries()) {
      if (index > 0) await wait(FINANCE_INTERVAL_MS);
      let loaded;
      try {
        loaded = await loadFinanceWindow(token, window);
      } catch (error) {
        // Старее WB не отдаёт — считаем историю собранной до этой даты.
        if (!window.recent && error.code === 'WB_FINANCE_400') {
          await repository.updateSync(userId, { finance_from: targetFrom });
          return;
        }
        throw error;
      }
      await repository.replaceFinanceRows(userId, window.from, window.to, loaded.rows);
      progress.counts.finance += loaded.rows.length;
      if (!financeFrom || window.from < financeFrom) financeFrom = window.from;
      if (window.recent) financeTo = window.to;
      await repository.updateSync(userId, {
        finance_from: financeFrom,
        finance_to: financeTo,
        ...(loaded.currency ? { finance_currency: loaded.currency } : {}),
        progress
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
  FINANCE_HISTORY_DAYS,
  REFRESH_AFTER_MINUTES,
  STEPS
};
