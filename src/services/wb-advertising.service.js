function positiveCampaignId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function extractAdvertisingCampaigns(payload) {
  const source = Array.isArray(payload?.adverts) ? payload.adverts : (Array.isArray(payload) ? payload : []);
  return source.flatMap(group => {
    const items = Array.isArray(group?.advert_list)
      ? group.advert_list.map(item => ({ ...group, ...item }))
      : [group];

    return items.map(item => {
      const id = positiveCampaignId(item?.advertId ?? item?.id);
      if (!id) return null;
      const currency = String(item.currency || group?.currency || '').trim().toUpperCase() || null;
      const nmSettings = Array.isArray(item.nm_settings) ? item.nm_settings : [];
      return {
        id,
        name: String(item.name || item.settings?.name || `Кампания ${id}`).slice(0, 200),
        status: item.status ?? group?.status ?? null,
        type: item.type ?? group?.type ?? null,
        currency,
        nmIds: nmSettings
          .map(setting => positiveCampaignId(setting?.nm_id ?? setting?.nmId))
          .filter(Boolean)
      };
    }).filter(Boolean);
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function resolveAdvertisingCurrency(campaign, accountCurrencies) {
  if (campaign?.currency) return campaign.currency;
  const currencies = [...new Set((accountCurrencies || []).filter(Boolean).map(value => String(value).toUpperCase()))];
  if (currencies.length === 1) return currencies[0];
  const error = new Error('Не удалось однозначно определить валюту рекламной кампании WB.');
  error.status = 502;
  error.code = 'WB_ADVERT_CURRENCY_UNKNOWN';
  throw error;
}

const ADVERT_API_URL = 'https://advert-api.wildberries.ru';
const FULLSTATS_BATCH_SIZE = 50;
// У fullstats лимит — 1 запрос в 20 секунд на кабинет.
const FULLSTATS_INTERVAL_MS = 20_000;
const MAX_ADVERT_PERIOD_DAYS = 31;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function advertisingApiError(status, retrySeconds) {
  const retryMinutes = Math.max(1, Math.ceil((retrySeconds || 60) / 60));
  const messages = {
    401: 'Токен WB недействителен.',
    403: 'В токене WB нет доступа «Продвижение». Добавьте его в настройках WB.',
    429: `WB временно ограничил запросы рекламы. Повторите через ${retryMinutes} мин.`
  };
  const error = new Error(messages[status] || `API рекламы WB вернул ошибку ${status}.`);
  error.status = status === 401 ? 400 : (status === 403 || status === 429 ? status : 502);
  error.code = `WB_ADVERT_${status}`;
  return error;
}

function moneyNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Методы статистики WB принимают не больше 31 дня за запрос.
function splitAdvertisingPeriod(dateFrom, dateTo) {
  const chunks = [];
  const end = Date.parse(`${dateTo}T00:00:00.000Z`);
  for (let start = Date.parse(`${dateFrom}T00:00:00.000Z`); start <= end; start += MAX_ADVERT_PERIOD_DAYS * DAY_MS) {
    const chunkEnd = Math.min(start + (MAX_ADVERT_PERIOD_DAYS - 1) * DAY_MS, end);
    chunks.push({
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(chunkEnd).toISOString().slice(0, 10)
    });
  }
  return chunks;
}

function emptyAdvertisingTotals() {
  return { spend: 0, orderSum: 0, views: 0, clicks: 0, orders: 0 };
}

function createAdvertisingStatsService({
  fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  let lastFullstatsAt = null;

  async function request(path, token) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(`${ADVERT_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      });
      const retrySeconds = moneyNumber(response.headers?.get?.('x-ratelimit-retry'));
      if (response.status === 429 && attempt === 1) {
        const retryMs = (retrySeconds || 20) * 1000 + 1000;
        if (retryMs <= MAX_RATE_LIMIT_WAIT_MS) {
          await wait(retryMs);
          continue;
        }
      }
      if (!response.ok) throw advertisingApiError(response.status, retrySeconds);
      return response.json();
    }
  }

  async function fullstats(token, ids, period) {
    if (lastFullstatsAt !== null) {
      const remaining = FULLSTATS_INTERVAL_MS - (Date.now() - lastFullstatsAt);
      if (remaining > 0) await wait(remaining);
    }
    lastFullstatsAt = Date.now();
    return request(`/adv/v3/fullstats?ids=${ids.join(',')}&beginDate=${period.from}&endDate=${period.to}`, token);
  }

  // Повторяет страницу «Статистика» WB Продвижение: все кампании кабинета,
  // включая завершённые, и удалённые, если по ним были списания.
  async function getPeriodStats({ token, dateFrom, dateTo }) {
    lastFullstatsAt = null;
    const campaigns = extractAdvertisingCampaigns(await request('/api/advert/v2/adverts', token));
    const campaignIds = campaigns.map(campaign => campaign.id);
    const currencies = campaigns.map(campaign => campaign.currency).filter(Boolean);
    const totals = emptyAdvertisingTotals();
    const activeCampaigns = new Set();

    for (const period of splitAdvertisingPeriod(dateFrom, dateTo)) {
      const charges = await request(`/adv/v1/upd?from=${period.from}&to=${period.to}`, token);
      const ids = new Set(campaignIds);
      for (const charge of Array.isArray(charges) ? charges : []) {
        const id = positiveCampaignId(charge?.advertId);
        if (id) ids.add(id);
      }
      const idList = [...ids];
      for (let index = 0; index < idList.length; index += FULLSTATS_BATCH_SIZE) {
        const stats = await fullstats(token, idList.slice(index, index + FULLSTATS_BATCH_SIZE), period);
        for (const item of Array.isArray(stats) ? stats : []) {
          totals.spend += moneyNumber(item?.sum);
          totals.orderSum += moneyNumber(item?.sum_price);
          totals.views += moneyNumber(item?.views);
          totals.clicks += moneyNumber(item?.clicks);
          totals.orders += moneyNumber(item?.orders);
          const id = positiveCampaignId(item?.advertId);
          if (id && (moneyNumber(item?.sum) || moneyNumber(item?.views))) activeCampaigns.add(id);
        }
      }
    }

    return {
      currency: campaigns.length ? resolveAdvertisingCurrency(null, currencies) : null,
      campaignCount: activeCampaigns.size,
      totals
    };
  }

  return { getPeriodStats };
}

module.exports = {
  extractAdvertisingCampaigns,
  resolveAdvertisingCurrency,
  createAdvertisingStatsService,
  splitAdvertisingPeriod,
  advertisingApiError,
  FULLSTATS_INTERVAL_MS
};
