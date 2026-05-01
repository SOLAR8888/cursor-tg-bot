import path from "node:path";
import { mkdir, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import type { Bot, Context } from "grammy";
import { InputFile } from "grammy";
import { logger } from "../logger.js";

/**
 * Outbox convention: while a run is active the bot watches a per-project
 * directory under the bot's `data/outbox/<projectId>/` folder. Anything the
 * agent writes there is forwarded to the Telegram chat that owns the run and
 * deleted on success. The whole `data/outbox/` tree is wiped on bot start so
 * leftovers from previous sessions don't get re-sent.
 *
 * Optional sidecar `<file>.caption.txt` is used as the caption.
 */

export const DATA_ROOT = path.resolve("data");
export const OUTBOX_ROOT = path.resolve("data", "outbox");

/**
 * Names inside `data/` that must NOT be wiped on startup.
 *  - sessions.json         — bot's own persistent session state
 *  - outbox                — wiped separately by `cleanOutboxRoot()`
 *  - inbox                 — wiped separately by `cleanInboxRoot()`
 *  - bot.log               — pino file destination opened in logger.ts BEFORE this runs
 *  - hooks-bridge          — reserved for future shell-approval IPC
 *  - restart-pending.json  — marker dropped by `/restart`; consumed once on startup
 */
const DATA_PRESERVE: ReadonlySet<string> = new Set([
  "sessions.json",
  "outbox",
  "inbox",
  "bot.log",
  "hooks-bridge",
  "restart-pending.json",
]);
const POLL_INTERVAL_MS = 1500;
// File mtime must be older than this before we treat the file as "settled" and
// safe to send. Prevents racing the agent while it's still writing the file.
const STABLE_AGE_MS = 700;
const TG_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const TG_DOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024;
const SHUTDOWN_DRAIN_MS = 5_000;
const CAPTION_SUFFIX = ".caption.txt";
const TG_CAPTION_LIMIT = 1024;

const IMAGE_EXTS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
]);

export function outboxDirForProject(projectId: string): string {
  return path.join(OUTBOX_ROOT, projectId);
}

/**
 * Removes any unexpected directories/files inside `data/` (e.g. scratch
 * folders the agent created during a run). Preserves the bot's own state
 * files listed in `DATA_PRESERVE`.
 */
