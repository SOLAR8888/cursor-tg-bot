import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Bot, Context } from "grammy";
import { logger } from "../logger.js";

/**
 * Inbox root: `data/inbox/<agentId>/<filename>`.
 * Files placed here are referenced by absolute path in the agent's prompt;
 * the agent then reads them with its own tools.
 *
 * Wiped on bot startup so leftovers from crashed/cancelled runs don't
 * accumulate forever.
 */
export const INBOX_ROOT = path.resolve("data", "inbox");

export const MAX_TEXT_INLINE_SIZE = 100_000;

const TEXT_MIME_PREFIXES: ReadonlyArray<string> = ["text/"];
const TEXT_MIME_EXACT: ReadonlySet<string> = new Set([
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-toml",
  "application/ld+json",
]);
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".txt", ".md", ".markdown", ".rst", ".rtf",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".xml", ".csv", ".tsv", ".log",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh",
  ".cs", ".php", ".swift", ".m", ".mm",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".sql", ".graphql", ".gql",
  ".gitignore", ".gitattributes", ".npmrc", ".prettierrc",
  ".env", ".dockerfile", ".lock",
]);

export function isImageMime(mimeType: string | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

export function isTextLikeFile(
  mimeType: string | undefined,
  fileName: string | undefined,
): boolean {
  if (mimeType) {
    if (TEXT_MIME_EXACT.has(mimeType)) return true;
    for (const p of TEXT_MIME_PREFIXES) {
      if (mimeType.startsWith(p)) return true;
    }
  }
  if (fileName) {
    const lower = fileName.toLowerCase();
    if (TEXT_EXTENSIONS.has(path.extname(lower))) return true;
    if (TEXT_EXTENSIONS.has(lower)) return true;
  }
  return false;
}

export async function cleanInboxRoot(): Promise<void> {
  try {
    await rm(INBOX_ROOT, { recursive: true, force: true });
    await mkdir(INBOX_ROOT, { recursive: true });
    logger.info({ dir: INBOX_ROOT }, "inbox: cleaned root on startup");
  } catch (err) {
    logger.warn({ err, dir: INBOX_ROOT }, "inbox: cleanup failed");
  }
}

export async function saveToInbox(
  projectId: string,
  fileName: string,
  buf: Buffer,
): Promise<string> {
  const dir = path.join(INBOX_ROOT, projectId);
  await mkdir(dir, { recursive: true });
  const safe = sanitizeFileName(fileName);
  const stamped = `${Date.now()}-${safe}`;
  const target = path.join(dir, stamped);
  await writeFile(target, buf);
  return target;
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\.+$/, "")
    .slice(0, 200)
    .trim();
  return cleaned.length > 0 ? cleaned : "file";
}

export interface DownloadedFile {
  buf: Buffer;
  size: number;
}

export class TelegramFileTooBigError extends Error {
  constructor() {
    super(
      "Файл больше 20 МБ — Telegram Bot API не даёт ботам скачивать такие файлы. " +
        "Пришлите файл меньшего размера или поднимите local Bot API server.",
    );
    this.name = "TelegramFileTooBigError";
  }
}

export async function downloadTelegramFile(
  bot: Bot<Context>,
  fileId: string,
): Promise<DownloadedFile> {
  let file;
  try {
    file = await bot.api.getFile(fileId);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/file is too big|too large/i.test(msg)) {
      throw new TelegramFileTooBigError();
    }
    throw err;
  }
  if (!file.file_path) {
    throw new Error("Telegram getFile() returned no file_path");
  }
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, size: buf.length };
}

export function mimeFromName(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return undefined;
  }
}

export function formatTextFileForPrompt(
  fileName: string,
  caption: string | undefined,
  content: string,
): string {
  const head = caption?.trim() ? caption.trim() + "\n\n" : "";
  return (
    head +
    `[Прикреплён файл \`${fileName}\` (${content.length} chars):]\n` +
    "```\n" +
    content +
    "\n```"
  );
}

export function formatBinaryFileForPrompt(
  fileName: string,
  absolutePath: string,
  caption: string | undefined,
  size: number,
): string {
  const head = caption?.trim() ? caption.trim() + "\n\n" : "";
  return (
    head +
    `[Прикреплён файл: \`${fileName}\` (${formatSize(size)})]\n` +
    `Сохранён по абсолютному пути: \`${absolutePath}\`\n` +
    `Прочитай его своими инструментами при необходимости.`
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
