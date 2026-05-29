const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'wbai-secret-key-change-in-production';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const FAL_KEY = process.env.FAL_KEY || '';
// ADMIN_KEY: если задана переменная окружения — используем её, иначе дефолт
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim() || 'wbai-admin-2024';

console.log('[WBai] ADMIN_KEY source:', process.env.ADMIN_KEY ? 'ENV (Railway)' : 'DEFAULT (wbai-admin-2024)');
console.log('[WBai] ADMIN_KEY value:', ADMIN_KEY);
console.log('[WBai] CLAUDE_API_KEY set:', !!CLAUDE_API_KEY);
console.log('[WBai] FAL_KEY set:', !!FAL_KEY);

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Недействительный токен' });
  }
}

async function checkSubscription(req, res, next) {
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
  if (!user.subscription_end || new Date(user.subscription_end) < new Date()) {
    return res.status(403).json({ error: 'Подписка истекла', expired: true });
  }
  req.dbUser = user;
  next();
}

// Проверка плана: start — только отзывы/вопросы
// pro — + карточки, max — + инфографика
function requirePlan(minPlan) {
  const order = { start: 1, pro: 2, max: 3 };
  return (req, res, next) => {
    const plan = req.dbUser?.plan || 'start';
    if ((order[plan] || 1) >= (order[minPlan] || 1)) return next();
    const names = { pro: 'Про', max: 'Макс' };
    return res.status(403).json({
      error: `Эта функция доступна только на тарифе ${names[minPlan] || minPlan} и выше`,
      plan_required: minPlan
    });
  };
}

// === AUTH ===
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.runAsync('INSERT INTO users (email, password, name) VALUES (?, ?, ?)', [email.toLowerCase(), hash, name || '']);
    res.json({ ok: true, message: 'Регистрация успешна!' });
  } catch(e) {
    res.status(400).json({ error: 'Email уже зарегистрирован' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.getAsync('SELECT * FROM users WHERE email = ?', [email?.toLowerCase()]);
  if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  const subEnd = user.subscription_end ? new Date(user.subscription_end) : null;
  res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name }, subscription: { active: !!(subEnd && subEnd > new Date()), end: subEnd } });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await db.getAsync('SELECT id, email, name, subscription_end, ai_requests_count, plan, photo_credits FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  const subEnd = user.subscription_end ? new Date(user.subscription_end) : null;
  res.json({ user: { ...user, plan: user.plan || 'start', photo_credits: user.photo_credits || 0 }, subscription: { active: !!(subEnd && subEnd > new Date()), end: subEnd } });
});

