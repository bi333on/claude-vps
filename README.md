# Telegram-бот на Claude

Бот принимает сообщения в Telegram и отвечает через Claude API. Помнит контекст диалога, работает по long polling (webhook и домен не нужны).

## Что понадобится

| Что | Где взять |
|---|---|
| Токен бота | [@BotFather](https://t.me/BotFather) → `/newbot` |
| Ключ Claude API | [platform.claude.com](https://platform.claude.com/) → API Keys |
| VPS | Ubuntu 22.04/24.04, 1 GB RAM достаточно |

**Никому не пересылайте эти два значения** — ни в чатах, ни в issue, ни в скриншотах. Они вписываются только в файл `.env` на сервере.

---

Напишите боту в Telegram — должен ответить.

---

## Установка на VPS

### 1. Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # должно быть v22.x
```

### 2. Отдельный пользователь и папка

Бот не должен работать от root — если что-то пойдёт не так, ущерб будет ограничен.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin claudebot
sudo mkdir -p /opt/tg-claude-bot
sudo chown claudebot:claudebot /opt/tg-claude-bot
```

### 3. Загрузить код

Через git, если проект в репозитории:

```bash
sudo -u claudebot git clone https://github.com/bi333on/claude-vps.git /opt/tg-claude-bot
```

### 4. Зависимости и конфиг

```bash
cd /opt/tg-claude-bot
sudo -u claudebot npm install --omit=dev

sudo -u claudebot cp .env.example .env
sudo -u claudebot nano .env          # вписать оба ключа
sudo chmod 600 .env                  # файл читает только владелец
```

### 5. Автозапуск через systemd

```bash
sudo cp /opt/tg-claude-bot/tg-claude-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-claude-bot
```

Проверка:

```bash
sudo systemctl status tg-claude-bot
sudo journalctl -u tg-claude-bot -f      # живой лог
```

В логе при успешном старте: `Бот @имя_бота запущен. Модель: claude-opus-5, effort: medium`

### 6. Обновление кода

```bash
cd /opt/tg-claude-bot
sudo -u claudebot git pull              # или залить файлы заново через scp
sudo -u claudebot npm install --omit=dev
sudo systemctl restart tg-claude-bot
```

---

## Настройки (`.env`)

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Обязательно |
| `ANTHROPIC_API_KEY` | — | Обязательно |
| `CLAUDE_MODEL` | `claude-opus-5` | `claude-sonnet-5` дешевле, `claude-haiku-4-5` ещё дешевле и быстрее |
| `CLAUDE_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max` — глубина рассуждений, влияет на цену и задержку |
| `MAX_TOKENS` | `4096` | Максимальная длина ответа |
| `HISTORY_LIMIT` | `30` | Сколько последних сообщений держать в контексте |
| `SYSTEM_PROMPT` | см. `.env.example` | Характер бота |
| `ALLOWED_USER_IDS` | пусто | Белый список ID через запятую. Пусто = отвечает всем |

После правки `.env`: `sudo systemctl restart tg-claude-bot`

**Ограничьте доступ, если бот не публичный.** Без `ALLOWED_USER_IDS` любой, кто найдёт бота, тратит ваш баланс Claude API. Свой ID узнаете командой `/id` в боте.

---

## Команды бота

- `/start`, `/help` — справка
- `/reset` — очистить историю диалога
- `/id` — показать свой Telegram ID (для белого списка)

---

## Что стоит знать

**История хранится в памяти.** После `systemctl restart` контекст диалогов теряется. Для сохранения между перезапусками нужна БД (SQLite/Redis) — сейчас этого нет намеренно, чтобы не тянуть зависимости.

**Только текст.** Картинки, голосовые и файлы бот не обрабатывает — Claude умеет читать изображения и PDF, но это отдельная доработка.

**Расход средств.** Каждое сообщение отправляет всю историю диалога заново, поэтому длинный диалог дороже короткого. `/reset` сбрасывает счёт. Цены: Opus 5 — $5 за миллион входных токенов и $25 за миллион выходных; Sonnet 5 — $3/$15; Haiku 4.5 — $1/$5.

**Один инстанс на токен.** Если запустить бота дважды с одним токеном, Telegram будет отдавать сообщения то одному, то другому. Локальный запуск на время отладки останавливайте на сервере: `sudo systemctl stop tg-claude-bot`.

---

## Диагностика

| Симптом | Причина |
|---|---|
| `Telegram deleteWebhook: Unauthorized` | Неверный `TELEGRAM_BOT_TOKEN` |
| `Проблема с ключом Claude API` в ответе бота | Неверный `ANTHROPIC_API_KEY` или нулевой баланс |
| Бот молчит | `sudo journalctl -u tg-claude-bot -n 50` — смотреть лог |
| `Слишком много запросов` | Лимит Claude API — снизьте нагрузку или повысьте tier |
| Ответы обрываются | Увеличьте `MAX_TOKENS` |
