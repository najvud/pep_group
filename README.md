# Telegram Pages Mirror

Статическое зеркало нескольких публичных Telegram-каналов на `GitHub Pages`.

Проект публикует один сайт с верхним горизонтальным меню, где каждая вкладка переключает ленту на отдельный канал. Данные обновляются через `GitHub Actions` каждые 15 минут, без собственного сервера.

Сейчас в конфиг уже включены каналы:

- `PG Antitrust | Антимонопольное право`
- `PG Tax | Налоги`
- `PG Real Estate | Недвижимость`
- `СпецИнвестРежимы`
- `PG Ecology | Экология`
- `Банкротство | Взгляд эксперта`
- `PG Employment | Трудовое право`

## Как устроено

```text
telegram-pages-mirror/
├── config/channels.json         # Список каналов и общий брендинг сайта
├── docs/                        # Статика для GitHub Pages
│   ├── data/channels/           # JSON по каждому каналу
│   ├── channels/<key>/posts/    # Отдельные страницы постов
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── manifest.webmanifest
├── scripts/build_site_index.mjs # Каталог каналов и стартовые заглушки
├── scripts/sync_channels.mjs    # Оркестрация sync по всем каналам
├── scripts/sync_channel.py      # Сбор одного канала: посты, медиа, комментарии
└── .github/workflows/sync.yml   # Периодический sync и commit обратно в repo
```

## Как это работает

1. `GitHub Pages` отдает сайт из папки `docs/`.
2. `scripts/build_site_index.mjs` создает каталог каналов и стартовые `posts.json`, чтобы фронт не падал до первого sync.
3. Workflow `Sync Telegram Mirror` каждые 15 минут запускает `scripts/sync_channels.mjs`.
4. `scripts/sync_channels.mjs` последовательно вызывает `scripts/sync_channel.py` для каждого канала из `config/channels.json`.
5. Каждый канал пишет данные в свой namespace:
   - `docs/data/channels/<key>/posts.json`
   - `docs/data/channels/<key>/pages/*.json`
   - `docs/data/channels/<key>/posts/*.json`
   - `docs/data/channels/<key>/comments/*.json`
   - `docs/channels/<key>/posts/<post_id>/index.html`

## Настройка каналов

Все каналы описываются в `config/channels.json`.

Для каждого канала можно задать:

- `key`
- `label`
- `channel_username`
- `channel_title`
- `site_description`
- `accent_color`
- `background_color`
- `avatar_path`
- `messages_limit`
- `recent_posts_months`
- `comments_posts_limit`
- `comments_max_age_days`

`default_channel_key` определяет, какая вкладка откроется первой.

## Публикация

1. Откройте `Settings -> Pages`.
2. Выберите `Deploy from a branch`.
3. Укажите ветку `main`.
4. Укажите папку `/docs`.

Сайт будет доступен по адресу:

```text
https://<github-username>.github.io/<repo-name>/
```

Формат прямой ссылки на конкретную вкладку:

```text
https://<github-username>.github.io/<repo-name>/?channel=<channel-key>
```

Например:

```text
https://najvud.github.io/pep_group/?channel=pg-tax
```

## Автообновление

Workflow `Sync Telegram Mirror` уже настроен на cron:

```text
*/15 * * * *
```

То есть сайт сам обновляет ленты примерно раз в 15 минут. Нужно учитывать, что `GitHub Actions schedule` не гарантирует идеальную точность и иногда может стартовать с задержкой.

## Комментарии

Посты и медиа можно зеркалить без Telegram secrets. Комментарии требуют пользовательскую Telegram session.

Добавьте в `Settings -> Secrets and variables -> Actions`:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_SESSION_STR`

Без этих secrets сайт продолжит работать, но только как зеркало постов.

## Ограничения

- Каналы должны быть публичными.
- Это read-only зеркало: писать посты и комментарии с сайта нельзя.
- Комментарии доступны только если у канала есть discussion thread и Telegram account из `TELEGRAM_SESSION_STR` имеет к нему доступ.
- Локально в этом проекте нет backend-сервера: весь runtime завязан на `GitHub Pages` и `GitHub Actions`.