app.get('/api/templates', authMiddleware, async (req, res) => {
  const templates = await db.allAsync('SELECT * FROM templates WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
  res.json({ templates });
});

app.post('/api/templates', authMiddleware, checkSubscription, async (req, res) => {
  const { name, category, chars, length, width, height, weight, price, kw, date } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  await db.runAsync('DELETE FROM templates WHERE user_id = ? AND name = ?', [req.user.id, name]);
  const result = await db.runAsync(
    'INSERT INTO templates (user_id, name, category, chars, length, width, height, weight, price, kw, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, name, category||'', chars||'', length||'', width||'', height||'', weight||'', price||'', kw||'', date||'']
  );
  res.json({ ok: true, id: result.lastID });
});

app.delete('/api/templates/:name', authMiddleware, checkSubscription, async (req, res) => {
  await db.runAsync('DELETE FROM templates WHERE user_id = ? AND name = ?', [req.user.id, decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
});

// === ПРОКСИ ДЛЯ ИЗОБРАЖЕНИЙ (для Canvas) ===
app.get('/api/image-proxy', authMiddleware, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Нет URL' });
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.json({ base64: `data:${contentType};base64,${base64}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// === WB PROXY ===
app.get('/api/wb/search', authMiddleware, async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Нет запроса' });
  try {
    // Пробуем разные эндпоинты WB
    const urls = [
      `https://search.wb.ru/exactmatch/ru/common/v9/search?appType=1&curr=rub&dest=-1257786&query=${encodeURIComponent(query)}&resultset=catalog&limit=10&sort=popular`,
      `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786&query=${encodeURIComponent(query)}&resultset=catalog&limit=10&sort=popular`,
    ];

    let data = null;
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
            'Origin': 'https://www.wildberries.ru',
            'Referer': 'https://www.wildberries.ru/',
          }
        });
        if (response.ok) {
          data = await response.json();
          if (data?.data?.products?.length) break;
        }
      } catch(e) { continue; }
    }

    if (!data?.data?.products?.length) {
      return res.status(404).json({ error: 'Товары не найдены', data: { products: [] } });
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wb/card', authMiddleware, async (req, res) => {
  const { nm } = req.query;
  if (!nm) return res.status(400).json({ error: 'Нет артикула' });
  try {
    const response = await fetch(
      `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nm}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'Origin': 'https://www.wildberries.ru',
          'Referer': 'https://www.wildberries.ru/',
        }
      }
    );
    const data = await response.json();
    if (!data?.data?.products?.length) {
      return res.status(404).json({ error: 'Товар не найден' });
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// === СТИЛИ ИНФОГРАФИКИ ===
app.get('/api/infographic-styles', authMiddleware, async (req, res) => {
  const styles = await db.allAsync('SELECT id, name, image_base64, created_at FROM infographic_styles ORDER BY id ASC', []);
  res.json({ styles });
});

app.post('/api/admin/infographic-styles', async (req, res) => {
  const { adminKey, name, imageBase64 } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  if (!imageBase64) return res.status(400).json({ error: 'Нет изображения' });
  await db.runAsync('INSERT INTO infographic_styles (name, image_base64) VALUES (?, ?)', [name || 'Стиль', imageBase64]);
  res.json({ ok: true });
});

app.delete('/api/admin/infographic-styles/:id', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  await db.runAsync('DELETE FROM infographic_styles WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// === ГЕНЕРАЦИЯ ИНФОГРАФИКИ ===

// Анализ примера стиля через Claude Vision: извлекаем детальное описание визуального стиля
// включая цвета текстовых блоков — чтобы Seedream воспроизвёл стиль текста
async function analyzeStyleWithClaude(styleImageBase64) {
  if (!CLAUDE_API_KEY || !styleImageBase64) return null;
  try {
    const base64Data = styleImageBase64.replace(/^data:image\/[a-z+]+;base64,/, '');
    const mediaType = styleImageBase64.includes('data:image/png') ? 'image/png' : 'image/jpeg';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: `Analyze this Wildberries product infographic for an AI image generator. Describe ONLY the visual design, ignore the products shown. Include:
1. BACKGROUND: exact colors, gradient direction, any split/diagonal patterns
2. COLOR PALETTE: list all colors used (use hex codes if visible, or precise color names like "deep yellow #FFD700", "near-black #1A1A1A")
3. TEXT BLOCK STYLE: color of text, background of spec blocks (rounded rects? what fill color?), any borders/glows
4. TITLE AREA: position, style, colors
5. DECORATIVE ELEMENTS: shapes, icons, dividers, badges — describe exactly
6. OVERALL MOOD: dark/light/colorful/minimal
Be specific and detailed — this will be given to an AI image generator.` }
          ]
        }]
      })
    });
    const data = await response.json();
    return data?.content?.[0]?.text || null;
  } catch(e) {
    console.error('[WBai] analyzeStyle error:', e.message);
    return null;
  }
}

// Определяем аксессуары из названия и характеристик → инструкции по размещению
function buildAccessoriesInstructions(productName, specs) {
  const text = ((productName || '') + ' ' + (specs || '')).toLowerCase();
  const items = [];

  // Аккумуляторы
  const akbNum = text.match(/(\d+)\s*(акб|аккумул)/);
  if (akbNum) {
    const n = parseInt(akbNum[1]);
    items.push(`BATTERIES: Show ${n} battery pack(s) — place them smaller (about 20% of product size) arranged neatly at the bottom-left or bottom area, label area next to them`);
  } else if (text.includes('акб') || text.includes('аккумул')) {
    items.push('BATTERIES: Show 1-2 battery pack(s) smaller at the bottom area');
  }

  // Кейс / чемодан
  if (text.match(/кейс|чемодан|кофр|carrying case/)) {
    items.push('CASE: Show a tool storage case — smaller (30% of product size), placed below or to the right of the product');
  }

  // Насадки / диски / биты
  if (text.match(/насадк|дискi|диск|бит|сверл|nozzle|attachment/)) {
    items.push('ATTACHMENTS: Show 2-3 discs/bits/nozzles arranged in a small row at the bottom');
  }

  // Зарядное устройство
  if (text.match(/зарядн|charger/)) {
    items.push('CHARGER: Show a compact charger unit smaller, in a bottom corner');
  }

  // Подарки / бонусы
  if (text.match(/подарок|подарк|бонус|gift/)) {
    items.push('GIFT ITEM: Show a small gift box or bonus item in a corner');
  }

  return items.length > 0
    ? '\nACCESSORIES TO INCLUDE (all SMALLER than main product, arranged around it):\n' + items.map(i => '- ' + i).join('\n')
    : '';
}


// ============================================================
// КОНФИГУРАЦИЯ МОДЕЛЕЙ FAL.AI
// ============================================================
const AI_MODELS = {
  'gpt-image-2': {
    name: 'GPT Image 2',
    description: 'Лучший текст на кириллице, инфографика',
    badge: 'Рекомендуем',
    endpoint: 'fal-ai/gpt-image-2/image-to-image',
    supportsImageInput: true,
  },
  'flux-kontext-pro': {
    name: 'FLUX Kontext Pro',
    description: 'Точная передача товара, реализм',
    badge: null,
    endpoint: 'fal-ai/flux-pro/kontext',
    supportsImageInput: true,
  },
  'seedream-5': {
    name: 'Seedream 5.0',
    description: 'Яркий стиль, кинематограф',
    badge: null,
    endpoint: 'fal-ai/seedream/v5',
    supportsImageInput: true,
  },
  'nano-banana-pro': {
    name: 'Nano Banana Pro',
    description: 'Максимальная скорость',
    badge: 'Быстро',
    endpoint: 'fal-ai/nano-banana/pro',
    supportsImageInput: false,
  },
};

// Эндпоинт — список моделей для UI
app.get('/api/models', authMiddleware, (req, res) => {
  const list = Object.entries(AI_MODELS).map(([id, m]) => ({
    id, name: m.name, description: m.description, badge: m.badge,
  }));
  res.json({ models: list });
});

// Построитель промптов под каждую модель
function buildPrompt(modelId, { title, primarySpec, secondarySpecs, extraText, styleAnalysis, accessoriesBlock }) {
  const styleBlock = styleAnalysis
    ? `VISUAL STYLE (apply exactly):\n${styleAnalysis}\n`
    : `VISUAL STYLE: Dark background (#0A0A1A), strong diagonal color accent (deep yellow or red), dramatic contrast lighting, cinematic atmosphere.`;
  const specsFormatted = secondarySpecs.map(s => `"${s.trim()}"`).join(' | ') || 'none';

  if (modelId === 'gpt-image-2') {
    return `Create a professional Wildberries marketplace product infographic card.
PRODUCT PHOTO: Use the provided product image exactly — same model, color, details. Do not substitute.
LAYOUT:
- Dark cinematic background (near-black with color accent)
- Product dominates 70% of canvas, tilted 15-20°, dramatic lighting
- Cinematic rim light cutting product against background
${accessoriesBlock}
TEXT TO RENDER (EXACT — render every word verbatim, zero typos):
- TITLE (top, large bold): EXACT TEXT: "${title}"
- PRIMARY SPEC (huge, high-contrast badge): EXACT TEXT: "${primarySpec}"
- SECONDARY SPECS (rounded dark badges, bottom area): ${specsFormatted}
TYPOGRAPHY RULES:
- All text in Russian Cyrillic — render exactly as written
- Title: bold, white or bright, top area
- Primary spec number: ENORMOUS, 2-3x bigger than secondary
- Each secondary spec: dark rounded rectangle badge, white text, number large + small label below
- NO extra text, NO watermarks, NO invented words
${styleBlock}
${extraText ? 'ADDITIONAL NOTES: ' + extraText : ''}
QUALITY: High-contrast, cinematic, marketplace-ready. Stop a scrolling buyer in 0.3 seconds.`;
  }

  if (modelId === 'flux-kontext-pro') {
    return `Transform this product photo into a professional Wildberries infographic card.
Keep the EXACT product from the photo — same model, color, every detail preserved.
SCENE: Dark industrial background, cinematic directional lighting. Product tilted 20°, filling 70% of frame.
${accessoriesBlock}
TEXT ELEMENTS:
Title at top: "${title}"
Large spec badge: "${primarySpec}"
Secondary badges: ${secondarySpecs.map(s => `"${s.trim()}"`).join(', ')}
${styleBlock}
${extraText ? 'Notes: ' + extraText : ''}`;
  }

  if (modelId === 'seedream-5') {
    return `WILDBERRIES PRODUCT INFOGRAPHIC — CINEMATIC STYLE
Product: place EXACTLY as shown in photo, same model and color.
Composition: tilted 20-25°, dominates 75% of canvas, cinematic close-up.
Background: dark industrial, atmospheric smoke, dramatic rim lighting.
${accessoriesBlock}
TEXT OVERLAY (Russian Cyrillic):
- Title: "${title}" — bold, top area, large
- Main spec: "${primarySpec}" — MASSIVE badge, high contrast yellow/red on dark
- Secondary: ${secondarySpecs.map(s => `"${s.trim()}"`).join(' | ')} — dark rounded badges bottom
${styleBlock}
${extraText ? 'Client notes: ' + extraText : ''}
NO watermarks. Aggressive visual energy. Conversion-focused.`;
  }

  return `Professional Wildberries product infographic for: "${title}".
Dark cinematic background, dramatic lighting.
TEXT (Russian Cyrillic): Title: "${title}", Main spec: "${primarySpec}", Details: ${secondarySpecs.map(s => `"${s.trim()}"`).join(', ')}
${styleBlock}
${extraText ? 'Notes: ' + extraText : ''}`;
}

// Загрузка изображения в fal.ai storage
// Конвертируем base64 в data URL для передачи напрямую в fal.ai
function prepareImageForFal(base64DataUrl) {
  // fal.ai принимает base64 data URL напрямую в поле image_url
  return base64DataUrl;
}

// Вызов fal.ai — прямой синхронный API
async function callFalApi(endpoint, body) {
  if (!FAL_KEY) throw new Error('FAL_KEY не настроен в переменных окружения');
  console.log('[WBai] callFalApi endpoint:', endpoint);
  const resp = await fetch(`https://fal.run/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${FAL_KEY}` },
    body: JSON.stringify(body),
  });
  console.log('[WBai] fal.ai status:', resp.status);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.detail || err?.error || `fal.ai error ${resp.status}`);
  }
  return await resp.json();
}

