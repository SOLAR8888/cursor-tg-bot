import type { Bot, Context } from "grammy";
import { Agent } from "@cursor/sdk";
import type { AgentManager } from "./manager.js";
import type { SessionStore } from "../bot/session.js";
import { logger } from "../logger.js";
import { chunkText } from "../util/chunk.js";
import { afterRunKeyboard } from "../bot/keyboards.js";
import { isProjectVisibleToUser } from "../bot/auth.js";

const RECOVERY_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export async function recoverActiveRuns(
  bot: Bot<Context>,
  manager: AgentManager,
  sessions: SessionStore,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [userId, session] of sessions.entries()) {
    if (
      session.activeChatKind !== "sdk" ||
      !session.activeRunId ||
      !session.activeAgentId ||
      !session.selectedProjectId
    ) {
      continue;
    }
    const project = manager.getProject(session.selectedProjectId);
    if (!project) continue;
    if (!isProjectVisibleToUser(project, userId)) {
      logger.info(
        { userId, projectId: project.id },
        "recovery: user no longer has access to project; clearing active run",
      );
      sessions.patch(userId, { activeRunId: undefined });
      continue;
    }
    tasks.push(
      recoverOneRun(
        bot,
        sessions,
        userId,
        project.cwd,
        project.id,
        session.activeAgentId,
        session.activeRunId,
      ),
    );
  }
  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, "starting run recovery");
    void Promise.allSettled(tasks);
  }
}

async function recoverOneRun(
  bot: Bot<Context>,
  sessions: SessionStore,
  userId: number,
  cwd: string,
  projectId: string,
  agentId: string,
  runId: string,
): Promise<void> {
  let run;
  try {
    run = await Agent.getRun(runId, { runtime: "local", cwd });
  } catch (err) {
    logger.warn({ err, runId }, "recovery: getRun failed, clearing session");
    sessions.patch(userId, { activeRunId: undefined });
    return;
  }

  if (run.status !== "running") {
    logger.info({ runId, status: run.status }, "recovery: run already finished");
    sessions.patch(userId, { activeRunId: undefined });
    return;
  }

  logger.info({ runId, agentId, userId }, "recovery: run still running, waiting");
  await bot.api
    .sendMessage(
      userId,
      "🔄 The bot restarted during your run. Waiting for it to finish…",
    )
    .catch(() => undefined);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, RECOVERY_WAIT_TIMEOUT_MS);

  let result;
  try {
    result = await Promise.race([
      run.wait(),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), RECOVERY_WAIT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot wait on a detached running run")) {
      logger.info(
        { runId },
        "recovery: detached run cannot be awaited; clearing session",
      );
      sessions.patch(userId, { activeRunId: undefined });
      return;
    }
    logger.warn({ err, runId }, "recovery: run.wait() failed");
    result = null;
  }
  clearTimeout(timer);

  sessions.patch(userId, { activeRunId: undefined });

  if (!result || timedOut) {
    await bot.api
      .sendMessage(
        userId,
        "⚠️ Run is still active 5 minutes after restart. " +
          "Send any message in this chat — the bot will automatically abort the stuck run and start a new one.",
        { reply_markup: afterRunKeyboard(projectId) },
      )
      .catch(() => undefined);
    return;
  }

  const text =
    result.result && result.result.trim().length > 0
      ? result.result
      : `Run finished with status ${result.status}.`;
  const parts = chunkText(text);
  const lastIdx = parts.length - 1;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === lastIdx;
    try {
      await bot.api.sendMessage(userId, parts[i] ?? "", {
        ...(isLast ? { reply_markup: afterRunKeyboard(projectId) } : {}),
      });
    } catch (err) {
      logger.warn({ err, userId }, "recovery: sendMessage failed");
    }
  }
}
