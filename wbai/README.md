# WBai — Установка сервера

## Требования
- Node.js 18+
- VPS сервер (Ubuntu 20.04+)

## Установка

```bash
# 1. Клонируем проект
git clone ... или загружаем файлы на сервер

# 2. Устанавливаем зависимости
npm install

# 3. Создаём .env файл
cp .env.example .env
nano .env  # заполняем переменные

# 4. Запускаем
npm start

# Или через PM2 (рекомендуется)
npm install -g pm2
pm2 start src/server.js --name wbai
pm2 save
pm2 startup
```

## Переменные окружения (.env)
```
PORT=3000
JWT_SECRET=ваш-секретный-ключ-минимум-32-символа
ADMIN_KEY=ваш-admin-пароль
CLAUDE_API_KEY=sk-ant-api03-...
```

## Активация подписки (вручную)
После оплаты клиента активируйте через API:
```bash
curl -X POST https://ваш-домен/api/admin/activate \
  -H "Content-Type: application/json" \
  -d '{"adminKey":"ваш-admin-пароль","email":"клиент@email.com","months":1}'
```

## Просмотр пользователей
```bash
curl https://ваш-домен/api/admin/users \
  -H "x-admin-key: ваш-admin-пароль"
```

## Nginx конфиг
```nginx
server {
    listen 80;
    server_name wbai.kz;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }
}
```
