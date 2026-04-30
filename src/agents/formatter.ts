import type { SDKToolUseMessage } from "@cursor/sdk";
import { code, escapeMdV2 } from "../util/markdown.js";

const MAX_TOOL_PREVIEW = 120;

export function describeToolCallStart(msg: SDKToolUseMessage): string {
  const preview = renderArgsPreview(msg);
  const head = `🔧 ${escapeMdV2(msg.name)}`;
  return preview ? `${head} ${preview}` : head;
}

export function describeToolCallCompleted(msg: SDKToolUseMessage): string {
  const icon = msg.status === "error" ? "❌" : "✅";
  const preview = renderArgsPreview(msg);
  const head = `${icon} ${escapeMdV2(msg.name)}`;
  return preview ? `${head} ${preview}` : head;
}

function renderArgsPreview(msg: SDKToolUseMessage): string | undefined {
  const args = msg.args;
  if (args === null || args === undefined) return undefined;
  if (typeof args !== "object") return code(truncate(String(args), MAX_TOOL_PREVIEW));

  const obj = args as Record<string, unknown>;

  for (const key of [
    "command",
    "filePath",
    "file_path",
    "path",
    "target",
    "query",
    "globPattern",
    "pattern",
  ]) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return code(truncate(value, MAX_TOOL_PREVIEW));
    }
  }

  try {
    const flat = JSON.stringify(args);
    if (flat && flat !== "{}") return code(truncate(flat, MAX_TOOL_PREVIEW));
  } catch {
    // ignore — non-serializable
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function statusEmoji(
  status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED",
): string {
  switch (status) {
    case "CREATING":
      return "🟡";
    case "RUNNING":
      return "🔵";
    case "FINISHED":
      return "🟢";
    case "ERROR":
      return "🔴";
    case "CANCELLED":
      return "⚪";
    case "EXPIRED":
      return "⚫";
  }
}
