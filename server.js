const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'wbai-secret-key-change-in-production';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const FAL_KEY = process.env.FAL_KEY || '';
// ADMIN_KEY: если задана переменная окружения — используем её, иначе дефолт
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim() || 'wbai-admin-2024';

// Безопасное логирование — никогда не выводим значение ключа
console.log('[WBai] ADMIN_KEY source:', process.env.ADMIN_KEY ? 'ENV (Railway)' : 'DEFAULT');
console.log('[WBai] CLAUDE_API_KEY set:', !!CLAUDE_API_KEY);
console.log('[WBai] FAL_KEY set:', !!FAL_KEY);

// Rate limiting
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Подождите минуту.' }
});
const imageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: 'Максимум 3 генерации в минуту.' }
});

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = /^chrome-extension:\/\/|wbai\.up\.railway\.app|localhost/;
    allowed.test(origin) ? cb(null, true) : cb(new Error('CORS: домен не разрешён'));
  },
  credentials: true
}));
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
  'nano-banana-2': {
    name: 'Nano Banana 2',
    description: 'Лучший текст, сохраняет товар',
    badge: 'Рекомендуем',
    endpoint: 'fal-ai/nano-banana-2/edit',
    supportsImageInput: true,
  },
  'nano-banana-pro': {
    name: 'Nano Banana Pro',
    description: 'Максимальное качество текста',
    badge: null,
    endpoint: 'fal-ai/nano-banana-pro/edit',
    supportsImageInput: true,
  },
  'flux-kontext': {
    name: 'FLUX Kontext',
    description: 'Точная передача товара',
    badge: null,
    endpoint: 'fal-ai/flux-pro/kontext',
    supportsImageInput: true,
  },
  'flux-dev-i2i': {
    name: 'FLUX.1 Dev',
    description: 'Творческий стиль',
    badge: null,
    endpoint: 'fal-ai/flux/dev/image-to-image',
    supportsImageInput: true,
    strength: 0.55,
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
function buildPrompt(modelId, { title, primarySpec, secondarySpecs, extraText, styleAnalysis, accessoriesBlock, hasStyleRef, mode }) {
  const specs = secondarySpecs.filter(Boolean).map(s => s.trim());
  const isRedesign = mode === 'redesign';

  const textLines = [];
  if (title) textLines.push(`"${title}"`);
  if (primarySpec) textLines.push(`"${primarySpec}"`);
  specs.forEach(s => textLines.push(`"${s}"`));
  const textBlock = textLines.join('\n');

  // ── Image roles — the most important rules ──────────────────────────────
  const imageRolesBlock = hasStyleRef ? `
╔══════════════════════════════════════════════════════════╗
║           IMAGE ROLES — READ THIS FIRST                  ║
╠══════════════════════════════════════════════════════════╣
║ IMAGES 1…N-1  =  USER'S PRODUCT  (product source)       ║
║ LAST IMAGE    =  STYLE REFERENCE (design source ONLY)    ║
╚══════════════════════════════════════════════════════════╝

PRODUCT SOURCE (Images 1 to N-1):
These are the ONLY source for: product shape, product brand, product color,
accessories, product markings. The product in the final image MUST come
from these images and ONLY from these images.

STYLE REFERENCE (Last image) — ALLOWED to copy:
✅ Color palette and background colors
✅ Background style (diagonal, gradient, split, pattern)
✅ Badge/block shapes, rounded corners, borders
✅ Typography weight, size hierarchy, label style
✅ Icon style, decorative elements, shadows, glow effects
✅ Overall composition and layout positions

STYLE REFERENCE (Last image) — FORBIDDEN to copy:
❌ The product shown in it — use ONLY product from Images 1…N-1
❌ Any brand name or logo from the reference
❌ Any text, numbers, specifications from the reference
❌ Model names, product features from the reference
` : '';

  // ── Mode-specific scenario block ────────────────────────────────────────
  let scenarioBlock = '';
  if (hasStyleRef && isRedesign) {
    scenarioBlock = `
=== MODE: REDESIGN EXISTING CARD ===
Image 1 is the user's EXISTING infographic that needs a visual refresh.
KEEP from Image 1: the product, brand markings, advantages, characteristics, meaning.
REPLACE with last image's style: colors, background, typography, layout, icons, decorative elements.
Think of it as: same content dressed in the new visual style.`;
  } else if (hasStyleRef) {
    scenarioBlock = `
=== MODE: NEW INFOGRAPHIC WITH STYLE REFERENCE ===
Create a new infographic for the user's product using the reference as a design template.
Product = Images 1…N-1. Design template = last image.
The result should look like the user's product was always part of the same product line as the reference.`;
  } else {
    scenarioBlock = `
=== MODE: NEW INFOGRAPHIC FROM SCRATCH ===
Create a professional Wildberries infographic from scratch.
Bold design: diagonal color split or gradient background, strong typography, colored spec badges.`;
  }

  // ── Style instructions ──────────────────────────────────────────────────
  const styleInstructions = (hasStyleRef || styleAnalysis)
    ? `=== DESIGN TEMPLATE (from LAST image) ===
Copy PIXEL-PERFECTLY from the reference:
- Background: exact colors, gradients, diagonal splits, patterns — do NOT change to match product
- Badge/block style: exact shapes, rounded corners, border colors
- Typography: font weights, size hierarchy (large number + small label below)
- Layout positions: title top, specs left/right, product centered
- Icons style: copy guarantee shield, feature icons exactly
- Decorative elements: dividers, overlays, glow, shadows
${styleAnalysis ? `\nStyle analysis notes: ${styleAnalysis}` : ''}`
    : `=== DESIGN ===
Create a premium Wildberries infographic: diagonal yellow/color split background, bold spec badges,
cinematic product lighting, high contrast, professional marketplace card aesthetic.`;

  return `You are a professional Russian e-commerce designer creating a Wildberries product infographic card.
${imageRolesBlock}
${scenarioBlock}

=== IMAGES IN THIS REQUEST ===
- IMAGE 1: User's ${isRedesign ? 'EXISTING infographic' : 'product photo'}${title ? ` — "${title}"` : ''} → this is the HERO, place it large in center
- ADDITIONAL IMAGES (if any): Product accessories (case, battery, discs) → place them SMALLER around main product
- LAST IMAGE (if provided): Style reference ONLY → use for design, NOT for product content

${styleInstructions}

=== OUTPUT FORMAT ===
Portrait orientation 3:4 ratio (768×1024px).

=== LAYOUT ===
1. PRODUCT PLACEMENT (from Image 1):
   - Center or center-right, large (60-65% of frame height)
   - Keep exact angle from input photo — do NOT rotate or tilt
   - Strong cinematic lighting, bright rim light, drop shadow
   ${accessoriesBlock ? `- Accessories: place smaller (15-25%) arranged neatly around product` : '- No accessories'}

2. TITLE BLOCK (top area):
   - Copy title block style from reference (shape, position, font size)
   - Text inside: ${title ? `"${title}"` : 'product name from photo'}

3. SPEC BADGES (left or right column):
${textLines.slice(1).map(t => `   - "${t.replace(/^"|"$/g, '')}"`).join('\n') || '   - Key product characteristics'}

=== EXACT TEXT TO DISPLAY ===
${textBlock || '(derive key specs from product characteristics)'}
FORBIDDEN: text from reference, watermarks, barcodes, or any text not listed above.

${accessoriesBlock}
${extraText ? `\n=== USER REQUEST — HIGHEST PRIORITY ===\n${extraText}` : ''}

=== PRE-GENERATION CHECKLIST ===
Before finalizing the image, verify each point:
□ Product shown = user's product from Image 1 ✓
□ NO product from reference/last image ✓
□ NO brand or logo from reference ✓
□ NO text, numbers, specs from reference ✓
□ Visual style of reference IS applied ✓
If any box fails → rework the composition.`;
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
    const errText = await resp.text().catch(() => '{}');
    console.error('[WBai] fal.ai error response:', resp.status, errText);
    let err = {};
    try { err = JSON.parse(errText); } catch(e) {}
    const msg = typeof err?.detail === 'string' ? err.detail 
      : Array.isArray(err?.detail) ? JSON.stringify(err.detail)
      : err?.message || err?.error || errText || `fal.ai error ${resp.status}`;
    throw new Error(msg);
  }
  const resultJson = await resp.json();
  console.log('[WBai] fal.ai success, keys:', Object.keys(resultJson || {}));
  return resultJson;
}

