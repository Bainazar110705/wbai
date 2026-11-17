// Название и номер продавца по токену: «Информация о продавце» WB.
const SELLER_INFO_URL = 'https://common-api.wildberries.ru/api/v1/seller-info';

function createSellerService({ fetchImpl = fetch } = {}) {
  // Номер продавца (sid) отличает кабинеты; если метод недоступен — null.
  async function getSellerInfo(token) {
    try {
      const response = await fetchImpl(SELLER_INFO_URL, {
        headers: { Authorization: token, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) return null;
      const data = await response.json();
      const sid = String(data?.sid || '').trim().slice(0, 64);
      const name = String(data?.tradeMark || data?.name || '').trim().slice(0, 200);
      return sid || name ? { sid: sid || null, name: name || null } : null;
    } catch {
      return null;
    }
  }

  return { getSellerInfo };
}

module.exports = { createSellerService, SELLER_INFO_URL };
