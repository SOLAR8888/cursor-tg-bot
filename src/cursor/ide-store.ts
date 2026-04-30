import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../logger.js";

export interface IdeChatInfo {
  id: string;
  name: string;
  lastModified: number;
  transcriptPath: string;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  toolCalls: Array<{ name: string; input?: unknown }>;
}

const IDE_CHAT_NAME_MAX = 60;
const TRANSCRIPT_LINE_BUDGET = 1000;

export function normalizeProjectId(cwd: string): string {
  let s = cwd;
  s = s.replace(/^([A-Za-z]):/, (_match, drive: string) => drive.toLowerCase());
  s = s.replace(/[\\/]/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  return s;
}

export function ideTranscriptsDir(cwd: string): string {
  return path.join(
    os.homedir(),
    ".cursor",
    "projects",
    normalizeProjectId(cwd),
    "agent-transcripts",
  );
}

export function unwrapUserQuery(text: string): string {
  const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m && m[1]) return m[1].trim();
  return text.trim();
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function extractToolCalls(content: unknown): Array<{ name: string; input?: unknown }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ name: string; input?: unknown }> = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use"
    ) {
      const name = (block as { name?: unknown }).name;
      if (typeof name === "string") {
        calls.push({ name, input: (block as { input?: unknown }).input });
      }
    }
  }
  return calls;
}

function deriveIdeChatName(text: string, maxLen = IDE_CHAT_NAME_MAX): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "(no first message)";
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}

async function readFirstUserText(transcriptPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(transcriptPath, "utf8");
    const lines = raw.split("\n");
    let scanned = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (++scanned > TRANSCRIPT_LINE_BUDGET) break;
      try {
        const entry = JSON.parse(line) as { role?: string; message?: { content?: unknown } };
        if (entry.role !== "user") continue;
        const text = extractText(entry.message?.content);
        const unwrapped = unwrapUserQuery(text);
        if (unwrapped) return unwrapped;
      } catch {
        // skip malformed line
      }
    }
  } catch (err) {
    logger.warn({ err, transcriptPath }, "failed to read first user text");
  }
  return undefined;
}

export async function listIdeChats(cwd: string): Promise<IdeChatInfo[]> {
  const dir = ideTranscriptsDir(cwd);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err, dir }, "failed to read agent-transcripts dir");
    }
    return [];
  }

  const out: IdeChatInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("agent-")) continue;

    const transcriptPath = path.join(dir, entry.name, `${entry.name}.jsonl`);
    try {
      const stats = await stat(transcriptPath);
      const firstUser = await readFirstUserText(transcriptPath);
      out.push({
        id: entry.name,
        name: deriveIdeChatName(firstUser ?? entry.name),
        lastModified: stats.mtimeMs,
        transcriptPath,
      });
    } catch (err) {
      logger.warn({ err, transcriptPath }, "failed to inspect ide chat");
    }
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}

export async function readTranscript(
  transcriptPath: string,
  options: { tail?: number } = {},
): Promise<TranscriptEntry[]> {
  const raw = await readFile(transcriptPath, "utf8");
  const lines = raw.split("\n");
  const result: TranscriptEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { role?: string; message?: { content?: unknown } };
      if (entry.role !== "user" && entry.role !== "assistant") continue;
      const text = extractText(entry.message?.content);
      const toolCalls = extractToolCalls(entry.message?.content);
      const trimmedText = entry.role === "user" ? unwrapUserQuery(text) : text.trim();
      if (!trimmedText && toolCalls.length === 0) continue;
      result.push({ role: entry.role, text: trimmedText, toolCalls });
    } catch {
      // skip malformed line
    }
  }
  if (options.tail && result.length > options.tail) {
    return result.slice(-options.tail);
  }
  return result;
}

export function getLastAssistantText(transcript: TranscriptEntry[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (!e) continue;
    if (e.role === "assistant" && e.text.trim().length > 0) return e.text;
  }
  return undefined;
}

export function buildBootstrapPrompt(
  transcript: TranscriptEntry[],
  userMessage: string,
): string {
  const lines: string[] = [
    "[Context: below is a conversation history from Cursor IDE that we want to continue.",
    "Familiarize yourself with it and answer the new message in the same context.",
    "Tool calls from history are summarized — you cannot replay them, only refer to them.]",
    "",
    "<history>",
  ];
  for (const e of transcript) {
    const role = e.role === "user" ? "USER" : "ASSISTANT";
    if (e.text.trim()) {
      lines.push(`${role}: ${e.text}`);
    }
    if (e.role === "assistant" && e.toolCalls.length > 0) {
      const summary = e.toolCalls
        .map((c) => c.name)
        .join(", ");
      lines.push(`ASSISTANT (tool calls): ${summary}`);
    }
    lines.push("");
  }
  lines.push("</history>");
  lines.push("");
  lines.push("[New user message — respond as if continuing the conversation above]");
  lines.push(userMessage);
  return lines.join("\n");
}