app.post('/api/generate-image', imageLimiter, authMiddleware, checkSubscription, requirePlan('max'), async (req, res) => {
  const { prompt, imageBase64, styleImageBase64, extraImages, productName, specs, modelId, mode, aspectRatio, numImages } = req.body;

  if (!imageBase64) return res.status(400).json({ error: 'Загрузите фото товара' });

  const requestedCount = Math.min(Math.max(parseInt(numImages) || 1, 1), 4);
  const validRatios = ['3:4', '1:1', '8:5', '4:3', '16:9', '9:16'];
  const requestedRatio = validRatios.includes(aspectRatio) ? aspectRatio : '3:4';

  // Проверяем кредиты — нужно requestedCount кредитов
  const userCredits = await db.getAsync('SELECT photo_credits FROM users WHERE id = ?', [req.user.id]);
  const credits = userCredits?.photo_credits || 0;
  if (credits < requestedCount) {
    return res.status(403).json({
      error: `Недостаточно кредитов. Нужно ${requestedCount}, у вас ${credits}.`,
      credits_required: true,
      credits_left: credits
    });
  }

  const selectedModelId = (modelId && AI_MODELS[modelId]) ? modelId : 'nano-banana-2';
  const model = AI_MODELS[selectedModelId] || AI_MODELS['nano-banana-2'];
  console.log('[WBai] modelId received:', modelId, '→ using:', selectedModelId);
  console.log(`[WBai] Генерация через модель: ${selectedModelId}`);

  try {
    // Шаг 1: Claude анализирует стиль только для FLUX моделей
    // Nano Banana получает референс напрямую как изображение
    let styleAnalysis = null;
    if (styleImageBase64 && !selectedModelId.startsWith('nano-banana')) {
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
      title, primarySpec, secondarySpecs, extraText, styleAnalysis, accessoriesBlock,
      hasStyleRef: !!styleImageBase64, mode: mode || 'create'
    });

    // Шаг 4: Подготавливаем все фото
    let imageUrl = null;
    let allImageUrls = [];
    if (model.supportsImageInput) {
      console.log('[WBai] Подготавливаем фото для fal.ai...');
      imageUrl = prepareImageForFal(imageBase64);
      allImageUrls = [imageUrl];
      // Добавляем доп. фото (кейс, диски, АКБ и т.д.)
      if (extraImages && Array.isArray(extraImages)) {
        extraImages.slice(0, 9).forEach(img => {
          if (img) allImageUrls.push(prepareImageForFal(img));
        });
      }
      console.log(`[WBai] Всего фото: ${allImageUrls.length}`);
    }

    // Шаг 5: Формируем тело запроса под модель
    let falBody = {};
    if (selectedModelId === 'nano-banana-2' || selectedModelId === 'nano-banana-pro') {
      // Nano Banana Edit — передаём все фото напрямую включая референс стиля
      const editImageUrls = [...allImageUrls]; // товар + аксессуары
      if (styleImageBase64) {
        editImageUrls.push(prepareImageForFal(styleImageBase64)); // референс стиля последним
      }
      falBody = {
        prompt: finalPrompt,
        image_urls: editImageUrls,
        aspect_ratio: requestedRatio,
        num_images: requestedCount,
        safety_tolerance: '5',
      };
    } else if (selectedModelId === 'flux-kontext') {
      falBody = {
        prompt: finalPrompt,
        image_url: imageUrl,
        guidance_scale: 3.5,
        num_inference_steps: 28,
        image_size: { width: 768, height: 1024 },
        num_images: 1,
        safety_tolerance: '5',
      };
    } else if (selectedModelId === 'flux-dev-i2i') {
      falBody = {
        prompt: finalPrompt,
        image_url: imageUrl,
        strength: model.strength || 0.55,
        num_inference_steps: 35,
        guidance_scale: 3.5,
        image_size: { width: 768, height: 1024 },
        num_images: 1,
        enable_safety_checker: false,
      };
    } else {
      falBody = {
        prompt: finalPrompt,
        image_url: imageUrl,
        image_size: { width: 768, height: 1024 },
        num_images: 1,
      };
    }

    // Шаг 6: Вызываем fal.ai
    console.log(`[WBai] Отправляем запрос в fal.ai/${model.endpoint}...`);
    const result = await callFalApi(model.endpoint, falBody);

    console.log('[WBai] fal.ai result keys:', Object.keys(result || {}));

    // Собираем все URL из ответа
    const allUrls = (result?.images || []).map(img => img.url).filter(Boolean);
    if (result?.image?.url) allUrls.push(result.image.url);
    if (!allUrls.length) {
      console.error('[WBai] fal.ai ответ без изображений:', JSON.stringify(result));
      return res.status(500).json({ error: 'Изображение не сгенерировано' });
    }

    // Скачиваем все как base64 (нет CORS в расширении)
    const allBase64 = await Promise.all(allUrls.map(async url => {
      const imgResp = await fetch(url);
      const imgBuffer = await imgResp.arrayBuffer();
      return 'data:image/jpeg;base64,' + Buffer.from(imgBuffer).toString('base64');
    }));

    // Списываем кредиты (количество реально сгенерированных)
    const used = allBase64.length;
    await db.runAsync('UPDATE users SET photo_credits = GREATEST(0, photo_credits - ?) WHERE id = ?', [used, req.user.id]);

    // Возвращаем остаток кредитов
    const remaining = await db.getAsync('SELECT photo_credits FROM users WHERE id = ?', [req.user.id]);
    console.log(`[WBai] Готово! Модель: ${selectedModelId}, изображений: ${used}, кредитов осталось: ${remaining?.photo_credits || 0}`);
    res.json({ images: allBase64, imageBase64: allBase64[0], credits_left: remaining?.photo_credits || 0, credits_used: used, modelUsed: selectedModelId });

  } catch(e) {
    console.error('[WBai] generate-image error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Ошибка генерации: ' + e.message });
  }
});

