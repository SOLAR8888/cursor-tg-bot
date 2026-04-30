// On Windows, load CA certificates from the Windows certificate store
// before any TLS-using module is imported. Required when corporate networks
// inject TLS-inspection certificates (Zscaler / Fortinet / Kaspersky / etc).
if (process.platform === "win32") {
  // @ts-expect-error - win-ca has no types
  const wca = await import("win-ca");
  // inject Windows-store CAs into the global TLS context so that
  // native fetch (undici) and node:https trust corporate TLS-inspection
  // certificates (Zscaler / Fortinet / Kaspersky / antivirus / etc).
  wca.default({ inject: "+" });
}

import { GrammyError } from "grammy";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createBot } from "./bot/bot.js";
import { AgentManager } from "./agents/manager.js";
import { SessionStore } from "./bot/session.js";
import { recoverActiveRuns } from "./agents/recovery.js";

const RUNTIME_ERROR_RETRY_MS = 2000;

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: unknown }).message;
  const code = (err as { code?: unknown }).code;
  const cause = (err as { cause?: unknown }).cause;
  const text = typeof msg === "string" ? msg : "";
  if (typeof code === "string") {
    if (
      code === "EAI_AGAIN" ||
      code === "ENOTFOUND" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EPIPE"
    ) {
      return true;
    }
  }
  if (
    text.includes("EAI_AGAIN") ||
    text.includes("ENOTFOUND") ||
    text.includes("ETIMEDOUT") ||
    text.includes("ECONNRESET") ||
    text.includes("getaddrinfo")
  ) {
    return true;
  }
  return cause !== err && cause !== undefined && isTransientNetworkError(cause);
}

process.on("unhandledRejection", (reason) => {
  if (isTransientNetworkError(reason)) {
    logger.warn({ err: reason }, "transient network error (unhandledRejection); ignored");
    return;
  }
  logger.error({ err: reason }, "unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  if (isTransientNetworkError(err)) {
    logger.warn({ err }, "transient network error (uncaughtException); ignored");
    return;
  }
  logger.error({ err }, "uncaught exception");
});

async function main(): Promise<void> {
  const config = await loadConfig();
  logger.info(
    {
      projects: config.projects.length,
      allowedUsers: config.allowedUserIds.size,
      model: config.defaultModel.id,
    },
    "starting cursor-tg-bot",
  );

  const agentManager = new AgentManager(config);
  const sessions = new SessionStore();
  await sessions.load();
  const bot = createBot(config, agentManager, sessions);

  bot.catch((err) => {
    logger.error(
      { err: err.error, updateId: err.ctx.update?.update_id },
      "uncaught error in update handler",
    );
  });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutdown signal received");
    try {
      await bot.stop();
    } catch (err) {
      logger.error({ err }, "error stopping bot");
    }
    try {
      await sessions.flush();
    } catch (err) {
      logger.error({ err }, "error flushing sessions");
    }
    try {
      await agentManager.disposeAll();
    } catch (err) {
      logger.error({ err }, "error disposing agents");
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  while (!stopping) {
    try {
      await bot.start({
        drop_pending_updates: true,
        onStart: (info) => {
          logger.info({ username: info.username }, "telegram bot started");
          void recoverActiveRuns(bot, agentManager, sessions);
        },
      });
      return;
    } catch (err) {
      if (
        err instanceof GrammyError &&
        err.error_code === 409 &&
        !stopping
      ) {
        logger.warn(
          "telegram getUpdates conflict (another instance polling); retrying in 2s",
        );
        await new Promise((r) => setTimeout(r, RUNTIME_ERROR_RETRY_MS));
        continue;
      }
      throw err;
    }
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "fatal error");
  process.exit(1);
});
