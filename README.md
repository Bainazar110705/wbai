# WBai — AI помощник для продавцов Wildberries

## Деплой на свой сервер

Требования: Ubuntu/Debian, Node.js 20+, PostgreSQL, Nginx.

1. Установить PostgreSQL, создать БД и пользователя
2. Установить Node.js, скопировать проект
3. `cd /path/to/project && npm install`
4. Создать `.env` с переменными (см. ниже)
5. `pm2 start server.js --name wbai`
6. Настроить Nginx как reverse proxy на localhost:3000
7. Получить SSL через Certbot

## Переменные окружения (`.env`)

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing key (32+ chars) |
| `ADMIN_KEY` | Admin auth for subscription activation |
| `CLAUDE_API_KEY` | Anthropic API key (Claude Haiku) |
| `FAL_KEY` | fal.ai API key for image gen |
| `APP_URL` | Public URL for self-ping (e.g. https://wbai.kz) |

## Активация подписки клиента

После оплаты выполни:
```
POST /api/admin/activate
{
  "adminKey": "твой-ADMIN_KEY",
  "email": "клиент@email.com",
  "months": 1
}
```

Или через curl:
```bash
curl -X POST https://wbai.kz/api/admin/activate \
  -H "Content-Type: application/json" \
  -d '{"adminKey":"пароль","email":"клиент@email.com","months":1}'
```

## Просмотр всех пользователей
```bash
curl https://wbai.kz/api/admin/users \
  -H "x-admin-key: пароль"
```
