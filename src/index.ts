import { GrammyError } from "grammy";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createBot } from "./bot/bot.js";
import { AgentManager } from "./agents/manager.js";
import { SessionStore } from "./bot/session.js";

const RUNTIME_ERROR_RETRY_MS = 2000;

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
