const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAdvertisingCampaigns,
  resolveAdvertisingCurrency
} = require('../src/services/wb-advertising.service');

test('extractAdvertisingCampaigns supports current flat campaign schema', () => {
  const campaigns = extractAdvertisingCampaigns({ adverts: [{
    id: 39624033,
    currency: 'KZT',
    status: 11,
    settings: { name: 'Кампания от 20.08.2026' },
    nm_settings: [{ nm_id: 1429883545 }]
  }] });

  assert.deepEqual(campaigns, [{
    id: 39624033,
    name: 'Кампания от 20.08.2026',
    status: 11,
    type: null,
    currency: 'KZT',
    nmIds: [1429883545]
  }]);
});

test('extractAdvertisingCampaigns keeps compatibility with grouped schema', () => {
  const campaigns = extractAdvertisingCampaigns({ adverts: [{
    type: 9,
    status: 7,
    currency: 'RUB',
    advert_list: [{ advertId: 10, name: 'Поиск' }]
  }] });

  assert.equal(campaigns[0].id, 10);
  assert.equal(campaigns[0].type, 9);
  assert.equal(campaigns[0].currency, 'RUB');
});

test('resolveAdvertisingCurrency uses campaign currency or a single account currency', () => {
  assert.equal(resolveAdvertisingCurrency({ currency: 'KZT' }, ['RUB']), 'KZT');
  assert.equal(resolveAdvertisingCurrency({}, ['KZT', 'KZT']), 'KZT');
  assert.throws(() => resolveAdvertisingCurrency({}, ['KZT', 'RUB']), /однозначно определить валюту/);
});
