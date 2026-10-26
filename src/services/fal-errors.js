// Ошибки fal.ai могут содержать исходный запрос целиком, включая фото в base64.
// Наружу и в лог отдаём только тип ошибки и короткое понятное сообщение.
const MAX_DETAIL_LENGTH = 300;

const USER_MESSAGES = {
  no_media_generated: 'Модель не смогла создать изображение по этому запросу. В поле пожелания опишите только дизайн инфографики: фон, цвета, расположение, надписи. Просьбы написать текст карточки, SEO-описание или перечислить характеристики модель изображений не выполняет — для этого используйте AI-копирайтинг.',
  content_policy_violation: 'Модель отклонила запрос по правилам безопасности. Измените фото или текст пожелания.'
};

function parseFalError(status, text) {
  let body = null;
  try { body = JSON.parse(text); } catch {}

  const details = Array.isArray(body?.detail) ? body.detail : [];
  const types = [...new Set(details.map(item => String(item?.type || '')).filter(Boolean))];
  const knownType = types.find(type => USER_MESSAGES[type]);

  let message;
  if (knownType) message = USER_MESSAGES[knownType];
  else if (typeof body?.detail === 'string') message = body.detail;
  else if (details.length) message = details.map(item => String(item?.msg || '')).filter(Boolean).join('; ');
  else message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : '';
  message = (message || `Сервис генерации вернул ошибку ${status}`).slice(0, knownType ? undefined : MAX_DETAIL_LENGTH);

  const error = new Error(message);
  // Ошибки содержимого запроса — вина ввода, а не сервера.
  error.status = knownType || (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) ? 422 : 502;
  error.falStatus = status;
  error.falTypes = types;
  error.userFacing = true;
  return error;
}

module.exports = { parseFalError, USER_MESSAGES };
