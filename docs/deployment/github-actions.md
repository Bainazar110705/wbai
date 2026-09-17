# GitHub Actions: CI и production deploy

В репозитории настроены два workflow:

- `CI` запускается для каждого push и pull request в `main`. Он проверяет синтаксис JavaScript, inline-скрипты dashboard, whitespace и Docker-сборку.
- `Deploy production` запускается вручную из вкладки **Actions**. Такой подход не выкатывает изменения без явного решения и совместим с GitHub Environment approval.

## Подготовка production-сервера

На сервере должен быть уже развёрнут проект в отдельной директории, например `/opt/wbai`, с заполненным `.env`. Файл `.env` не хранится в Git и не меняется workflow.

На сервере должны быть установлены Docker Engine, Docker Compose plugin и Git. У пользователя деплоя должен быть доступ к Docker и к клонированному репозиторию.

## Secrets GitHub

Создайте Environment `production` в **Settings → Environments** и добавьте туда следующие secrets:

| Secret | Значение |
| --- | --- |
| `DEPLOY_HOST` | IP-адрес или домен сервера без `https://` |
| `DEPLOY_USER` | Linux-пользователь для деплоя |
| `DEPLOY_PATH` | Абсолютный путь к проекту, например `/opt/wbai` |
| `DEPLOY_SSH_KEY` | Приватный SSH-ключ этого пользователя |
| `DEPLOY_KNOWN_HOSTS` | Строка known_hosts для сервера |

Получите значение `DEPLOY_KNOWN_HOSTS` локально и внимательно сверяйте fingerprint с сервером:

```bash
ssh-keyscan -H your-server.example
```

Публичную часть ключа добавьте на сервере в `~/.ssh/authorized_keys` пользователя деплоя. Не добавляйте SSH-ключи, токены API или `.env` в репозиторий.

## Запуск деплоя

1. Откройте **Actions → Deploy production → Run workflow**.
2. При включённой защите Environment подтвердите production deployment.
3. Workflow выполнит `git pull --ff-only origin main`, затем пересоберёт и перезапустит только сервис `app`.

Если на сервере уже есть незакоммиченные изменения, `git pull --ff-only` остановит деплой вместо перезаписи файлов. Исправьте состояние сервера вручную и повторите запуск.
