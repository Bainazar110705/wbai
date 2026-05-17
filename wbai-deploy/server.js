const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'wbai-secret-key-change-in-production';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware проверки токена
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Недействительный токен' });
  }
}

// Проверка подписки
function checkSubscription(req, res, next) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
  if (!user.subscription_end || new Date(user.subscription_end) < new Date()) {
    return res.status(403).json({ error: 'Подписка истекла', expired: true });
  }
  req.dbUser = user;
  next();
}

// === AUTH ===
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (email, password, name) VALUES (?, ?, ?)').run(email.toLowerCase(), hash, name || '');
    res.json({ ok: true, message: 'Регистрация успешна! Теперь купите подписку.' });
  } catch(e) {
    res.status(400).json({ error: 'Email уже зарегистрирован' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  const subEnd = user.subscription_end ? new Date(user.subscription_end) : null;
  const isActive = subEnd && subEnd > new Date();

  res.json({
    ok: true,
    token,
    user: { id: user.id, email: user.email, name: user.name },
    subscription: { active: isActive, end: subEnd }
  });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, email, name, subscription_end FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  const subEnd = user.subscription_end ? new Date(user.subscription_end) : null;
  res.json({
    user,
    subscription: { active: subEnd && subEnd > new Date(), end: subEnd }
  });
});

// === ШАБЛОНЫ ===
app.get('/api/templates', authMiddleware, checkSubscription, (req, res) => {
  const templates = db.prepare('SELECT * FROM templates WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json({ templates });
});

app.post('/api/templates', authMiddleware, checkSubscription, (req, res) => {
  const { name, category, chars, length, width, height, weight, price, kw, date } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });

  // Удаляем старый если есть
  db.prepare('DELETE FROM templates WHERE user_id = ? AND name = ?').run(req.user.id, name);

  const result = db.prepare(
    'INSERT INTO templates (user_id, name, category, chars, length, width, height, weight, price, kw, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, name, category || '', chars || '', length || '', width || '', height || '', weight || '', price || '', kw || '', date || '');

  res.json({ ok: true, id: result.lastInsertRowid });
});

app.delete('/api/templates/:name', authMiddleware, checkSubscription, (req, res) => {
  db.prepare('DELETE FROM templates WHERE user_id = ? AND name = ?').run(req.user.id, req.params.name);
  res.json({ ok: true });
});

// === AI PROXY ===
app.post('/api/ai', authMiddleware, checkSubscription, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Нет промпта' });
  if (!CLAUDE_API_KEY) return res.status(500).json({ error: 'API ключ не настроен' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: 'Ошибка AI: ' + e.message });
  }
});

// === АДМИНКА ===
app.post('/api/admin/activate', (req, res) => {
  const { adminKey, email, months } = req.body;
  if (adminKey !== (process.env.ADMIN_KEY || 'wbai-admin-2024')) {
    return res.status(403).json({ error: 'Неверный ключ' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const now = new Date();
  const current = user.subscription_end ? new Date(user.subscription_end) : now;
  const start = current > now ? current : now;
  const end = new Date(start);
  end.setMonth(end.getMonth() + (months || 1));

  db.prepare('UPDATE users SET subscription_end = ?, is_active = 1 WHERE id = ?').run(end.toISOString(), user.id);
  res.json({ ok: true, subscription_end: end.toISOString() });
});

app.get('/api/admin/users', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'wbai-admin-2024')) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  const users = db.prepare('SELECT id, email, name, subscription_end, created_at FROM users ORDER BY id DESC').all();
  res.json({ users });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('WBai server running on port ' + PORT));
