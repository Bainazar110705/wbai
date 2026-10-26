const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFalError, USER_MESSAGES } = require('../src/services/fal-errors');

const echoedImage = 'data:image/jpeg;base64,' + 'A'.repeat(5000);

test('no_media_generated becomes a short user message without the echoed request', () => {
  const body = JSON.stringify({ detail: [{
    loc: ['body'],
    msg: 'The model did not generate the expected output for this prompt.',
    type: 'no_media_generated',
    input: { prompt: 'Подготовь SEO-оптимизированную карточку товара', image_urls: [echoedImage] }
  }] });

  const error = parseFalError(422, body);

  assert.equal(error.message, USER_MESSAGES.no_media_generated);
  assert.equal(error.status, 422);
  assert.deepEqual(error.falTypes, ['no_media_generated']);
  assert.ok(!error.message.includes('base64'));
});

test('unknown validation errors keep only fal messages and are truncated', () => {
  const body = JSON.stringify({ detail: [{ msg: 'x'.repeat(1000), type: 'value_error', input: echoedImage }] });

  const error = parseFalError(422, body);

  assert.equal(error.message.length, 300);
  assert.ok(!error.message.includes('base64'));
  assert.equal(error.status, 422);
});

test('provider failures and auth problems stay server errors', () => {
  assert.equal(parseFalError(500, 'Internal Server Error').status, 502);
  assert.equal(parseFalError(401, '{"detail":"Invalid key"}').status, 502);
  assert.equal(parseFalError(503, '').message, 'Сервис генерации вернул ошибку 503');
});
