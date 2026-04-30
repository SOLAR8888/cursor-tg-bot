import { Bot } from "grammy";
import type { AppConfig } from "../types.js";
import type { AgentManager } from "../agents/manager.js";
import { whitelistMiddleware } from "./auth.js";
import { SessionStore } from "./session.js";
import { registerHandlers } from "./handlers.js";

export function createBot(config: AppConfig, manager: AgentManager): Bot {
  const bot = new Bot(config.telegramBotToken);
  bot.use(whitelistMiddleware(config.allowedUserIds));

  const sessions = new SessionStore();
  registerHandlers(bot, config, manager, sessions);

  return bot;
}
