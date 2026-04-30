import { mkdirSync } from "node:fs";
import path from "node:path";
import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const LOG_DIR = path.resolve(process.cwd(), "data");
const LOG_FILE = path.join(LOG_DIR, "bot.log");

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignored: directory already exists or cannot be created; pino will surface a clear error below.
}

const targets: pino.TransportTargetOptions[] = [
  {
    target: "pino-pretty",
    level,
    options: {
      destination: 1,
      colorize: process.stdout.isTTY === true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname",
    },
  },
  {
    target: "pino-pretty",
    level,
    options: {
      destination: LOG_FILE,
      mkdir: true,
      append: true,
      colorize: false,
      translateTime: "yyyy-mm-dd HH:MM:ss.l",
      ignore: "pid,hostname",
    },
  },
];

export const logger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "TELEGRAM_BOT_TOKEN",
      "CURSOR_API_KEY",
      "*.TELEGRAM_BOT_TOKEN",
      "*.CURSOR_API_KEY",
      "headers.authorization",
      "*.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
  transport: { targets },
});

export const logMessages = process.env.LOG_MESSAGES === "true";
