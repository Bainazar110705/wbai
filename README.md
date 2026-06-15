# WBai — AI помощник для продавцов Wildberries

## Деплой через Docker Compose

```bash
# Клонировать и настроить .env
git clone <url> /opt/wbai
cd /opt/wbai
cp .env.example .env    # заполнить реальными ключами

# Запустить
docker compose up -d --build
```

Сервисы:
- **app** — Node.js приложение (порт 3000)
- **caddy** — reverse proxy с авто-SSL (порты 80/443)

## Переменные окружения (`.env`)

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing key (32+ chars) |
| `ADMIN_KEY` | Admin auth for subscription activation |
| `CLAUDE_API_KEY` | Anthropic API key (Claude Haiku) |
| `FAL_KEY` | fal.ai API key for image gen |
| `APP_URL` | Public URL (https://wbai.kz) |

## Команды

```bash
docker compose up -d              # запустить
docker compose logs -f            # смотреть логи
docker compose pull && up -d      # обновить (caddy)
docker compose build --no-cache && up -d -d  # пересобрать app
docker compose down               # остановить
```

## Активация подписки клиента

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