app.post('/api/generate-image', authMiddleware, checkSubscription, requirePlan('max'), async (req, res) => {
  const { prompt, imageBase64, styleImageBase64, extraImages, productName, specs, modelId } = req.body;

  if (!imageBase64) return res.status(400).json({ error: 'Загрузите фото товара' });

  // Проверяем кредиты ДО генерации
  const userCredits = await db.getAsync('SELECT photo_credits FROM users WHERE id = ?', [req.user.id]);
  const credits = userCredits?.photo_credits || 0;
  if (credits < 1) {
    return res.status(403).json({
      error: 'Недостаточно фото-кредитов. Пополните баланс у администратора.',
      credits_required: true,
      credits_left: 0
    });
  }

  const selectedModelId = modelId && AI_MODELS[modelId] ? modelId : 'gpt-image-2';
  const model = AI_MODELS[selectedModelId];
  console.log(`[WBai] Генерация через модель: ${selectedModelId}`);

  try {
    // Шаг 1: Claude анализирует референс-стиль
    let styleAnalysis = null;
    if (styleImageBase64) {
      styleAnalysis = await analyzeStyleWithClaude(styleImageBase64);
    }

    // Шаг 2: Парсим данные товара
    const specLines = specs ? specs.split('\n').filter(l => l.trim()).slice(0, 6) : [];
    const primarySpec = specLines.length > 0 ? specLines[0].trim() : '';
    const secondarySpecs = specLines.slice(1);
    const title = productName || '';
    const extraText = prompt || '';
    const accessoriesBlock = buildAccessoriesInstructions(productName, specs);

    // Шаг 3: Промпт под модель
    const finalPrompt = buildPrompt(selectedModelId, {
      title, primarySpec, secondarySpecs, extraText, styleAnalysis, accessoriesBlock
    });

    // Шаг 4: Подготавливаем фото (передаём base64 напрямую)
    let imageUrl = null;
    if (model.supportsImageInput) {
      console.log('[WBai] Подготавливаем фото для fal.ai...');
      imageUrl = prepareImageForFal(imageBase64);
    }

    // Шаг 5: Формируем тело запроса
    let falBody = {};
    if (selectedModelId === 'gpt-image-2') {
      falBody = { prompt: finalPrompt, image_url: imageUrl, image_size: 'square_hd', quality: 'high', num_images: 1 };
    } else if (selectedModelId === 'flux-kontext-pro') {
      falBody = { prompt: finalPrompt, image_url: imageUrl, guidance_scale: 3.5, num_inference_steps: 28, image_size: 'square_hd', num_images: 1 };
    } else if (selectedModelId === 'seedream-5') {
      falBody = { prompt: finalPrompt, image_url: imageUrl, image_size: 'square_hd', num_images: 1 };
    } else {
      falBody = { prompt: finalPrompt, image_size: 'square_hd', num_inference_steps: 4, num_images: 1 };
    }

    // Шаг 6: Вызываем fal.ai
    console.log(`[WBai] Отправляем запрос в fal.ai/${model.endpoint}...`);
    const result = await callFalApi(model.endpoint, falBody);

    const generatedUrl = result?.images?.[0]?.url || result?.image?.url;
    if (!generatedUrl) {
      console.error('[WBai] fal.ai ответ без изображения:', JSON.stringify(result));
      return res.status(500).json({ error: 'Изображение не сгенерировано' });
    }

    // Скачиваем как base64 (нет CORS в расширении)
    const imgResp = await fetch(generatedUrl);
    const imgBuffer = await imgResp.arrayBuffer();
    const imgBase64Out = 'data:image/jpeg;base64,' + Buffer.from(imgBuffer).toString('base64');

    // Списываем кредит
    await db.runAsync('UPDATE users SET photo_credits = GREATEST(0, photo_credits - 1) WHERE id = ?', [req.user.id]);

    // Возвращаем остаток кредитов
    const remaining = await db.getAsync('SELECT photo_credits FROM users WHERE id = ?', [req.user.id]);
    console.log(`[WBai] Готово! Модель: ${selectedModelId}, кредитов осталось: ${remaining?.photo_credits || 0}`);
    res.json({ imageBase64: imgBase64Out, credits_left: remaining?.photo_credits || 0, modelUsed: selectedModelId });

  } catch(e) {
    console.error('[WBai] generate-image error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Ошибка генерации: ' + e.message });
  }
});

