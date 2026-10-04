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

module.exports = {
  extractAdvertisingCampaigns,
  resolveAdvertisingCurrency
};
