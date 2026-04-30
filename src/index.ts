import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createBot } from "./bot/bot.js";
import { AgentManager } from "./agents/manager.js";

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
  const bot = createBot(config, agentManager);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "shutdown signal received");
    try {
      await bot.stop();
    } catch (err) {
      logger.error({ err }, "error stopping bot");
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

  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => {
      logger.info({ username: info.username }, "telegram bot started");
    },
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "fatal error");
  process.exit(1);
});
