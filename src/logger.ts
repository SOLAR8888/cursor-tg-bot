import { mkdirSync } from "node:fs";
import path from "node:path";
import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const LOG_DIR = path.resolve(process.cwd(), "data");
const LOG_FILE = path.join(LOG_DIR, "bot.log");

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignored: directory already exists or cannot be created; pino.destination will surface a clear error if it cannot open the file.
}

const fileDestination = pino.destination({
  dest: LOG_FILE,
  sync: true,
  mkdir: true,
  append: true,
});

const stdoutTransport = pino.transport({
  target: "pino-pretty",
  options: {
    destination: 1,
    colorize: true,
    translateTime: "HH:MM:ss.l",
    ignore: "pid,hostname",
  },
});

export const logger = pino(
  {
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
  },
  pino.multistream([
    { level, stream: stdoutTransport },
    { level, stream: fileDestination },
  ]),
);

logger.info({ logFile: LOG_FILE }, "logger initialized");

export const logMessages = process.env.LOG_MESSAGES === "true";
