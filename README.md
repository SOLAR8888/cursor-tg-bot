# cursor-tg-bot

Telegram-бот для управления **локальными** Cursor-агентами в нескольких проектах из одного клиента (Telegram). Использует [`@cursor/sdk`](https://cursor.com/ru/docs/sdk/typescript) и работает с теми же агентами, что и Cursor IDE / Web.

> **Статус:** v0.1 — рабочий MVP. См. раздел [Roadmap](#roadmap).

## Содержание

- [Возможности](#возможности)
- [Как это устроено](#как-это-устроено)
- [Требования](#требования)
- [Установка](#установка)
- [Конфигурация](#конфигурация)
- [Запуск](#запуск)
- [UX / команды](#ux--команды)
- [Безопасность](#безопасность)
- [MCP-серверы](#mcp-серверы)
- [Архитектура](#архитектура)
- [Известные ограничения](#известные-ограничения)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

## Возможности

- Один Telegram-клиент для **множества проектов** в разных директориях.
- Меню с фиксированным списком проектов (через `projects.json`).
- Создание новых SDK-агентов в любом проекте, общение с ними прямо из Telegram.
- Возобновление существующих SDK-агентов и продолжение диалогов.
- Стриминг ответов агента в реальном времени (с debounced-редактированием сообщений).
- Видимость вызовов инструментов (read/edit/shell/grep/...) в виде компактных уведомлений.
- Просмотр MCP-серверов: глобальных (`~/.cursor/mcp.json`) и проектных (`<cwd>/.cursor/mcp.json`).
- Использование тех же MCP-серверов, что и Cursor IDE — никакого дублирования.
- Whitelist-авторизация по Telegram User ID. Все остальные **молча игнорируются**.
- Отмена выполняемого run, статус, graceful-shutdown.

## Как это устроено

Бот использует `@cursor/sdk` в режиме `runtime: "local"`. Это означает:

1. Бот должен быть запущен **на той же машине**, где находятся ваши проекты (для Windows: где работает Cursor IDE).
2. Один и тот же `CURSOR_API_KEY` оплачивает запросы — точно так же, как при работе из IDE.
3. Созданные через бота агенты **видны в Cursor IDE / Web** с фильтром `Filter > Source > SDK`. Можно начать чат в Telegram и продолжить в IDE (и наоборот, если возьмёте `agentId` из IDE).
4. Конфигурация (MCP, hooks, sub-agents) автоматически подхватывается из `~/.cursor/` и `<project>/.cursor/`, потому что бот вызывает SDK с `local.settingSources: ["user", "project"]`.

> **Важно:** SDK не предоставляет публичного API для чтения чатов, начатых **вручную в Cursor IDE** (через UI). Бот видит только тех агентов, которые он создал сам. Чтение чатов IDE напрямую через её SQLite-базу — запланировано на следующую итерацию (см. [Roadmap](#roadmap)).

## Требования

- **Node.js** ≥ 20 (рекомендуется 22+).
- **npm** ≥ 10 (или замените на pnpm/yarn — не зависит).
- **Cursor API key** — [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) → *Create new API key*.
- **Telegram Bot Token** — у [@BotFather](https://t.me/BotFather) команда `/newbot`.
- **Свой Telegram User ID** — у [@userinfobot](https://t.me/userinfobot).
- **Доступ к проектам по абсолютным путям** — бот будет вызывать SDK с этими `cwd`.

## Установка

```bash
git clone <this-repo>
cd cursor-tg-bot
npm install
```

## Конфигурация

### 1. Переменные окружения

Скопируйте `.env.example` в `.env` и заполните:

```bash
cp .env.example .env
```

| Переменная | Обязательно | Описание |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | да | Токен от @BotFather |
| `ALLOWED_USER_IDS` | да | CSV с Telegram User ID, например `123456789,987654321` |
| `CURSOR_API_KEY` | да | API-ключ Cursor |
| `DEFAULT_MODEL_ID` | нет | По умолчанию `claude-opus-4-7` (Opus 4.7) |
| `DEFAULT_MODEL_PARAMS` | нет | По умолчанию `thinking=max` (Max Mode). Формат: `key=value,key=value` |
| `SHOW_THINKING` | нет | `true` — стримить «размышления» в Telegram. По умолчанию `false` |
| `STREAM_EDIT_DEBOUNCE_MS` | нет | Дебаунс редактирования стриминговых сообщений. По умолчанию `900` |
| `LOG_LEVEL` | нет | `debug` / `info` / `warn` / `error`. По умолчанию `info` |
| `LOG_MESSAGES` | нет | `true` — писать содержимое сообщений в лог (для дебага). По умолчанию `false` |

> Точный `DEFAULT_MODEL_ID` зависит от вашего Cursor-аккаунта. Проверьте список:
>
> ```bash
> node --input-type=module -e "import('@cursor/sdk').then(s=>s.Cursor.models.list({apiKey:process.env.CURSOR_API_KEY}).then(m=>console.log(m.map(x=>x.id))))"
> ```

### 2. Список проектов

Скопируйте `projects.json.example` в `projects.json` и отредактируйте:

```json
{
  "projects": [
    {
      "id": "myapp",
      "name": "My App",
      "cwd": "C:\\Users\\me\\work\\myapp",
      "description": "Production app"
    }
  ]
}
```

| Поле | Обязательно | Описание |
| --- | --- | --- |
| `id` | да | Стабильный ID, попадает в callback_data Telegram. Только `[A-Za-z0-9_-]` |
| `name` | да | Отображаемое имя в меню |
| `cwd` | да | **Абсолютный** путь к корню проекта. На Windows экранируйте `\\` |
| `description` | нет | Текстовое описание, показывается на странице проекта |

Файл `projects.json` **не коммитится** в git (он в `.gitignore`) — в нём могут быть локальные пути.

## Запуск

### Dev (с hot-reload)

```bash
npm run dev
```

### Prod

```bash
npm run build
npm start
```

### Сервис

#### Windows (NSSM или Task Scheduler)

```powershell
nssm install cursor-tg-bot "C:\Program Files\nodejs\node.exe" "C:\path\to\cursor-tg-bot\dist\index.js"
nssm set cursor-tg-bot AppDirectory "C:\path\to\cursor-tg-bot"
nssm start cursor-tg-bot
```

#### Linux/macOS (systemd / pm2)

```bash
pm2 start dist/index.js --name cursor-tg-bot
pm2 save
```

Бот использует **long-polling**, никаких портов открывать не нужно.

## UX / команды

После `/start` появится меню:

```
Главное меню
├── 📁 Проекты ▶
│   └── <Проект>
│       ├── 💬 Чаты ▶
│       │   ├── <живые SDK-агенты этого проекта>
│       │   └── ➕ Новый чат
│       ├── 🔌 MCP проекта
│       └── ⬅️ К проектам
├── 🔌 MCP (глобальные)
└── ℹ️ Помощь
```

После выбора чата (или создания нового) **любое текстовое сообщение** уходит агенту через `agent.send()`. Стрим ответа приходит в Telegram: ассистентский текст редактируется на месте, вызовы инструментов появляются отдельными сообщениями.

| Команда | Что делает |
| --- | --- |
| `/start` | Сбросить сессию, главное меню |
| `/projects` | Меню проектов |
| `/chats` | Чаты текущего проекта |
| `/new` | Подсказка «отправьте первое сообщение нового чата» |
| `/cancel` | Отменить активный run |
| `/status` | Текущая модель, проект, агент, статус run |
| `/mcp` | Список MCP-серверов (текущего проекта или глобальных) |
| `/help` | Справка |

## Безопасность

В этой версии используется **минимальный** уровень — whitelist по Telegram User ID. Это достаточно для одного пользователя на личной машине. Если планируете давать доступ другим — см. [Roadmap](#roadmap), там запланированы pairing-токены и аудит-лог.

### Что обеспечивает текущая реализация

1. **Whitelist первым в цепочке middleware**. Любой update от пользователя без ID в `ALLOWED_USER_IDS` молча отбрасывается (`return` без ответа). Бот не отвечает, не показывает существование, только пишет `warn` в лог. Это лучше, чем «доступ запрещён», потому что не палит факт работающего бота.
2. **Никаких вебхуков** — long-polling, наружу порты не открыты.
3. **Логи редактируются**: `TELEGRAM_BOT_TOKEN`, `CURSOR_API_KEY`, `Authorization` headers замаскированы (см. `src/logger.ts`).
4. **`.env`, `projects.json`, `data/`** — в `.gitignore`. Токены и пути не утекают в git.
5. **Содержимое сообщений** не пишется в лог по умолчанию — только метаданные (user_id, project_id, agent_id). Для дебага есть `LOG_MESSAGES=true`.

### Дополнительные шаги, рекомендуемые вручную

1. **Сделайте бота приватным** в @BotFather:
   - `/setjoingroups` → `Disable`
   - `/setprivacy` → `Enable` (бот не видит сообщения в группах)
2. **Не используйте этого бота в групповых чатах**. Бот разработан под личный диалог.
3. **`CURSOR_API_KEY` имеет полный доступ** к вашему Cursor-аккаунту (run, биллинг). Берегите `.env`.
4. Если выложите `dist/` куда-то на сервер — убедитесь, что `.env` тоже защищён (например, права 600 на Linux).
5. Если пользуетесь не одной машиной — рассмотрите поднятие на VPS, не на ноутбуке (но тогда нужны другие проекты на VPS — это уже другой сценарий).

## MCP-серверы

Бот **не дублирует** конфигурацию MCP — вместо этого SDK получает `local.settingSources: ["user", "project"]` при создании агента, и сам подхватывает:

- `~/.cursor/mcp.json` — глобальные MCP, общие для всех проектов.
- `<projectCwd>/.cursor/mcp.json` — проектные MCP.

Это **те же** конфигурации, которые использует Cursor IDE. Если вы редактируете MCP в IDE — бот сразу подхватывает изменения для **новых** агентов (для уже созданных — только после `agent.reload()` или нового чата).

Команда `/mcp` показывает merged-список:
- `[project]` — определён в проекте
- `[user]` — определён глобально
- При конфликтах имён приоритет за проектом.

## Архитектура

```
src/
├── index.ts                # Entrypoint: загрузка конфига, старт бота, graceful shutdown
├── config.ts               # Zod-схемы для .env и projects.json
├── logger.ts               # pino, с redaction
├── types.ts                # Доменные типы
│
├── bot/
│   ├── bot.ts              # grammy: создание Bot, регистрация middleware
│   ├── auth.ts             # Whitelist-middleware
│   ├── session.ts          # In-memory Map<userId, UserSession>
│   ├── keyboards.ts        # Inline-клавиатуры всех меню
│   └── handlers.ts         # Все handlers: команды, callbacks, message:text
│
├── agents/
│   ├── manager.ts          # AgentManager: create/resume/list/close + кэш
│   ├── streamer.ts         # run.stream() → Telegram (debounced edit, chunking)
│   └── formatter.ts        # SDKMessage → лаконичный текст для Telegram
│
├── cursor/
│   └── mcp-loader.ts       # Чтение ~/.cursor/mcp.json + <project>/.cursor/mcp.json
│
└── util/
    ├── chunk.ts            # Разбиение на 4096-байтные сообщения
    └── markdown.ts         # MarkdownV2 escape
```

### Поток выполнения

1. **Update от Telegram** → `whitelistMiddleware` (фильтрация по `ALLOWED_USER_IDS`).
2. → `handlers.ts`: команда / callback / текст.
3. Для текста:
   - `SessionStore` подсказывает `selectedProjectId` и `activeAgentId`.
   - Если агента нет — `AgentManager.createAgent(project)`.
   - Иначе — `AgentManager.resumeAgent(project, agentId)`.
   - `agent.send(text)` → `Run`.
4. **`streamRun(...)`** в фоне:
   - `for await (const event of run.stream())` — события `assistant`, `tool_call`, `status`, ...
   - Ассистентский текст накапливается в одном Telegram-сообщении и редактируется с debounce (`STREAM_EDIT_DEBOUNCE_MS`).
   - Tool-calls — отдельные сообщения, обновляются `running → completed/error`.
   - По завершении — `run.wait()` → итог + git-инфо.
5. **`/cancel`** или callback → `run.cancel()`.

### Сессия (in-memory)

```typescript
interface UserSession {
  userId: number;
  selectedProjectId?: string;
  activeAgentId?: string;
  activeRunId?: string;
  awaitingTextFor?: "new_chat";
}
```

При рестарте бота сессии теряются, **но агенты живут**. Заходим в проект → меню «Чаты» → выбираем нужного → `Agent.resume()` восстанавливает диалог.

## IDE-чаты в боте

С v0.2+ бот **видит** чаты, начатые в Cursor IDE — в режиме read-only. Они читаются напрямую из `.jsonl`-транскриптов (`~/.cursor/projects/<normalized-cwd>/agent-transcripts/<chatId>/<chatId>.jsonl`).

В списке `📋 Чаты` IDE-чаты помечены иконкой 👀 (SDK-чаты — 💬). При выборе IDE-чата:

- Видим имя (взято из первого сообщения пользователя), счётчики user/assistant сообщений, последний ответ ассистента.
- Кнопка **«🔄 Продолжить в боте»** — создаёт **новый** SDK-агент с историей IDE-чата как bootstrap-промптом, и ваш следующий текст идёт в этот SDK-агент. Это позволяет фактически продолжить тему из IDE в боте (с полным контекстом, но **другим agentId**; в IDE-чате сихронизации не будет).
- В транскрипте берутся последние **60 сообщений** (чтобы не упереться в context-window). Полная история — в IDE.

> Прямая запись в IDE-чат (через тот же `agentId`) **невозможна** — `Agent.resume()` SDK не находит IDE-чаты в своём сторе. Поэтому используется bootstrap-копия в новый SDK-агент.

## Известные ограничения

- **IDE-чаты read-only.** Писать в них напрямую через бот нельзя — только через «🔄 Продолжить в боте» (создаёт SDK-копию с историей).
- **SDK-агенты не видны в IDE-панели Agents** (по крайней мере в Cursor 1.x). Это поведение **самого Cursor IDE**, не бота: документация SDK прямо говорит «SDK-агенты исключаются из списка по умолчанию», для cloud есть `Filter > Source > SDK` в Web/IDE, для local-runtime в IDE 1.x этот фильтр отсутствует. Workaround:
  - Управление SDK-агентами — через **Telegram-бот** (основной интерфейс).
  - Просмотр **cloud** SDK-агентов — на https://cursor.com/agents с `Filter > Source > SDK`.
  - Диагностика всех local-агентов проекта — команда `npm run list-agents` (выводит из всех проектов в `projects.json`).
- **Shell-команды не блокируются для подтверждения.** В этой версии — observe-only: вы видите факт выполнения в Telegram, но не можете approve/deny. Если нужен блокирующий approval — см. [Roadmap](#roadmap).
- **Артефакты локальных агентов недоступны** (это ограничение SDK: `agent.listArtifacts()` для local возвращает `[]`).
- **Нет поддержки изображений** в исходящем направлении (Telegram → агент). Текст only. SDK позволяет, но в боте пока не реализовано.
- **Один пользователь = одна машина.** Если вам нужен multi-user или multi-host — нужна переработка.
- **Restart = потеря активных стримов.** Если бот рестартанёт во время run — стрим оборвётся. Сам run на стороне Cursor SDK продолжится, но без живой обратной связи в Telegram. После возврата к чату вы увидите уже завершённый результат через `Agent.list()` и сможете продолжить с `agent.send()`.

## Troubleshooting

### `TELEGRAM_BOT_TOKEN is required` / `CURSOR_API_KEY is required`

Не заполнен `.env`. Проверьте, что файл лежит в корне проекта рядом с `package.json`.

### `ALLOWED_USER_IDS must be set...`

Заполните CSV-список Telegram User ID. Узнать свой ID: [@userinfobot](https://t.me/userinfobot).

### Бот не отвечает на `/start`

1. Проверьте лог — там должен быть `rejected unauthorized update` с указанным `userId`. Если ваш ID не в `ALLOWED_USER_IDS` — добавьте.
2. Проверьте, что бот действительно запустился — в логе должно быть `telegram bot started`.
3. Проверьте, что @BotFather не отозвал токен.

### `Cursor SDK error (auth_failed)`

`CURSOR_API_KEY` истёк или невалиден. Создайте новый в [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations).

### `model not found` или `invalid model selection`

Ваш аккаунт не имеет доступа к модели из `DEFAULT_MODEL_ID`. Запустите проверку:

```bash
node --input-type=module -e "import('@cursor/sdk').then(s=>s.Cursor.models.list({apiKey:process.env.CURSOR_API_KEY}).then(m=>console.log(m)))"
```

И поставьте корректный `id` в `.env`.

### MCP-сервер не виден в `/mcp`

1. Проверьте `~/.cursor/mcp.json` (Windows: `C:\Users\<user>\.cursor\mcp.json`) — JSON должен быть валидным.
2. Для проектных MCP — должен быть `<projectCwd>/.cursor/mcp.json`.
3. Перезапустите бота (новые MCP подхватываются для новых агентов).

### `message is not modified`

Это лог-предупреждение из стримера, не ошибка. Возникает когда дебаунс-edit пытается записать тот же текст. Игнорируется автоматически.

### Создал чат через бот, но в Cursor IDE его не видно

Это ожидаемо: в Cursor IDE 1.x SDK-агенты с `runtime: local` не отображаются в панели Agents — её UI пока показывает только IDE-чаты. Подтвердить, что чат на самом деле создан, можно командой:

```bash
npm run list-agents
```

Она использует тот же `Agent.list({ runtime: "local", cwd })`, что и бот, и выводит всех агентов из всех проектов `projects.json`.

В самом боте чат виден через `📁 Проекты → <Project> → 💬 Чаты` (счётчик в заголовке отражает реальное количество).

### Telegram rate limit (`429 Too Many Requests`)

Увеличьте `STREAM_EDIT_DEBOUNCE_MS` в `.env` (например, до `1500`). По умолчанию `900` мс — комфортно для одного активного диалога.

## Roadmap

### v0.2 — Безопасность и UX

- [ ] Pairing-токен при первом `/start` (одноразовый секрет, выдаётся вручную в IDE → подтверждается в боте).
- [ ] Аудит-лог всех команд (отдельный файл / append-only).
- [ ] Команда `/lock` и автолок после N минут бездействия.
- [ ] Persistent-сессии в SQLite (восстановление состояния после рестарта).
- [ ] `/models` — список доступных моделей и переключение между ними.

### v0.3 — IDE-чаты в боте ✅

- [x] Чтение `.jsonl`-транскриптов из `~/.cursor/projects/<normalized-cwd>/agent-transcripts/`.
- [x] Список IDE-чатов в `📋 Чаты` рядом с SDK-чатами.
- [x] Просмотр последнего ответа агента в IDE-чате.
- [x] «🔄 Продолжить в боте» — bootstrap нового SDK-агента с историей IDE-чата.

### v0.4 — Блокирующий shell-approval

- [ ] Авто-генерация `<project>/.cursor/hooks.json` с `beforeShellExecution`-хуком.
- [ ] Хук вызывает скрипт-мост, который ждёт ответа бота через файловый IPC.
- [ ] Inline-кнопки `✅ Approve` / `❌ Deny` в Telegram.

### v0.5 — Изображения и артефакты

- [ ] Загрузка фото из Telegram → `agent.send({ text, images })`.
- [ ] Скачивание артефактов (для cloud-агентов, когда добавим поддержку).

### v1.0 — Cloud-режим

- [ ] Опциональный `cloud` runtime для тяжёлых задач, не зависящий от наличия машины.
- [ ] `autoCreatePR` интеграция с GitHub.

## Лицензия

ISC (см. `LICENSE` если будет добавлен).
