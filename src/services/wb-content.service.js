// Карточки товаров WB (API «Контент»): размеры, chrtId и баркоды — для остатков.
const { AppError } = require('../platform/errors');

const CARDS_URL = 'https://content-api.wildberries.ru/content/v2/get/cards/list';
const PAGE_LIMIT = 100;
const MAX_PAGES = 300;
// Лимит «Контента» — около 100 запросов в минуту: между страницами небольшая пауза.
const PAGE_PAUSE_MS = 650;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Карточка → строки по размерам.
function cardSizes(card) {
  const photo = card?.photos?.[0]?.c246x328 || card?.photos?.[0]?.tm || card?.photos?.[0]?.big || '';
  const sizes = Array.isArray(card?.sizes) ? card.sizes : [];
  return sizes.map(size => ({
    nmId: number(card.nmID),
    vendorCode: String(card.vendorCode || ''),
    title: String(card.title || ''),
    brand: String(card.brand || ''),
    subject: String(card.subjectName || ''),
    photo: String(photo || ''),
    size: String(size.techSize || size.wbSize || ''),
    chrtId: number(size.chrtID),
    skus: (Array.isArray(size.skus) ? size.skus : []).map(String).filter(Boolean)
  })).filter(row => row.chrtId > 0);
}

function createContentService({ fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  async function page(token, cursor) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(CARDS_URL, {
          method: 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ settings: { cursor, filter: { withPhoto: -1 } } }),
          signal: AbortSignal.timeout(30_000)
        });
      } catch (error) {
        throw new AppError(502, 'WB не ответил при загрузке карточек. Попробуйте через минуту.', 'WB_UNAVAILABLE');
      }
      if (response.status === 429 && attempt < 4) {
        const retrySeconds = number(response.headers?.get?.('x-ratelimit-retry')) || 3 * attempt;
        await wait(Math.min(retrySeconds, 20) * 1000 + 250);
        continue;
      }
      if (response.status === 401) throw new AppError(400, 'Токен магазина недействителен. Выпустите новый в WB Partners.', 'WB_TOKEN_INVALID');
      if (response.status === 403) throw new AppError(403, 'У токена магазина нет доступа к категории «Контент» — без неё не получить размеры и баркоды товаров.', 'WB_CONTENT_FORBIDDEN');
      if (!response.ok) throw new AppError(502, `WB ответил ошибкой ${response.status} при загрузке карточек.`, 'WB_ERROR');
      return response.json();
    }
  }

  // Все карточки магазина (постранично, курсор WB: updatedAt + nmID).
  async function listSizes(token) {
    const rows = [];
    let cursor = { limit: PAGE_LIMIT };
    for (let index = 0; index < MAX_PAGES; index++) {
      const data = await page(token, cursor);
      const cards = Array.isArray(data?.cards) ? data.cards : [];
      for (const card of cards) rows.push(...cardSizes(card));
      const next = data?.cursor || {};
      if (cards.length < PAGE_LIMIT || number(next.total) < PAGE_LIMIT || !next.updatedAt) break;
      cursor = { limit: PAGE_LIMIT, updatedAt: next.updatedAt, nmID: next.nmID };
      await wait(PAGE_PAUSE_MS);
    }
    return rows;
  }

  return { listSizes };
}

module.exports = { createContentService, cardSizes, CARDS_URL };
