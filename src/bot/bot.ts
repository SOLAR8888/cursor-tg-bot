import { Bot } from "grammy";
import type { AppConfig } from "../types.js";
import type { AgentManager } from "../agents/manager.js";
import { whitelistMiddleware } from "./auth.js";
import type { SessionStore } from "./session.js";
import { registerHandlers } from "./handlers.js";

export function createBot(
  config: AppConfig,
  manager: AgentManager,
  sessions: SessionStore,
): Bot {
  const bot = new Bot(config.telegramBotToken);
  bot.use(whitelistMiddleware(config.allowedUserIds));
  registerHandlers(bot, config, manager, sessions);
  return bot;
}
