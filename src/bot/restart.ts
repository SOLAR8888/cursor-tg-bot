import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Bot, Context } from "grammy";
import { logger } from "../logger.js";
import type { AgentManager } from "../agents/manager.js";
import type { SessionStore } from "./session.js";

/**
 * Lifecycle of a `/restart`:
 *   1. Handler in `handlers.ts` calls {@link performGracefulRestart}.
 *   2. We persist the originating user/chat/message into RESTART_FLAG_PATH so
 *      the next process can find out who asked and edit the same Telegram
 *      message after coming back up.
 *   3. We stop the bot, flush sessions, dispose agents, and `process.exit(0)`.
 *   4. The host needs an external supervisor (`tsx watch`, pm2, systemd,
 *      docker --restart=always, ...) to actually respawn the process; this
 *      module never re-execs itself.
 *   5. On next boot, `index.ts` calls {@link consumePendingRestart} BEFORE
 *      `cleanStaleDataDir()` (so the marker file isn't wiped) and uses the
 *      payload to send/edit a "✅ Bot restarted" message in Telegram.
 */

export const RESTART_FLAG_PATH = path.resolve("data", "restart-pending.json");
const RESTART_FLAG_TMP = `${RESTART_FLAG_PATH}.tmp`;

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface PendingRestart {
  userId: number;
  chatId: number;
  messageId?: number;
  requestedAt: number;
}

interface PerformRestartOptions {
  bot: Bot<Context>;
  manager: AgentManager;
  sessions: SessionStore;
  request: PendingRestart;
}

let restartInProgress = false;

export function isRestartInProgress(): boolean {
  return restartInProgress;
}

async function writeRestartFlag(payload: PendingRestart): Promise<void> {
  await mkdir(path.dirname(RESTART_FLAG_PATH), { recursive: true });
  await writeFile(RESTART_FLAG_TMP, JSON.stringify(payload, null, 2), "utf8");
  await rename(RESTART_FLAG_TMP, RESTART_FLAG_PATH);
}

export async function consumePendingRestart(): Promise<PendingRestart | null> {
  let raw: string;
  try {
    raw = await readFile(RESTART_FLAG_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    logger.warn({ err }, "restart: failed to read pending flag");
    return null;
  }
  try {
    await unlink(RESTART_FLAG_PATH);
  } catch (err) {
    logger.warn({ err }, "restart: failed to remove pending flag");
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingRestart>;
    if (
      typeof parsed.userId !== "number" ||
      typeof parsed.chatId !== "number" ||
      typeof parsed.requestedAt !== "number"
    ) {
      logger.warn({ parsed }, "restart: pending flag has unexpected shape");
      return null;
    }
    return {
      userId: parsed.userId,
      chatId: parsed.chatId,
      requestedAt: parsed.requestedAt,
      ...(typeof parsed.messageId === "number"
        ? { messageId: parsed.messageId }
        : {}),
    };
  } catch (err) {
    logger.warn({ err }, "restart: failed to parse pending flag");
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          logger.warn({ label, timeoutMs: ms }, "restart: step timed out");
          resolve(undefined);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Persist the request, gracefully tear everything down, then `process.exit(0)`.
 * This function does not return — it ends with `process.exit`.
 */
export async function performGracefulRestart(
  options: PerformRestartOptions,
): Promise<never> {
  if (restartInProgress) {
    // Should be rare: handler already guards against this.
    return new Promise<never>(() => undefined);
  }
  restartInProgress = true;

  const { bot, manager, sessions, request } = options;

  try {
    await writeRestartFlag(request);
    logger.info(
      { userId: request.userId, chatId: request.chatId },
      "restart: persisted pending flag",
    );
  } catch (err) {
    logger.error({ err }, "restart: failed to persist pending flag (continuing)");
  }

  await withTimeout(
    bot.stop().catch((err: unknown) => {
      logger.error({ err }, "restart: bot.stop failed");
    }),
    SHUTDOWN_TIMEOUT_MS,
    "bot.stop",
  );

  await withTimeout(
    sessions.flush().catch((err: unknown) => {
      logger.error({ err }, "restart: sessions.flush failed");
    }),
    SHUTDOWN_TIMEOUT_MS,
    "sessions.flush",
  );

  await withTimeout(
    manager.disposeAll().catch((err: unknown) => {
      logger.error({ err }, "restart: agent disposeAll failed");
    }),
    SHUTDOWN_TIMEOUT_MS,
    "manager.disposeAll",
  );

  logger.info("restart: graceful shutdown complete; exiting with code 0");
  process.exit(0);
}
