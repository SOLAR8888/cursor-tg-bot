import { Agent, CursorAgentError } from "@cursor/sdk";
import type {
  ListResult,
  Run,
  SDKAgent,
  SDKAgentInfo,
  SDKUserMessage,
} from "@cursor/sdk";
import type { AppConfig, ProjectConfig } from "../types.js";
import { logger } from "../logger.js";
import { loadMcpServersAsRecord } from "../cursor/mcp-loader.js";
import { deleteTranscriptFolder } from "../cursor/ide-store.js";
import { deleteSdkAgentRecords } from "../cursor/sdk-store.js";

interface ActiveAgentEntry {
  agent: SDKAgent;
  projectId: string;
  agentId: string;
  activeRun?: Run;
}

const DEFAULT_AGENT_NAME = "New Agent";
const NAME_FROM_PROMPT_MAX = 60;

export function deriveAgentName(text: string, maxLen = NAME_FROM_PROMPT_MAX): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return DEFAULT_AGENT_NAME;
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}

function toPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybeToJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof maybeToJSON === "function") {
    try {
      const json = (maybeToJSON as () => unknown).call(value);
      if (json && typeof json === "object") return json as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return value as Record<string, unknown>;
}

function extractLastAssistantText(turns: unknown): string | undefined {
  if (!Array.isArray(turns)) return undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = toPlainObject(turns[i]);
    if (!turn) continue;

    const agentTurn = toPlainObject(turn.agentConversationTurn) ?? toPlainObject(turn.turn);
    if (!agentTurn) continue;

    const steps = agentTurn.steps;
    if (!Array.isArray(steps)) continue;

    for (let j = steps.length - 1; j >= 0; j--) {
      const step = toPlainObject(steps[j]);
      if (!step) continue;
      const assistant = toPlainObject(step.assistantMessage);
      if (assistant) {
        const text = assistant.text;
        if (typeof text === "string" && text.trim().length > 0) return text;
      }
      const message = toPlainObject(step.message);
      if (message && step.type === "assistantMessage") {
        const text = message.text;
        if (typeof text === "string" && text.trim().length > 0) return text;
      }
    }
  }
  return undefined;
}

function extractFirstUserText(message: unknown): string | undefined {
  const obj = toPlainObject(message);
  if (!obj) return undefined;

  const turn = toPlainObject(obj.agentConversationTurn);
  if (turn) {
    const userMessage = toPlainObject(turn.userMessage);
    if (userMessage) {
      const text = userMessage.text;
      if (typeof text === "string" && text.trim().length > 0) return text;
    }
  }

  const content = obj.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = toPlainObject(block);
      if (b && b.type === "text") {
        const text = b.text;
        if (typeof text === "string" && text.trim().length > 0) return text;
      }
    }
  }
  return undefined;
}