export async function cleanStaleDataDir(): Promise<void> {
  let entries;
  try {
    entries = await readdir(DATA_ROOT, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.warn({ err, dir: DATA_ROOT }, "data: failed to read root");
    return;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (DATA_PRESERVE.has(entry.name)) continue;
    const target = path.join(DATA_ROOT, entry.name);
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (err) {
      logger.warn({ err, target }, "data: failed to clean stale entry");
    }
  }
  if (removed.length > 0) {
    logger.info({ removed }, "data: cleaned stale entries");
  }
}

/**
 * Wipes the entire outbox root. Called once on bot startup so old or orphaned
 * files (e.g. from a crashed run) don't get re-sent on the next run.
 */
export async function cleanOutboxRoot(): Promise<void> {
  try {
    await rm(OUTBOX_ROOT, { recursive: true, force: true });
    await mkdir(OUTBOX_ROOT, { recursive: true });
    logger.info({ dir: OUTBOX_ROOT }, "outbox: cleaned root on startup");
  } catch (err) {
    logger.warn({ err, dir: OUTBOX_ROOT }, "outbox: cleanup failed");
  }
}

export interface OutboxOptions {
  bot: Bot<Context>;
  chatId: number;
  projectId: string;
}

export interface OutboxHandle {
  readonly dir: string;
  stop(): Promise<void>;
}

export function startOutboxWatcher(opts: OutboxOptions): OutboxHandle {
  const { bot, chatId, projectId } = opts;
  const outboxDir = outboxDirForProject(projectId);
  const inFlight = new Set<string>();
  const permanentFailed = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  void mkdir(outboxDir, { recursive: true }).catch((err: unknown) => {
    logger.warn({ err, outboxDir }, "outbox: failed to ensure dir");
  });

  const poll = async (): Promise<void> => {
    if (stopped) return;
    let names: string[];
    try {
      names = await readdir(outboxDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn({ err, outboxDir }, "outbox: readdir failed");
      }
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (name.endsWith(CAPTION_SUFFIX)) continue;
      const full = path.join(outboxDir, name);
      if (inFlight.has(full)) continue;
      if (permanentFailed.has(full)) continue;
      let s;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (!s.isFile()) continue;
      if (Date.now() - s.mtimeMs < STABLE_AGE_MS) continue;
      inFlight.add(full);
      void sendOne(full, name, s.size).finally(() => inFlight.delete(full));
    }
  };

  const sendOne = async (
    full: string,
    name: string,
    size: number,
  ): Promise<void> => {
    const ext = path.extname(name).toLowerCase();
    const caption = await readSidecarCaption(outboxDir, name);
    const baseCaption = caption ?? `📎 ${name}`;
    let success = false;
    try {
      if (IMAGE_EXTS.has(ext) && size <= TG_PHOTO_LIMIT_BYTES) {
        await bot.api.sendPhoto(chatId, new InputFile(full), {
          caption: trimCaption(baseCaption),
        });
      } else if (size <= TG_DOCUMENT_LIMIT_BYTES) {
        await bot.api.sendDocument(chatId, new InputFile(full), {
          caption: trimCaption(baseCaption),
        });
      } else {
        await bot.api.sendMessage(
          chatId,
          `⚠️ File ${name} is too large for Telegram (${formatSize(size)} > 50 MB).`,
        );
        // The file is unsendable as-is — mark as terminally failed so we
        // don't keep retrying it every poll.
      }
      success = true;
      logger.info(
        { chatId, name, size, isImage: IMAGE_EXTS.has(ext), projectId },
        "outbox: file forwarded",
      );
    } catch (err) {
      logger.warn({ err, name, chatId }, "outbox: send failed");
      await bot.api
        .sendMessage(
          chatId,
          `⚠️ Failed to send file ${name}: ${(err as Error).message}`,
        )
        .catch(() => undefined);
    }
    if (success) {
      await Promise.allSettled([
        safeUnlink(full),
        removeSidecarCaption(outboxDir, name),
      ]);
    } else {
      permanentFailed.add(full);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await poll();
      } catch (err) {
        logger.warn({ err }, "outbox: poll error");
      } finally {
        schedule();
      }
    }, POLL_INTERVAL_MS);
  };

  schedule();

  return {
    dir: outboxDir,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        await poll();
      } catch (err) {
        logger.warn({ err }, "outbox: final poll error");
      }
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
      while (inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err, target }, "outbox: unlink failed");
    }
  }
}

async function readSidecarCaption(
  outboxDir: string,
  name: string,
): Promise<string | undefined> {
  const sidecar = path.join(outboxDir, `${name}${CAPTION_SUFFIX}`);
  try {
    const text = await readFile(sidecar, "utf8");
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function removeSidecarCaption(
  outboxDir: string,
  name: string,
): Promise<void> {
  const sidecar = path.join(outboxDir, `${name}${CAPTION_SUFFIX}`);
  try {
    await unlink(sidecar);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err, sidecar }, "outbox: failed to remove caption sidecar");
    }
  }
}

function trimCaption(text: string): string {
  if (text.length <= TG_CAPTION_LIMIT) return text;
  return text.slice(0, TG_CAPTION_LIMIT - 1) + "…";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function buildOutboxInstruction(absoluteOutboxDir: string): string {
  return [
    "[Telegram bridge]",
    "To send the user a file, screenshot or image via Telegram —",
    `save the file at the absolute path \`${absoluteOutboxDir}\` (any name/extension;`,
    "the directory already exists and belongs to the bot, not the project).",
    "The bot will forward the file to the chat and delete it from this folder.",
    "Images (.png/.jpg/.webp/.gif) are sent as photos, everything else as a document.",
    "Optionally place a sibling `<name>.<ext>.caption.txt` — its content becomes the caption.",
    "Don't do this unless the user explicitly asks.",
  ].join(" ");
}