app.post('/api/ai', aiLimiter, authMiddleware, checkSubscription, async (req, res) => {
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

// ═══════════════════════════════════════════════════
//  WB API TOKEN + АНАЛИТИКА
// ═══════════════════════════════════════════════════

// Таблица: CREATE wb_api_token column (добавляется один раз через db.js)

// POST /api/wb-token — сохранить токен WB
app.post('/api/wb-token', authMiddleware, async (req, res) => {
  const { token: wbToken } = req.body;
  if (!wbToken?.trim()) return res.status(400).json({ error: 'Введите токен' });
  // Проверяем токен
  try {
    const test = await fetch(`https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${new Date(Date.now()-86400000).toISOString().slice(0,10)}`, {
      headers: { Authorization: wbToken.trim() }
    });
    if (test.status === 401) return res.status(400).json({ error: 'Токен недействителен. Создайте новый в WB.' });
    if (test.status === 403) return res.status(400).json({ error: 'Нет прав. Нужна галочка «Статистика».' });
  } catch(e) { /* network — save anyway */ }
  await db.runAsync('UPDATE users SET wb_api_token=? WHERE id=?', [wbToken.trim(), req.user.id]);
  res.json({ ok: true });
});

// DELETE /api/wb-token
app.delete('/api/wb-token', authMiddleware, async (req, res) => {
  await db.runAsync('UPDATE users SET wb_api_token=NULL WHERE id=?', [req.user.id]);
  res.json({ ok: true });
});

// GET /api/wb-token/status
app.get('/api/wb-token/status', authMiddleware, async (req, res) => {
  const u = await db.getAsync('SELECT wb_api_token FROM users WHERE id=?', [req.user.id]);
  res.json({ hasToken: !!u?.wb_api_token, tokenPreview: u?.wb_api_token ? '****'+u.wb_api_token.slice(-6) : null });
});

// GET /api/wb-analytics
app.get('/api/wb-analytics', authMiddleware, async (req, res) => {
  const { period, from, to } = req.query;
  const u = await db.getAsync('SELECT wb_api_token FROM users WHERE id=?', [req.user.id]);
  if (!u?.wb_api_token) return res.status(400).json({ error: 'Токен WB не настроен', noToken: true });
  const wbToken = u.wb_api_token;

  // Период
  const now = new Date();
  let dateFrom, dateTo;
  if (from && to) { dateFrom=from; dateTo=to; }
  else {
    dateTo = now.toISOString().slice(0,10);
    const d = new Date(now);
    switch(period) {
      case 'today': d.setDate(d.getDate()); break;
      case 'week': d.setDate(d.getDate()-7); break;
      case '2weeks': d.setDate(d.getDate()-14); break;
      case 'month': d.setMonth(d.getMonth()-1); break;
      case '3months': d.setMonth(d.getMonth()-3); break;
      case 'halfyear': d.setMonth(d.getMonth()-6); break;
      case 'year': d.setFullYear(d.getFullYear()-1); break;
      default: d.setDate(d.getDate()-7);
    }
    dateFrom = d.toISOString().slice(0,10);
  }

  // Предыдущий период
  const diffMs = new Date(dateTo) - new Date(dateFrom);
  const prevTo   = new Date(new Date(dateFrom).getTime() - 86400000).toISOString().slice(0,10);
  const prevFrom = new Date(new Date(dateFrom).getTime() - diffMs - 86400000).toISOString().slice(0,10);

  async function wbFetch(path) {
    const r = await fetch('https://statistics-api.wildberries.ru' + path, {
      headers: { Authorization: wbToken }
    });
    if (r.status === 401) throw new Error('Токен недействителен (401)');
    if (r.status === 403) throw new Error('Нет прав доступа (403). Нужна галочка «Статистика».');
    if (r.status === 429) throw new Error('Лимит запросов WB API. Подождите минуту.');
    if (!r.ok) throw new Error('WB API error ' + r.status);
    return r.json();
  }

  try {
    // Запросы последовательно с паузой
    const ordersRaw = await wbFetch(`/api/v1/supplier/orders?dateFrom=${dateFrom}`);
    await new Promise(r => setTimeout(r, 400));
    const prevOrdersRaw = await wbFetch(`/api/v1/supplier/orders?dateFrom=${prevFrom}`).catch(() => []);
    await new Promise(r => setTimeout(r, 400));

    // Финансовый отчёт для прибыли (с задержкой 5-7 дней от WB)
    let reportRaw = [];
    try {
      const repFrom = new Date(dateFrom); repFrom.setDate(repFrom.getDate()-7);
      const rr = await wbFetch(`/api/v1/supplier/reportDetailByPeriod?dateFrom=${repFrom.toISOString().slice(0,10)}&dateTo=${dateTo}&rrdid=0`);
      reportRaw = Array.isArray(rr) ? rr : [];
    } catch(e) { reportRaw = []; }

    const inRange = d => d >= dateFrom && d <= dateTo;
    const prevInRange = d => d >= prevFrom && d <= prevTo;

    // Группируем заказы по дням (без отменённых)
    const ordersByDay = {};
    (Array.isArray(ordersRaw)?ordersRaw:[]).forEach(o => {
      if (o.isCancel) return;
      const day = (o.date||'').slice(0,10);
      if (!day||!inRange(day)) return;
      if (!ordersByDay[day]) ordersByDay[day]={count:0,sum:0};
      ordersByDay[day].count++;
      ordersByDay[day].sum += Math.round(o.finishedPrice||o.priceWithDisc||0);
    });

    // Прибыль из финотчёта
    const profitByDay = {};
    reportRaw.forEach(r => {
      const day=(r.rr_dt||r.create_dt||'').slice(0,10);
      if(!day||!inRange(day)) return;
      profitByDay[day]=(profitByDay[day]||0)+Math.round(r.ppvz_for_pay||0);
    });

    // Все дни периода
    const allDays = [];
    const cur = new Date(dateFrom), end = new Date(dateTo);
    while (cur <= end) {
      const day = cur.toISOString().slice(0,10);
      const o = ordersByDay[day]||{count:0,sum:0};
      allDays.push({ date:day, orders:o.count, revenue:o.sum, profit:profitByDay[day]||0 });
      cur.setDate(cur.getDate()+1);
    }

    const sumF = (arr,k) => arr.reduce((a,b)=>a+(b[k]||0),0);
    const totals = { orders:sumF(allDays,'orders'), revenue:sumF(allDays,'revenue'), profit:sumF(allDays,'profit') };

    // Предыдущий период
    let prevOrders=0,prevRevenue=0;
    (Array.isArray(prevOrdersRaw)?prevOrdersRaw:[]).forEach(o=>{
      if(o.isCancel) return;
      const d=(o.date||'').slice(0,10);
      if(prevInRange(d)){prevOrders++;prevRevenue+=Math.round(o.finishedPrice||o.priceWithDisc||0);}
    });
    const prevProfit = reportRaw.filter(r=>prevInRange((r.rr_dt||r.create_dt||'').slice(0,10))).reduce((a,r)=>a+Math.round(r.ppvz_for_pay||0),0);
    const prevTotals = { orders:prevOrders, revenue:prevRevenue, profit:prevProfit };

    res.json({ rows:allDays, totals, prevTotals, dateFrom, dateTo, prevFrom, prevTo });
  } catch(e) {
    console.error('[WBai] wb-analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/privacy.html'));
});

// Keep-warm endpoint для расширения (пингуем раз в 10 мин)
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

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
app.listen(PORT, () => {
  console.log('WBai running on port ' + PORT);
  // Пингуем себя каждые 10 минут — Railway усыпляет после ~15 мин простоя
  const selfUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/ping`
    : null;
  if (selfUrl) {
    setInterval(() => {
      fetch(selfUrl).catch(() => {});
    }, 10 * 60 * 1000); // 10 минут
    console.log('[WBai] Self-ping enabled:', selfUrl);
  }
});

// Глобальный обработчик ошибок — предотвращает краш сервера при unhandled rejection
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[WBai] Unhandled error:', err.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера. Попробуйте снова.' });
});