export class AgentManager {
  private readonly cache = new Map<string, ActiveAgentEntry>();
  // Serialises chdir() so concurrent SDK calls don't race on process.cwd().
  private cwdQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: AppConfig) {}

  getProject(projectId: string): ProjectConfig | undefined {
    return this.config.projects.find((p) => p.id === projectId);
  }

  /**
   * Workaround for @cursor/sdk 1.0.10: `local.cwd` passed to Agent.create()
   * is ignored — the SDK uses `process.cwd()` to route the agent into the
   * right SDK store and to set the agent's `workspace_ref`. Same for
   * Agent.list() / Agent.resume() / Agent.messages.list() / Agent.listRuns().
   *
   * So before any SDK call we chdir() into the project's cwd, run the call,
   * then chdir back. A soft mutex keeps these chdir windows non-overlapping
   * across concurrent operations, but won't deadlock on a stuck call —
   * after `MUTEX_WAIT_TIMEOUT_MS` we proceed regardless so a hung MCP
   * child-process can't freeze the whole bot.
   */
  private static readonly MUTEX_WAIT_TIMEOUT_MS = 30_000;

  private async runInProjectCwd<T>(
    project: ProjectConfig,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.cwdQueue;
    let release: () => void = () => undefined;
    this.cwdQueue = new Promise<void>((r) => {
      release = r;
    });

    let timedOut = false;
    await Promise.race([
      prev.catch(() => undefined),
      new Promise<void>((r) =>
        setTimeout(() => {
          timedOut = true;
          r();
        }, AgentManager.MUTEX_WAIT_TIMEOUT_MS),
      ),
    ]);
    if (timedOut) {
      logger.warn(
        { projectId: project.id },
        "cwd mutex timed out waiting for previous op; proceeding anyway",
      );
    }

    const saved = process.cwd();
    let chdiredTo: string | undefined;
    try {
      if (saved !== project.cwd) {
        try {
          process.chdir(project.cwd);
          chdiredTo = project.cwd;
        } catch (err) {
          logger.warn(
            { err, target: project.cwd },
            "chdir to project failed; running without it",
          );
        }
      }
      return await fn();
    } finally {
      if (chdiredTo !== undefined) {
        try {
          process.chdir(saved);
        } catch (err) {
          logger.warn({ err, saved }, "chdir back failed");
        }
      }
      release();
    }
  }

  async listAgents(project: ProjectConfig): Promise<SDKAgentInfo[]> {
    return this.runInProjectCwd(project, async () => {
      const collected: SDKAgentInfo[] = [];
      let cursor: string | undefined;
      do {
        const page: ListResult<SDKAgentInfo> = await Agent.list({
          runtime: "local",
          cwd: project.cwd,
          ...(cursor !== undefined ? { cursor } : {}),
          limit: 50,
        });
        collected.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined && collected.length < 200);
      collected.sort((a, b) => b.lastModified - a.lastModified);
      return collected;
    });
  }

  private async buildMcpServers(
    project: ProjectConfig,
  ): Promise<Record<string, import("@cursor/sdk").McpServerConfig>> {
    try {
      const servers = await loadMcpServersAsRecord(project.cwd);
      logger.info(
        {
          projectId: project.id,
          mcpServers: Object.keys(servers),
          count: Object.keys(servers).length,
        },
        "loaded mcp servers for agent",
      );
      return servers;
    } catch (err) {
      logger.warn({ err, projectId: project.id }, "failed to load mcp servers");
      return {};
    }
  }

  async createAgent(project: ProjectConfig, name?: string): Promise<SDKAgent> {
    logger.info(
      { projectId: project.id, cwd: project.cwd, model: this.config.defaultModel.id },
      "creating new local agent",
    );
    const mcpServers = await this.buildMcpServers(project);
    const agent = await this.runInProjectCwd(project, () =>
      Agent.create({
        apiKey: this.config.cursorApiKey,
        model: this.config.defaultModel,
        ...(name ? { name } : {}),
        local: {
          cwd: project.cwd,
          settingSources: ["user", "project"],
        },
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      }),
    );
    this.cache.set(agent.agentId, {
      agent,
      projectId: project.id,
      agentId: agent.agentId,
    });
    return agent;
  }

  async resumeAgent(project: ProjectConfig, agentId: string): Promise<SDKAgent> {
    const cached = this.cache.get(agentId);
    if (cached) return cached.agent;
    logger.info({ agentId, projectId: project.id }, "resuming local agent");
    const mcpServers = await this.buildMcpServers(project);
    const agent = await this.runInProjectCwd(project, () =>
      Agent.resume(agentId, {
        apiKey: this.config.cursorApiKey,
        model: this.config.defaultModel,
        local: {
          cwd: project.cwd,
          settingSources: ["user", "project"],
        },
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      }),
    );
    this.cache.set(agent.agentId, {
      agent,
      projectId: project.id,
      agentId: agent.agentId,
    });
    return agent;
  }

  setActiveRun(agentId: string, run: Run | undefined): void {
    const entry = this.cache.get(agentId);
    if (!entry) return;
    if (run === undefined) {
      delete entry.activeRun;
    } else {
      entry.activeRun = run;
    }
  }

  getActiveRun(agentId: string): Run | undefined {
    return this.cache.get(agentId)?.activeRun;
  }

  async sendMessage(
    agent: SDKAgent,
    message: string | SDKUserMessage,
  ): Promise<Run> {
    const entry = this.cache.get(agent.agentId);
    const project = entry ? this.getProject(entry.projectId) : undefined;
    const send = async (force: boolean): Promise<Run> => {
      const opts = force ? { local: { force: true } } : undefined;
      const fn = (): Promise<Run> =>
        opts ? agent.send(message, opts) : agent.send(message);
      return project ? this.runInProjectCwd(project, fn) : fn();
    };
    try {
      return await send(false);
    } catch (err) {
      if (this.isStuckActiveRunError(err)) {
        logger.warn(
          { agentId: agent.agentId },
          "agent has stuck active run, retrying with local.force=true",
        );
        return await send(true);
      }
      throw err;
    }
  }

  private isStuckActiveRunError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return /already has active run/i.test(err.message);
  }

  async cancelActiveRun(agentId: string): Promise<boolean> {
    const entry = this.cache.get(agentId);
    if (!entry?.activeRun) return false;
    if (entry.activeRun.status !== "running") return false;
    try {
      await entry.activeRun.cancel();
      return true;
    } catch (err) {
      logger.error({ err, agentId }, "failed to cancel run");
      throw err;
    }
  }

  async getFirstUserText(
    project: ProjectConfig,
    agentId: string,
  ): Promise<string | undefined> {
    try {
      const messages = await this.runInProjectCwd(project, () =>
        Agent.messages.list(agentId, {
          runtime: "local",
          cwd: project.cwd,
          limit: 5,
        }),
      );
      for (const m of messages) {
        if (m.type !== "user") continue;
        const text = extractFirstUserText(m.message);
        if (text) return text;
      }
    } catch (err) {
      logger.warn({ err, agentId }, "messages.list failed");
    }
    return undefined;
  }

  async listAgentsWithNames(project: ProjectConfig): Promise<SDKAgentInfo[]> {
    const items = await this.listAgents(project);
    const needsName = items.filter(
      (a) => !a.name || a.name === DEFAULT_AGENT_NAME,
    );
    if (needsName.length === 0) return items;

    const fallbacks = await Promise.all(
      needsName.map(async (a) => {
        const text = await this.getFirstUserText(project, a.agentId);
        return [a.agentId, text] as const;
      }),
    );
    const fallbackMap = new Map(fallbacks);
    return items.map((a) => {
      const fallback = fallbackMap.get(a.agentId);
      if (!fallback) return a;
      return { ...a, name: deriveAgentName(fallback) };
    });
  }

  async getLastAssistantText(
    project: ProjectConfig,
    agentId: string,
  ): Promise<string | undefined> {
    let runs;
    try {
      runs = await this.runInProjectCwd(project, () =>
        Agent.listRuns(agentId, {
          runtime: "local",
          cwd: project.cwd,
          limit: 20,
        }),
      );
    } catch (err) {
      logger.warn({ err, agentId }, "listRuns failed");
      return undefined;
    }
    const ordered = [...runs.items].sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );
    for (const run of ordered) {
      if (run.status === "error") continue;
      if (run.result && run.result.trim().length > 0) return run.result;
      if (!run.supports("conversation")) continue;
      try {
        const turns = await this.runInProjectCwd(project, () => run.conversation());
        const text = extractLastAssistantText(turns);
        if (text) return text;
      } catch (err) {
        logger.warn({ err, agentId, runId: run.id }, "conversation() failed");
      }
    }
    return undefined;
  }

  async deleteSdkAgent(project: ProjectConfig, agentId: string): Promise<void> {
    if (!agentId.startsWith("agent-")) {
      throw new Error(
        `Refusing to delete non-SDK chat "${agentId}" (only ids prefixed with "agent-" are SDK)`,
      );
    }
    await this.closeAgent(agentId);
    try {
      await deleteSdkAgentRecords(project.cwd, agentId);
    } catch (err) {
      logger.error({ err, agentId }, "deleteSdkAgentRecords failed");
      throw err;
    }
    try {
      await deleteTranscriptFolder(project.cwd, agentId);
    } catch (err) {
      logger.warn({ err, agentId }, "deleteTranscriptFolder for sdk failed (non-fatal)");
    }
  }

  async closeAgent(agentId: string): Promise<void> {
    const entry = this.cache.get(agentId);
    if (!entry) return;
    this.cache.delete(agentId);
    try {
      await entry.agent[Symbol.asyncDispose]();
    } catch (err) {
      logger.error({ err, agentId }, "error disposing agent");
    }
  }

  async disposeAll(): Promise<void> {
    const ids = Array.from(this.cache.keys());
    await Promise.allSettled(ids.map((id) => this.closeAgent(id)));
  }

  getCachedAgent(agentId: string): SDKAgent | undefined {
    return this.cache.get(agentId)?.agent;
  }

  isAgentBusy(agentId: string): boolean {
    const entry = this.cache.get(agentId);
    return entry?.activeRun !== undefined && entry.activeRun.status === "running";
  }

  describeError(err: unknown): string {
    if (err instanceof CursorAgentError) {
      const code = err.code ? ` (${err.code})` : "";
      const retry = err.isRetryable ? " — retryable" : "";
      return `Cursor SDK error${code}: ${err.message}${retry}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
