import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

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
  transport:
    process.stdout.isTTY === true
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});

export const logMessages = process.env.LOG_MESSAGES === "true";
