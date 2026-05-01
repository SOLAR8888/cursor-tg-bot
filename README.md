# cursor-tg-bot

> Telegram bot for managing **local** [Cursor](https://cursor.com) agents across multiple projects from a single chat client.

[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)
[![Cursor SDK](https://img.shields.io/badge/Cursor%20SDK-typescript-black)](https://cursor.com/docs/sdk/typescript)

`cursor-tg-bot` runs [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) in `runtime: "local"` mode and exposes a Telegram interface to the same agents you'd use inside Cursor IDE / Web. Manage chats in any of your projects from your phone, while heavy work runs on your dev machine.

> **Status:** v0.1 — working MVP. See [Roadmap](#roadmap).

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the bot](#running-the-bot)
- [Usage](#usage)
- [Sending files & screenshots](#sending-files--screenshots)
- [MCP servers](#mcp-servers)
- [IDE chats inside the bot](#ide-chats-inside-the-bot)
- [Security](#security)
- [Architecture](#architecture)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- One Telegram client for **multiple projects** in different directories.
- Menu with a fixed list of projects (driven by `projects.json`).
- Create new SDK agents in any project and chat with them from Telegram.
- Resume existing SDK agents and continue past conversations.
- **Real-time streaming** of agent responses (debounced message edits).
- Visibility into tool calls (`read`/`edit`/`shell`/`grep`/...) as compact notifications.
- File and screenshot delivery **from the agent into Telegram** via a per-project outbox folder ([details](#sending-files--screenshots)).
- Two-way attachments: send photos, documents and voice messages **into the agent**.
- Inspect MCP servers: global (`~/.cursor/mcp.json`) and project (`<cwd>/.cursor/mcp.json`).
- Reuses the **same** MCP servers as Cursor IDE — no duplication.
- Whitelist authorisation by Telegram User ID. Everyone else is **silently ignored**.
- Cancel running runs, view status, graceful shutdown.

## How it works

The bot uses `@cursor/sdk` in `runtime: "local"` mode. That means:

1. The bot runs **on the same machine** that hosts your projects (on Windows: where your Cursor IDE lives).
2. The same `CURSOR_API_KEY` pays for the requests — exactly like running them from the IDE.
3. Agents created via the bot are **visible in Cursor IDE / Web** under `Filter > Source > SDK`. You can start a chat in Telegram and continue it in the IDE (and vice versa, if you grab the `agentId` from the IDE).
4. Configuration (MCP, hooks, sub-agents) is automatically inherited from `~/.cursor/` and `<project>/.cursor/`, because the SDK is invoked with `local.settingSources: ["user", "project"]`.

> **Note:** the SDK does not expose a public API for chats started **manually inside Cursor IDE** (through the UI). The bot only sees agents it created itself — except for read-only access to IDE transcripts, see [IDE chats inside the bot](#ide-chats-inside-the-bot).

## Requirements

- **Node.js** ≥ 20 (22+ recommended).
- **npm** ≥ 10 (or pnpm/yarn — no lock-in).
- **Cursor API key** — get one at [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) → *Create new API key*.
- **Telegram Bot Token** — talk to [@BotFather](https://t.me/BotFather), command `/newbot`.
- **Your Telegram User ID** — get it from [@userinfobot](https://t.me/userinfobot).
- **Absolute paths to your projects** — the bot invokes the SDK with each project's `cwd`.

## Installation

```bash
git clone https://github.com/SOLAR8888/cursor-tg-bot.git
cd cursor-tg-bot
npm install
```

## Configuration

### 1. Environment variables

Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Token from @BotFather |
| `ALLOWED_USER_IDS` | yes | CSV of allowed Telegram user IDs, e.g. `123456789,987654321` |
| `CURSOR_API_KEY` | yes | Cursor API key |
| `DEFAULT_MODEL_ID` | no | Defaults to `claude-opus-4-7` (Opus 4.7) |
| `DEFAULT_MODEL_PARAMS` | no | Defaults to `thinking=max` (Max Mode). Format: `key=value,key=value` |
| `SHOW_THINKING` | no | `true` to stream "thinking" blocks to Telegram. Default `false` |
| `STREAM_EDIT_DEBOUNCE_MS` | no | Debounce for editing streaming messages. Default `900` |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`. Default `info` |
| `LOG_MESSAGES` | no | `true` to log message contents (debug only). Default `false` |

> The exact `DEFAULT_MODEL_ID` depends on your Cursor account. List the available models with:
>
> ```bash
> node --input-type=module -e "import('@cursor/sdk').then(s=>s.Cursor.models.list({apiKey:process.env.CURSOR_API_KEY}).then(m=>console.log(m.map(x=>x.id))))"
> ```

### 2. Project list

Copy `projects.json.example` to `projects.json` and edit it:

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

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Stable identifier used in Telegram callback_data. Only `[A-Za-z0-9_-]` |
| `name` | yes | Display name shown in the menu |
| `cwd` | yes | **Absolute** path to the project root. On Windows escape `\\` |
| `description` | no | Free-form text shown on the project page |

`projects.json` is **not committed** to git (it's in `.gitignore`) — it can contain local paths.

## Running the bot

### Double-click launcher (Windows)

The repo ships with `start-bot.cmd` — you can launch it by **double-clicking** in Explorer. The script:

1. Kills any previous bot instance (e.g. a leftover `tsx watch` zombie or another window).
2. Waits 2 seconds for the long-poll connection to release.
3. Runs `npm run serve` in a new console (full production cycle: `tsc` build → `node dist/index.js`).

After Ctrl+C the window stays open with `pause`, so you can read the last logs before it closes.

If you change code, restart with another double-click. For hot-reload during development, use `npm run dev` from a terminal instead.

The kill logic lives in `scripts/kill-bot.ps1` — a small PowerShell script that finds Node processes whose command line contains `cursor-tg-bot`, `tsx ... src/index.ts` or `dist/index.js` and runs `Stop-Process -Force` on them.

### Dev (hot-reload)

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Run as a service

#### Windows (NSSM or Task Scheduler)

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

The bot uses **long-polling** — no inbound ports need to be opened.

## Restarting the bot

Sometimes the bot starts answering every request with `ERROR` — usually because the SDK or its connection to Cursor's backend has gotten stuck. The fastest fix is a full process restart, which the `/restart` command automates from inside Telegram:

1. The bot replies with `🔄 Restarting bot…` and saves who asked + which message to update into `data/restart-pending.json`.
2. It runs the same shutdown path as `SIGINT` (stop polling → flush sessions → dispose all SDK agents) and exits with code `0`.
3. Your supervisor respawns the process.
4. On startup the bot sees the marker file, deletes it, and edits the original message in place to `✅ Bot restarted (Ns)`.

**You need an auto-restart supervisor for this to work** — `/restart` only stops the process; something else has to bring it back up:

| Mode | What you need |
| --- | --- |
| `npm run dev` | Already covered — `tsx watch` respawns automatically. |
| `start-bot.cmd` | The shipped launcher does **not** auto-restart on `/restart` (it just runs `npm run serve` once). Use `pm2` / `nssm` / a wrapping `while` loop instead, or just relaunch manually. |
| `npm start` | Wrap with `pm2`, `nssm`, `systemd`, `docker run --restart=always`, etc. |
| `pm2`        | Default `pm2 start dist/index.js --name cursor-tg-bot` already restarts on exit. |
| `systemd`    | Set `Restart=always` and `RestartSec=2` in the unit file. |
| `docker`     | Run with `--restart=always` (or `unless-stopped`). |

If no supervisor is configured and you send `/restart`, the bot will simply stop. The marker file in `data/restart-pending.json` will be picked up the next time you start it manually, so you'll still get the `✅ Bot restarted` notification.

## Usage

After `/start` you'll see the main menu:

```
Main menu
├── 📁 Projects ▶
│   └── <Project>
│       ├── 💬 Chats ▶
│       │   ├── <live SDK agents in this project>
│       │   └── ➕ New chat
│       ├── 🔌 Project MCP
│       └── ⬅️ Projects
├── 🔌 MCP (global)
└── ℹ️ Help
```

Once you pick (or create) a chat, **any text message** is sent to the agent via `agent.send()`. The streaming response arrives in Telegram: assistant text is edited in place, tool calls show up as separate messages.

### Commands

| Command | Description |
| --- | --- |
| `/start` | Reset the session, open the main menu |
| `/projects` | Project menu |
| `/chats` | Chats in the current project |
| `/new` | Hint "send the first message of a new chat" |
| `/cancel` | Cancel the active run |
| `/status` | Current model, project, agent, run status |
| `/mcp` | List MCP servers (current project or global) |
| `/restart` | Restart the bot process — recovers from stuck SDK / network state. **Requires an external supervisor** to actually respawn the process (see [Restarting the bot](#restarting-the-bot)). |
| `/help` | Help |

### Attachments

The bot accepts photos, documents, voice/audio and (when the file is small enough) inlines them into the prompt. Larger files are saved to a per-project inbox folder and the agent receives the absolute path.

## Sending files & screenshots

Cursor agents can send you **screenshots, images and arbitrary files** in Telegram via an "outbox" folder.

### How it works

1. Outbox folders live **next to the bot**, not inside your projects: `<botCwd>/data/outbox/<projectId>/`. This way other projects stay clean — no need to add anything to their `.gitignore`.
2. **On every bot start** the entire `data/outbox/` is wiped and recreated. No stale leftovers from previous sessions.
3. While a run is active, the bot watches the project's outbox folder.
4. Any new file the agent saves there (using the absolute path) is **automatically forwarded to the Telegram chat** that owns the run, then **deleted** from the outbox.
5. The bot picks the delivery method by extension:
   - `.png/.jpg/.jpeg/.webp/.gif/.bmp` (≤ 10 MB) → as **photo** (`sendPhoto`).
   - everything else (≤ 50 MB) → as **document** (`sendDocument`).
6. Optionally, place a `<name>.<ext>.caption.txt` next to the file — its content becomes the Telegram caption (up to 1024 chars).

### How to use it

Just ask the agent in chat:

> "Take a screenshot of the current page and send it to me on Telegram"
>
> "Download this image and send it here: https://..."
>
> "Generate a PNG diagram of components and send it to the chat"

The bot **automatically** prepends a short instruction with the **absolute path** to the project's outbox folder to the very first message of every new SDK chat, so the agent knows where to save files (it's working in someone else's `cwd` and can't guess the bot's `data/outbox/...` path on its own).

### Good combinations

- **`chrome-devtools-mcp`** — `take_screenshot` saves a PNG to file, the agent just drops it in the outbox.
- **`Write` tool** — the agent writes any binary/text file straight into the outbox.
- **`shell` command** — `curl -o <outboxDir>/file.png ...`, `playwright screenshot ...`, ImageMagick, etc.

### Limits

- **Files > 50 MB** can't be sent via Telegram Bot API — the bot warns and leaves the file in the outbox.
- The watcher is only active during a run (idle between messages).
- Multiple concurrent runs in the **same** project share an outbox folder — the file goes to whichever run's chat picks it up first.
- A file isn't sent until its mtime is older than 700 ms (race protection while the agent is still writing).
- **Restarting the bot** wipes `data/outbox/`. Files left there from an interrupted run are lost.

## MCP servers

The bot **does not duplicate** MCP configuration. Instead, the SDK is invoked with `local.settingSources: ["user", "project"]` when an agent is created, which makes it pick up:

- `~/.cursor/mcp.json` — global MCP servers, shared across all projects.
- `<projectCwd>/.cursor/mcp.json` — project MCP servers.

These are the **same** configurations used by Cursor IDE. Edit MCP in the IDE and the bot will pick up the changes for **new** agents (existing ones need `agent.reload()` or a new chat).

The `/mcp` command shows a merged list:
- `[project]` — defined in the project
- `[user]` — defined globally
- On name conflicts, the project entry wins.

## IDE chats inside the bot

Since v0.2, the bot can **see** chats started in Cursor IDE — read-only. They're loaded directly from `.jsonl` transcripts (`~/.cursor/projects/<normalized-cwd>/agent-transcripts/<chatId>/<chatId>.jsonl`).

In the `📋 Chats` list, IDE chats are marked with the 👀 icon (SDK chats with 💬). When you open an IDE chat:

- You see the name (taken from the first user message), `user`/`assistant` message counters and the last assistant reply.
- The **"🔄 Continue in bot"** button creates a **new** SDK agent with the IDE chat history as a bootstrap prompt, and your next text message goes into this new SDK agent. This effectively continues the IDE topic in the bot (with full context but a **different `agentId`**; the IDE chat itself won't be synced).
- Up to the **last 60 messages** of the transcript are imported (so we don't blow out the context window). Full history stays in the IDE.

> Direct writes to an IDE chat (using the same `agentId`) **aren't possible** — `Agent.resume()` from the SDK doesn't find IDE chats in its store. That's why we bootstrap a copy into a new SDK agent.

## Security

This version uses the **minimum** sensible level of access control: a Telegram User ID whitelist. That's enough for one user on a personal machine. If you plan to share access — see [Roadmap](#roadmap), where pairing tokens and an audit log are planned.

### What's already in place

1. **Whitelist as the first middleware**. Any update from a user not in `ALLOWED_USER_IDS` is silently dropped (`return` without reply). The bot doesn't answer, doesn't acknowledge its existence, only writes a `warn` to the log. That's safer than "access denied" because it doesn't reveal there's a working bot at this token.
2. **No webhooks** — long-polling, no inbound ports.
3. **Logs are redacted**: `TELEGRAM_BOT_TOKEN`, `CURSOR_API_KEY`, `Authorization` headers are masked (see `src/logger.ts`).
4. **`.env`, `projects.json`, `data/`** are in `.gitignore`. Tokens and paths don't leak into git.
5. **Message contents** are not logged by default — only metadata (`user_id`, `project_id`, `agent_id`). Set `LOG_MESSAGES=true` for debug.

### Recommended manual steps

1. **Make the bot private** in @BotFather:
   - `/setjoingroups` → `Disable`
   - `/setprivacy` → `Enable` (the bot can't see group messages)
2. **Don't use this bot in group chats**. It's designed for one-on-one DMs.
3. **`CURSOR_API_KEY` has full access** to your Cursor account (runs, billing). Guard your `.env`.
4. If you deploy `dist/` to a server — make sure `.env` is protected too (e.g. mode 600 on Linux).
5. If you use more than one machine, consider running the bot on a VPS, not your laptop (but then you need other projects on that VPS too — different scenario).

## Architecture

```
src/
├── index.ts                # Entrypoint: load config, start bot, graceful shutdown
├── config.ts               # Zod schemas for .env and projects.json
├── logger.ts               # pino + redaction
├── types.ts                # Domain types
│
├── bot/
│   ├── bot.ts              # grammy: create Bot, register middleware
│   ├── auth.ts             # Whitelist middleware
│   ├── session.ts          # In-memory Map<userId, UserSession>
│   ├── keyboards.ts        # Inline keyboards for every menu
│   ├── inbox.ts            # User attachments → agent (photos/files)
│   ├── outbox.ts           # Watcher data/outbox/<projectId>/ → Telegram
│   ├── restart.ts          # /restart: persist marker → graceful exit → notify on next boot
│   └── handlers.ts         # All handlers: commands, callbacks, message:text
│
├── agents/
│   ├── manager.ts          # AgentManager: create/resume/list/close + cache
│   ├── streamer.ts         # run.stream() → Telegram (debounced edits, chunking)
│   ├── formatter.ts        # SDKMessage → concise text for Telegram
│   └── recovery.ts         # Resume active runs after a bot restart
│
├── cursor/
│   ├── mcp-loader.ts       # Reads ~/.cursor/mcp.json + <project>/.cursor/mcp.json
│   ├── ide-store.ts        # Read & manage Cursor IDE transcripts
│   └── sdk-store.ts        # Read & manage SDK agent SQLite store
│
└── util/
    ├── chunk.ts            # Split into 4096-byte messages
    └── markdown.ts         # MarkdownV2 escape
```

### Execution flow

1. **Telegram update** → `whitelistMiddleware` (filter by `ALLOWED_USER_IDS`).
2. → `handlers.ts`: command / callback / text.
3. For text messages:
   - `SessionStore` provides the `selectedProjectId` and `activeAgentId`.
   - If no agent — `AgentManager.createAgent(project)`.
   - Otherwise — `AgentManager.resumeAgent(project, agentId)`.
   - `agent.send(text)` → `Run`.
4. **`streamRun(...)`** in the background:
   - `for await (const event of run.stream())` — events `assistant`, `tool_call`, `status`, ...
   - Assistant text is accumulated in a single Telegram message and edited with debounce (`STREAM_EDIT_DEBOUNCE_MS`).
   - Tool calls are separate messages, updated `running → completed/error`.
   - On finish — `run.wait()` → result + git info.
5. **`/cancel`** or callback → `run.cancel()`.

### Session shape (in-memory + persisted)

```typescript
interface UserSession {
  userId: number;
  selectedProjectId?: string;
  activeAgentId?: string;
  activeChatKind?: "sdk" | "ide";
  activeRunId?: string;
  awaitingText?: AwaitingText;
}
```

Sessions are persisted to `data/sessions.json` (debounced writes). After a restart they're reloaded; agents created earlier remain accessible — open the project → "Chats" → select the one you want, and `Agent.resume()` restores the conversation.

## Known limitations

- **IDE chats are read-only.** You can't write to them directly through the bot — only via "🔄 Continue in bot" (which creates an SDK copy with the history).
- **SDK agents are not visible in the IDE Agents panel** (at least in Cursor 1.x). This is **Cursor IDE behaviour**, not the bot's: the SDK docs explicitly say "SDK agents are excluded from the list by default", and although there's a `Filter > Source > SDK` option for cloud agents in Web/IDE, the local-runtime filter is missing in IDE 1.x. Workarounds:
  - Manage SDK agents via the **Telegram bot** (the primary interface).
  - View **cloud** SDK agents on https://cursor.com/agents with `Filter > Source > SDK`.
  - Diagnose all local agents in a project with `npm run list-agents` (lists agents from every project in `projects.json`).
- **Shell commands aren't gated for approval.** Today it's observe-only: you see the execution in Telegram but can't approve/deny. Blocking approvals are planned (see [Roadmap](#roadmap)).
- **Local agent artifacts are unavailable** (SDK limitation: `agent.listArtifacts()` returns `[]` for local).
- **One user = one machine.** Multi-user / multi-host needs more work.
- **Restart = active streams are lost.** If the bot restarts during a run the live stream breaks. The run itself continues on the Cursor SDK side, but without live feedback in Telegram. After returning to the chat you'll see the finished result via `Agent.list()` and can continue with `agent.send()`.

## Troubleshooting

### `TELEGRAM_BOT_TOKEN is required` / `CURSOR_API_KEY is required`

`.env` is empty. Make sure the file is in the project root, next to `package.json`.

### `ALLOWED_USER_IDS must be set...`

Fill in the CSV of Telegram user IDs. Get yours from [@userinfobot](https://t.me/userinfobot).

### The bot doesn't reply to `/start`

1. Check the log — there should be `rejected unauthorized update` with the `userId`. If your ID isn't in `ALLOWED_USER_IDS`, add it.
2. Check that the bot actually started — `telegram bot started` should appear in the log.
3. Check that @BotFather hasn't revoked the token.

### `Cursor SDK error (auth_failed)`

`CURSOR_API_KEY` is expired or invalid. Create a new one at [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations).

### `model not found` or `invalid model selection`

Your account doesn't have access to the model in `DEFAULT_MODEL_ID`. List available ones:

```bash
node --input-type=module -e "import('@cursor/sdk').then(s=>s.Cursor.models.list({apiKey:process.env.CURSOR_API_KEY}).then(m=>console.log(m)))"
```

Then put a valid `id` in `.env`.

### MCP server not visible in `/mcp`

1. Check `~/.cursor/mcp.json` (Windows: `C:\Users\<user>\.cursor\mcp.json`) — JSON must be valid.
2. For project MCP — there must be a `<projectCwd>/.cursor/mcp.json`.
3. Restart the bot (new MCP entries are picked up for new agents only).

### `message is not modified`

A log warning from the streamer, not an error. It happens when a debounced edit tries to write the same text. Ignored automatically.

### "Created a chat in the bot but I don't see it in Cursor IDE"

That's expected: in Cursor IDE 1.x SDK agents with `runtime: local` aren't shown in the Agents panel — the UI currently only shows IDE chats. To confirm the chat actually exists, run:

```bash
npm run list-agents
```

It uses the same `Agent.list({ runtime: "local", cwd })` as the bot and lists agents from every project in `projects.json`.

In the bot the chat is visible via `📁 Projects → <Project> → 💬 Chats` (the counter in the header reflects the real count).

### `bot.start()` hangs at startup (Windows + corporate network)

Symptoms: the log shows `starting cursor-tg-bot` and `sessions loaded`, but `telegram bot started` never appears. The Telegram API responds instantly via `Invoke-WebRequest`, but not via Node.

Cause: a TLS inspector (Zscaler / Fortinet / Kaspersky / antivirus) substitutes certificates. The Windows store trusts them, but Node doesn't (it ships its own CA bundle). PowerShell uses the Windows store, Node doesn't.

Fix: the bot automatically loads CAs from the Windows store via [`win-ca`](https://www.npmjs.com/package/win-ca) with `inject: "+"` (patches `tls.createSecureContext`, so it works for both `node:https` and native `fetch` / undici). This happens at the very top of `src/index.ts`. On macOS/Linux that block is skipped.

If the bot still hangs at startup — verify Windows certificates are up to date (`certutil -urlfetch -verify`), or temporarily set `NODE_TLS_REJECT_UNAUTHORIZED=0` in `.env` (UNSAFE, debug only).

### Telegram rate limit (`429 Too Many Requests`)

Increase `STREAM_EDIT_DEBOUNCE_MS` in `.env` (e.g. to `1500`). The default `900` ms is comfortable for one active conversation.

## Roadmap

### v0.2 — Security & UX

- [ ] Pairing token on first `/start` (one-time secret, issued in IDE → confirmed in the bot).
- [ ] Audit log of every command (separate file, append-only).
- [ ] `/lock` command and auto-lock after N minutes of inactivity.
- [ ] `/models` — list available models and switch between them.

### v0.3 — IDE chats in the bot ✅

- [x] Read `.jsonl` transcripts from `~/.cursor/projects/<normalized-cwd>/agent-transcripts/`.
- [x] List IDE chats in `📋 Chats` next to SDK chats.
- [x] View the last assistant reply for an IDE chat.
- [x] "🔄 Continue in bot" — bootstrap a new SDK agent from the IDE chat history.

### v0.4 — Chat deletion ✅

- [x] "🗑 Manage" mode in the chat list: trash icon shown only for SDK chats.
- [x] Confirm before delete (Yes / Cancel).
- [x] Delete SDK agents: row in `sdk-agent-store/.../index.db` (agent + runs + run_events) + transcript folder + close active handles.
- [x] **IDE chats are NOT deleted** — Cursor IDE uses their transcripts; deleting them can corrupt the IDE installation. Protected at two levels: UI (button hidden) + code (`deleteTranscriptFolder` and `deleteSdkAgent` refuse folders without the `agent-` prefix).
- [x] Clear the session if the active chat was deleted.

### v0.5 — Recovery after restart ✅

- [x] On startup, walk saved `activeRunId`s and use `Agent.getRun()` to wait for them with a 5-minute timeout — deliver the result to Telegram.
- [x] Auto-recovery for stuck persistent runs on the next `agent.send()` via `local: { force: true }` (automatic retry in `manager.sendMessage`).
- [x] Persistent sessions in `data/sessions.json`.
- [x] Corporate TLS-inspector support via `win-ca.inject('+')`.

### v0.6 — Blocking shell approvals

- [ ] Auto-generate `<project>/.cursor/hooks.json` with a `beforeShellExecution` hook.
- [ ] Hook calls a bridge script that waits for the bot's response via file IPC.
- [ ] Inline `✅ Approve` / `❌ Deny` buttons in Telegram.

### v1.0 — Cloud mode

- [ ] Optional `cloud` runtime for heavy tasks, doesn't depend on a running machine.
- [ ] `autoCreatePR` integration with GitHub.

## Contributing

Bug reports and pull requests are welcome on GitHub at <https://github.com/SOLAR8888/cursor-tg-bot>.

This is a small personal project — please open an issue first for anything substantial so we can discuss the approach.

## License

[ISC](./LICENSE) © cursor-tg-bot contributors
