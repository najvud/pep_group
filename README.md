# Telegram Pages Mirror

Статическое зеркало публичного Telegram-канала на `GitHub Pages`.

Сейчас репозиторий уже преднастроен под канал `@pgp_official`.

Проект делает три вещи:
- публикует сайт, который открывается в обычном браузере и ставится как иконка на телефон;
- каждые 15 минут подтягивает посты канала в JSON через `GitHub Actions`;
- подтягивает комментарии через пользовательскую Telegram session, если заданы secrets.

## Что внутри

```text
telegram-pages-mirror/
├── config/channel.json          # Настройка канала и брендинга
├── docs/                        # Статика для GitHub Pages
│   ├── data/posts.json
│   ├── data/comments/*.json
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── manifest.webmanifest
├── scripts/sync_channel.py      # Сбор постов и комментариев
├── scripts/generate_session.py  # Локальная генерация user session
└── .github/workflows/           # Автоматический sync и session helper workflows
```

## Как это работает

1. `GitHub Pages` отдает статический фронт из папки `docs/`.
2. Workflow `Sync Telegram Mirror` запускается каждые 15 минут.
3. Скрипт `scripts/sync_channel.py`:
   - читает публичную страницу `https://t.me/s/<channel>`;
   - сохраняет посты в `docs/data/posts.json`;
   - обновляет `docs/data/comments/<post_id>.json`, если настроены Telegram secrets.
4. Фронт читает готовые JSON-файлы и рисует ленту без сервера.

## Быстрый старт

### 1. Создайте репозиторий и загрузите проект

Залейте содержимое этой папки в новый GitHub repo.

### 2. Настройте канал

Если вы оставляете проект для `@pgp_official`, этот шаг можно пропустить.

Если захотите переключить проект на другой канал, откройте `config/channel.json` и замените значения:

- `channel_username`
- `channel_title`
- `site_name`
- `site_description`

Опционально:

- `messages_limit`
- `comments_posts_limit`
- `comments_max_age_days`
- `accent_color`
- `background_color`

### 3. Включите GitHub Pages

В репозитории:

1. `Settings -> Pages`
2. `Build and deployment -> Source -> Deploy from a branch`
3. Branch: `main`
4. Folder: `/docs`

После этого сайт будет доступен по адресу:

```text
https://<github-username>.github.io/<repo-name>/
```

### 4. Запустите первый sync вручную

Откройте `Actions -> Sync Telegram Mirror -> Run workflow`.

Если comments secrets еще не настроены, сайт все равно заработает, но только с лентой постов.

## Настройка комментариев

Для чтения комментариев нужен пользовательский Telegram session string, потому что comments threads доступны не через Bot API.

### Какие secrets нужны

Добавьте в `Settings -> Secrets and variables -> Actions`:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_SESSION_STR`

### Как получить API ID и API HASH

1. Перейдите на `https://my.telegram.org`
2. Откройте `API development tools`
3. Создайте приложение
4. Скопируйте `api_id` и `api_hash`

### Как получить TELEGRAM_SESSION_STR

Есть два пути.

#### Вариант A. Через локальный Python

```bash
pip install -r requirements.txt
python scripts/generate_session.py
```

Скрипт попросит номер телефона и код из Telegram, после чего выведет `TELEGRAM_SESSION_STR`.

#### Вариант B. Полностью через GitHub Actions

1. Откройте workflow `Generate Telegram Session Step 1`
2. Передайте `phone`, `api_id`, `api_hash`
3. Заберите из логов:
   - `partial_session`
   - `phone_code_hash`
4. Откройте workflow `Generate Telegram Session Step 2`
5. Передайте:
   - `partial_session`
   - `phone_code_hash`
   - код из Telegram
   - `phone`, `api_id`, `api_hash`
   - `password`, если включен 2FA
6. Заберите из логов итоговый `TELEGRAM_SESSION_STR`
7. Сохраните его в repository secret

## Ограничения

- Канал должен быть публичным.
- Это read-only зеркало. Писать комментарии или посты из сайта нельзя.
- `GitHub Actions schedule` может иногда задерживаться. Формально cron стоит на каждые 15 минут, но GitHub не гарантирует идеальную точность.
- Комментарии доступны только если Telegram account из `TELEGRAM_SESSION_STR` имеет доступ к связанному discussion thread.
- Медиа в комментариях сейчас сохраняются как текстовые placeholders, если комментарий без текста.

## Что уже заложено для развития

- фронт без фреймворка, чтобы быстро править UI;
- скользящее обновление комментариев по последним постам и по окну свежести;
- стабильные JSON-файлы: если контент не изменился, пустого коммита не будет.

## Ближайшие улучшения

- локальное зеркалирование фото и видео в repo или release assets;
- поиск по постам;
- фильтрация по дате;
- richer rendering для media-only comments;
- отдельная страница поста.
