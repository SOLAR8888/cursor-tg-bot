import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import type { ModelSelection } from "@cursor/sdk";
import { logger } from "./logger.js";
import type { AppConfig, ProjectConfig } from "./types.js";

dotenvConfig({ quiet: true, override: true });

const projectSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, "id must be [A-Za-z0-9_-]+"),
  name: z.string().min(1),
  cwd: z.string().min(1),
  description: z.string().optional(),
  allowedUserIds: z
    .array(z.number().int().positive())
    .nonempty("allowedUserIds must contain at least one user id when set")
    .optional(),
});

const projectsFileSchema = z.object({
  projects: z.array(projectSchema).min(1, "projects.json must contain at least one project"),
});

function parseAllowedUserIds(raw: string | undefined): ReadonlySet<number> {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "ALLOWED_USER_IDS must be set to a non-empty CSV of Telegram user IDs",
    );
  }
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const parsed = Number(part);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in ALLOWED_USER_IDS: "${part}"`);
      }
      return parsed;
    });
  return new Set(ids);
}

function parseModelParams(raw: string | undefined): ModelSelection["params"] {
  if (!raw || raw.trim() === "") return undefined;
  const pairs = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const params = pairs.map((pair) => {
    const [id, value] = pair.split("=");
    if (!id || !value) {
      throw new Error(
        `Invalid DEFAULT_MODEL_PARAMS entry "${pair}". Expected "key=value,key=value".`,
      );
    }
    return { id: id.trim(), value: value.trim() };
  });
  return params.length > 0 ? params : undefined;
}

async function findProjectsFile(): Promise<string> {
  const explicit = process.env.PROJECTS_FILE;
  const candidates = [
    ...(explicit ? [path.resolve(explicit)] : []),
    path.resolve(process.cwd(), "projects.json"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "projects.json"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `projects.json not found. Looked in:\n  ${candidates.join("\n  ")}\n` +
      `Copy projects.json.example to projects.json and edit it.`,
  );
}

async function loadProjects(): Promise<readonly ProjectConfig[]> {
  const filePath = await findProjectsFile();
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }
  const result = projectsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid ${filePath}:\n${result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  const seen = new Set<string>();
  for (const p of result.data.projects) {
    if (seen.has(p.id)) {
      throw new Error(`Duplicate project id "${p.id}" in projects.json`);
    }
    seen.add(p.id);
  }
  return result.data.projects.map<ProjectConfig>((p) => {
    const { allowedUserIds, ...rest } = p;
    return allowedUserIds
      ? { ...rest, allowedUserIds: new Set(allowedUserIds) }
      : rest;
  });
}

export async function loadConfig(): Promise<AppConfig> {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const cursorApiKey = process.env.CURSOR_API_KEY ?? "";
  if (!cursorApiKey) {
    throw new Error("CURSOR_API_KEY is required");
  }

  const allowedUserIds = parseAllowedUserIds(process.env.ALLOWED_USER_IDS);
  const projects = await loadProjects();

  for (const project of projects) {
    if (!project.allowedUserIds) continue;
    const unknown: number[] = [];
    for (const userId of project.allowedUserIds) {
      if (!allowedUserIds.has(userId)) unknown.push(userId);
    }
    if (unknown.length > 0) {
      logger.warn(
        { projectId: project.id, unknownUserIds: unknown },
        "project.allowedUserIds contains ids missing from global ALLOWED_USER_IDS; those users still won't be able to use the bot",
      );
    }
  }

  const defaultModel: ModelSelection = {
    id: process.env.DEFAULT_MODEL_ID ?? "auto",
    params: parseModelParams(process.env.DEFAULT_MODEL_PARAMS),
  };

  const showThinking = process.env.SHOW_THINKING === "true";
  const streamEditDebounceMs = Number(process.env.STREAM_EDIT_DEBOUNCE_MS ?? "900");
  if (!Number.isFinite(streamEditDebounceMs) || streamEditDebounceMs < 0) {
    throw new Error("STREAM_EDIT_DEBOUNCE_MS must be a non-negative number");
  }

  return {
    telegramBotToken,
    cursorApiKey,
    allowedUserIds,
    projects,
    defaultModel,
    showThinking,
    streamEditDebounceMs,
  };
}
