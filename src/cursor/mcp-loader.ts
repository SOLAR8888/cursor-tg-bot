import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { McpServerConfig } from "@cursor/sdk";
import { logger } from "../logger.js";

export interface McpServerEntry {
  name: string;
  source: "user" | "project";
  config: McpServerConfig;
}

interface McpFile {
  mcpServers?: Record<string, McpServerConfig>;
}

async function readMcpFile(filePath: string): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as McpFile;
    return parsed.mcpServers ?? {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    logger.warn({ filePath, err }, "failed to read mcp file");
    return {};
  }
}

export function userMcpPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

export function projectMcpPath(cwd: string): string {
  return path.join(cwd, ".cursor", "mcp.json");
}

export async function loadMcpServers(cwd: string): Promise<McpServerEntry[]> {
  const [userServers, projectServers] = await Promise.all([
    readMcpFile(userMcpPath()),
    readMcpFile(projectMcpPath(cwd)),
  ]);
  const entries: McpServerEntry[] = [];
  const seen = new Set<string>();
  for (const [name, config] of Object.entries(projectServers)) {
    entries.push({ name, source: "project", config });
    seen.add(name);
  }
  for (const [name, config] of Object.entries(userServers)) {
    if (seen.has(name)) continue;
    entries.push({ name, source: "user", config });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export async function loadMcpServersAsRecord(
  cwd: string,
): Promise<Record<string, McpServerConfig>> {
  const entries = await loadMcpServers(cwd);
  const out: Record<string, McpServerConfig> = {};
  for (const e of entries) out[e.name] = e.config;
  return out;
}

export function summarizeMcpEntry(entry: McpServerEntry): string {
  const c = entry.config;
  if ("url" in c) {
    const transport = c.type ?? "http";
    return `${transport.toUpperCase()} ${c.url}`;
  }
  const args = c.args && c.args.length > 0 ? ` ${c.args.join(" ")}` : "";
  return `STDIO ${c.command}${args}`;
}
