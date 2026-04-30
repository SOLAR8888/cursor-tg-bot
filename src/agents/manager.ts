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

interface ActiveAgentEntry {
  agent: SDKAgent;
  projectId: string;
  agentId: string;
  activeRun?: Run;
}

export class AgentManager {
  private readonly cache = new Map<string, ActiveAgentEntry>();

  constructor(private readonly config: AppConfig) {}

  getProject(projectId: string): ProjectConfig | undefined {
    return this.config.projects.find((p) => p.id === projectId);
  }

  async listAgents(project: ProjectConfig): Promise<SDKAgentInfo[]> {
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
  }

  async createAgent(project: ProjectConfig, name?: string): Promise<SDKAgent> {
    logger.info(
      { projectId: project.id, cwd: project.cwd, model: this.config.defaultModel.id },
      "creating new local agent",
    );
    const agent = await Agent.create({
      apiKey: this.config.cursorApiKey,
      model: this.config.defaultModel,
      ...(name ? { name } : {}),
      local: {
        cwd: project.cwd,
        settingSources: ["user", "project"],
      },
    });
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
    const agent = await Agent.resume(agentId, {
      apiKey: this.config.cursorApiKey,
      model: this.config.defaultModel,
      local: {
        cwd: project.cwd,
        settingSources: ["user", "project"],
      },
    });
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
    return await agent.send(message);
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
      const retry = err.isRetryable ? " — можно повторить" : "";
      return `Cursor SDK error${code}: ${err.message}${retry}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