app.post('/api/ai', authMiddleware, checkSubscription, async (req, res) => {
  const { prompt, feature } = req.body;
  // feature: 'reviews' (start+), 'cards' (pro+), default=reviews
  if (feature === 'cards' || feature === 'seo') {
    const plan = req.dbUser?.plan || 'start';
    if (plan === 'start') {
      return res.status(403).json({ error: 'Заполнение карточек доступно на тарифе Про и выше', plan_required: 'pro' });
    }
  }
  if (!prompt) return res.status(400).json({ error: 'Нет промпта' });
  if (!CLAUDE_API_KEY) return res.status(500).json({ error: 'API ключ не настроен' });
  
  let text = '';
  let lastError = '';
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await response.json();
      text = data.content?.[0]?.text || '';
      if (text) break; // Успех — выходим из цикла
      lastError = `Попытка ${attempt}: пустой ответ`;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    } catch(e) {
      lastError = e.message;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  
  if (!text) return res.status(500).json({ error: 'Сервер AI временно недоступен, попробуйте снова' });
  
  await db.runAsync('UPDATE users SET ai_requests_count = ai_requests_count + 1 WHERE id = ?', [req.user.id]);
  await db.runAsync('INSERT INTO ai_history (user_id, prompt, response) VALUES (?, ?, ?)',
    [req.user.id, prompt.substring(0, 200), text.substring(0, 500)]).catch(() => {});
  res.json({ text });
});

