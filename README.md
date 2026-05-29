# WBai — AI помощник для продавцов Wildberries

## Деплой на Railway

1. Загрузи все файлы в GitHub репозиторий (без вложенных папок)
2. Зайди на railway.app → New Project → Deploy from GitHub
3. Выбери репозиторий
4. В настройках добавь переменные окружения:
   - `JWT_SECRET` — любая случайная строка (32+ символа)
   - `ADMIN_KEY` — твой пароль для активации подписок
   - `CLAUDE_API_KEY` — твой Claude API ключ
5. Нажми Deploy

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
curl -X POST https://твой-домен.railway.app/api/admin/activate \
  -H "Content-Type: application/json" \
  -d '{"adminKey":"пароль","email":"клиент@email.com","months":1}'
```

## Просмотр всех пользователей
```bash
curl https://твой-домен.railway.app/api/admin/users \
  -H "x-admin-key: пароль"
```
