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
- [Файлы и скриншоты от агента](#файлы-и-скриншоты-от-агента)
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
- Передача файлов/скриншотов **из агента в Telegram** через outbox-папку рядом с ботом ([подробнее](#файлы-и-скриншоты-от-агента)).
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

### Двойной клик (Windows)

В корне репо лежит `start-bot.cmd` — его можно запустить **двойным кликом** в проводнике. Скрипт:

1. Убивает предыдущий процесс бота (если был запущен — например, из другого окна или `tsx watch` оставил «зомби»).
2. Ждёт 2 секунды для корректного освобождения long-poll.
3. Запускает `npm run serve` в открывшемся cmd-окне с логами (полный production-цикл: `tsc` build → `node dist/index.js`).

После закрытия (Ctrl+C) окно остаётся открытым с `pause`, чтобы можно было прочитать последние логи.

Если правите код — нужно перезапустить (двойной клик заново). Если хотите hot-reload во время разработки — используйте `npm run dev` из консоли.

Для kill-логики используется `scripts/kill-bot.ps1` — отдельный PowerShell-скрипт, который ищет node-процессы с командной строкой содержащей `cursor-tg-bot`, `tsx ... src/index.ts` или `dist/index.js` и `Stop-Process -Force` их.

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

## Файлы и скриншоты от агента

Cursor-агент умеет присылать вам в Telegram **скриншоты, картинки и любые файлы** через папку-«outbox».

### Как это работает

1. Outbox-папки лежат **рядом с ботом**, не в проектах: `<botCwd>/data/outbox/<projectId>/`.
   Это значит, что чужие проекты **не пачкаются** служебными артефактами и не нужно ничего добавлять в их `.gitignore`.
2. **При каждом старте бота** вся папка `data/outbox/` полностью удаляется и создаётся заново. Никаких залежей старых файлов от прошлых сессий.
3. Пока активен run, бот «следит» за outbox-папкой проекта.
4. Любой новый файл, который агент сохранит туда по абсолютному пути, **автоматически уходит в Telegram-чат**, в котором запущен этот run, и **удаляется** из outbox.
5. По расширению бот сам выбирает способ отправки:
   - `.png/.jpg/.jpeg/.webp/.gif/.bmp` (≤ 10 MB) → как **фото** (`sendPhoto`).
   - всё остальное (≤ 50 MB) → как **документ** (`sendDocument`).
6. Опционально рядом с файлом можно положить `<имя>.<ext>.caption.txt` — содержимое станет подписью в Telegram (до 1024 символов).

### Как этим пользоваться

Просто попросите агента в чате:

> «Сделай скриншот текущей страницы и пришли мне в телеграм»
>
> «Скачай вот эту картинку и пришли сюда: https://...»
>
> «Сгенерируй PNG с диаграммой компонентов и отправь в чат»

Бот **автоматически** добавляет в первое сообщение каждого нового SDK-чата короткую инструкцию с **абсолютным путём** к outbox-папке этого проекта, поэтому агент знает, куда сохранять файлы (он сам в чужом cwd, и без подсказки путь к `data/outbox/...` бота не угадает).

### Хорошие сочетания

- **`chrome-devtools-mcp`** — `take_screenshot` сохраняет PNG в файл, агенту достаточно положить его в outbox.
- **`Write`-инструмент** — агент сам пишет произвольный бинарный/текстовый файл прямо в outbox.
- **`shell`-команда** — `curl -o <outboxDir>/file.png ...`, `playwright screenshot ...`, `imagemagick`, и т.д.

### Ограничения

- **Файлы > 50 MB** Telegram Bot API отправить не может — бот просто покажет предупреждение и оставит файл в outbox-папке.
- Бот следит за папкой только пока активен run (между сообщениями watcher остановлен).
- Несколько одновременных run-ов в **одном** проекте делят одну outbox-папку — файл уйдёт в чат того run-а, который раньше успел его подхватить.
- Файл не отправляется, пока его mtime моложе 700 мс (защита от гонки, если агент ещё дописывает файл).
- При **рестарте бота** содержимое `data/outbox/` обнуляется. Если агент успел положить туда файл, но run прервался до отправки — файл потеряется.

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
│   ├── outbox.ts           # Watcher data/outbox/<projectId>/ → Telegram
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
- **Нет загрузки изображений из Telegram в агента** (направление user → agent). SDK поддерживает (`SDKUserMessage.images`), но в боте пока не реализовано. Обратное направление (agent → Telegram) есть — см. [Файлы и скриншоты от агента](#файлы-и-скриншоты-от-агента).
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

### `bot.start()` зависает на старте (Windows + корпоративная сеть)

Симптомы: в логе `starting cursor-tg-bot` и `sessions loaded`, но `telegram bot started` не появляется. Через `Invoke-WebRequest` Telegram API отвечает мгновенно, через Node — нет.

Причина: TLS-инспектор (Zscaler / Fortinet / Kaspersky / антивирус) подменяет сертификаты, Windows-store доверяет, а Node — нет (у него свой CA bundle). PowerShell использует Windows store, Node — нет.

Решение: бот автоматически подхватывает CAs из Windows store через [`win-ca`](https://www.npmjs.com/package/win-ca) с режимом `inject: "+"` (патчит `tls.createSecureContext`, поэтому работает и для `node:https`, и для native `fetch` / undici). Это происходит в самом начале `src/index.ts`. На macOS/Linux этот блок пропускается.

Если бот всё равно зависает на старте — проверьте, что у вас Windows-сертификаты обновлены (`certutil -urlfetch -verify`), или временно установите `NODE_TLS_REJECT_UNAUTHORIZED=0` в `.env` (НЕБЕЗОПАСНО, только для отладки).

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

### v0.4 — Удаление чатов ✅

- [x] Режим «🗑 Управление» в списке чатов: появляется корзинка только у SDK-чатов.
- [x] Подтверждение перед удалением (Да / Отмена).
- [x] Удаление SDK-агентов: запись из `sdk-agent-store/.../index.db` (агент + runs + run_events) + директория транскрипта + закрытие активных handles.
- [x] **IDE-чаты НЕ удаляются** — Cursor IDE использует их транскрипты для собственной работы; удаление может повредить установку IDE. Защита на двух уровнях: UI (кнопка просто не показывается) + код (`deleteTranscriptFolder` и `deleteSdkAgent` отказываются работать с папками без префикса `agent-`).
- [x] Очистка сессии, если активный чат был удалён.

### v0.5 — Recovery после рестарта ✅

- [x] При старте бот проходит по сохранённым `activeRunId` и через `Agent.getRun()` ждёт их завершения с timeout 5 минут — присылает итог в Telegram.
- [x] Авто-recovery залипшего persistent run при следующем `agent.send()` через флаг `local: { force: true }` (автоматический retry в `manager.sendMessage`).
- [x] Persistent-сессии в `data/sessions.json`.
- [x] Поддержка корпоративных TLS-инспекторов через `win-ca.inject('+')`.

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