// === СМЕНА ПАРОЛЯ ===
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Заполните все поля' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const ok = await bcrypt.compare(currentPassword, user.password);
  if (!ok) return res.status(401).json({ error: 'Неверный текущий пароль' });
  const hash = await bcrypt.hash(newPassword, 10);
  await db.runAsync('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id]);
  res.json({ ok: true });
});

// === ИСТОРИЯ AI ЗАПРОСОВ ===
app.get('/api/history', authMiddleware, checkSubscription, async (req, res) => {
  // Создаём таблицу если нет
  await db.runAsync(`CREATE TABLE IF NOT EXISTS ai_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    prompt TEXT,
    response TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )`, []).catch(() => {});
  const rows = await db.allAsync('SELECT id, prompt, response, created_at FROM ai_history WHERE user_id = ? ORDER BY id DESC LIMIT 20', [req.user.id]);
  res.json({ history: rows });
});

// === АДМИНКА ===
app.post('/api/admin/activate', async (req, res) => {
  const { adminKey, email, months, plan } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Неверный ключ' });
  const user = await db.getAsync('SELECT * FROM users WHERE email = ?', [email?.toLowerCase()]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const now = new Date();
  const current = user.subscription_end ? new Date(user.subscription_end) : now;
  const start = current > now ? current : now;
  const end = new Date(start);
  end.setMonth(end.getMonth() + (months || 1));
  const userPlan = plan || 'start';
  // Тариф Макс — даём 30 кредитов за каждый месяц
  const bonusCredits = userPlan === 'max' ? 30 * (months || 1) : 0;
  await db.runAsync(
    'UPDATE users SET subscription_end = ?, is_active = 1, plan = ?, photo_credits = photo_credits + ? WHERE id = ?',
    [end.toISOString(), userPlan, bonusCredits, user.id]
  );
  res.json({ ok: true, subscription_end: end.toISOString(), plan: userPlan });
});

// Добавить фото-кредиты вручную
app.post('/api/admin/add-credits', async (req, res) => {
  const { adminKey, email, credits, note } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Неверный ключ' });
  if (!email || credits === undefined || credits === null) return res.status(400).json({ error: 'Укажите email и количество' });
  const user = await db.getAsync('SELECT * FROM users WHERE email = ?', [email?.toLowerCase()]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const amount = parseInt(credits);
  if (isNaN(amount)) return res.status(400).json({ error: 'Неверное количество' });
  // Отрицательное значение = снятие кредитов
  if (amount >= 0) {
    await db.runAsync('UPDATE users SET photo_credits = photo_credits + ? WHERE id = ?', [amount, user.id]);
  } else {
    // Снимаем, но не ниже 0
    await db.runAsync('UPDATE users SET photo_credits = GREATEST(0, photo_credits + ?) WHERE id = ?', [amount, user.id]);
  }
  await db.runAsync(
    'INSERT INTO credit_transactions (user_id, amount, note) VALUES (?, ?, ?)',
    [user.id, amount, note || (amount >= 0 ? 'Ручное пополнение' : 'Ручное снятие')]
  );
  const updated = await db.getAsync('SELECT photo_credits FROM users WHERE id = ?', [user.id]);
  res.json({ ok: true, photo_credits: updated.photo_credits });
});

// Получить историю транзакций кредитов (для админа)
app.get('/api/admin/credit-history/:userId', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  const history = await db.allAsync(
    'SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
    [req.params.userId]
  );
  res.json({ history });
});

app.post('/api/admin/remove-subscription', async (req, res) => {
  const { adminKey, email } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Неверный ключ' });
  const user = await db.getAsync('SELECT * FROM users WHERE email = ?', [email?.toLowerCase()]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  await db.runAsync('UPDATE users SET subscription_end = NULL, is_active = 0 WHERE id = ?', [user.id]);
  res.json({ ok: true });
});

app.get('/api/admin/templates', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  const templates = await db.allAsync(
    `SELECT t.*, u.email FROM templates t 
     LEFT JOIN users u ON t.user_id = u.id 
     ORDER BY t.id DESC LIMIT 500`, []
  );
  res.json({ templates });
});

app.get('/api/admin/users', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
  const users = await db.allAsync('SELECT id, email, name, subscription_end, created_at, plan, photo_credits FROM users ORDER BY id DESC', []);
  res.json({ users });
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/privacy.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('WBai running on port ' + PORT));
