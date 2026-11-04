# Деплой TSN Academy на Vercel

## Що потрібно

1. GitHub-репозиторій з цим проєктом.
2. Зовнішня хмарна MySQL 8.0 база. Локальна MySQL з ПК для Vercel недоступна.
3. Обліковий запис Vercel.

## Змінні середовища у Vercel

Відкрийте **Project → Settings → Environment Variables** та додайте для Production і Preview:

```text
MYSQL_HOST=...
MYSQL_PORT=3306
MYSQL_DATABASE=tsn_academy
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_SSL=true
SESSION_SECRET=довгий-випадковий-рядок
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ADMIN_NAME=Адмін TSN
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=створіть-складний-пароль
```

Не додавайте `.env` до GitHub. Він вже в `.gitignore`.

## Деплой

1. Завантажте проєкт у GitHub.
2. На Vercel натисніть **Add New → Project** та імпортуйте репозиторій.
3. Vercel сам встановить залежності з `package.json`.
4. Додайте змінні середовища зі списку вище.
5. Натисніть **Deploy**.

Після першого запуску API сам створить таблиці `users` і `attempts` та створить адміністратора з `ADMIN_*`.
