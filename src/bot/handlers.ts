import type { Bot, CallbackQueryContext, CommandContext, Context } from "grammy";
import type { AgentManager } from "../agents/manager.js";
import type { AppConfig, ProjectConfig } from "../types.js";
import type { SessionStore } from "./session.js";
import { logger } from "../logger.js";
import { streamRun } from "../agents/streamer.js";
import {
  CB,
  activeChatKeyboard,
  chatsKeyboard,
  projectKeyboard,
  projectsKeyboard,
  rootKeyboard,
} from "./keyboards.js";
import { loadMcpServers, summarizeMcpEntry } from "../cursor/mcp-loader.js";

const HELP_TEXT =
  "Бот для управления Cursor-агентами в локальных проектах.\n\n" +
  "Команды:\n" +
  "  /start — главное меню\n" +
  "  /projects — список проектов\n" +
  "  /chats — чаты текущего проекта\n" +
  "  /new — новый чат в текущем проекте\n" +
  "  /cancel — отменить текущий run\n" +
  "  /status — статус run\n" +
  "  /mcp — MCP-серверы (глобальные)\n" +
  "  /help — эта справка\n\n" +
  "Чтобы начать диалог с агентом — выберите проект → чат (или «Новый чат») и просто пишите сообщения.";

export function registerHandlers(
  bot: Bot<Context>,
  config: AppConfig,
  manager: AgentManager,
  sessions: SessionStore,
): void {
  // ---------- COMMANDS ----------
  bot.command("start", async (ctx) => {
    if (ctx.from) sessions.reset(ctx.from.id);
    await ctx.reply("Главное меню:", { reply_markup: rootKeyboard() });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("projects", async (ctx) => {
    await ctx.reply("Выберите проект:", {
      reply_markup: projectsKeyboard(config.projects),
    });
  });

  bot.command("chats", async (ctx) => {
    if (!ctx.from) return;
    const session = sessions.get(ctx.from.id);
    if (!session.selectedProjectId) {
      await ctx.reply("Сначала выберите проект: /projects");
      return;
    }
    await sendChatsList(ctx, manager, session.selectedProjectId);
  });

  bot.command("new", async (ctx) => {
    if (!ctx.from) return;
    const session = sessions.get(ctx.from.id);
    if (!session.selectedProjectId) {
      await ctx.reply("Сначала выберите проект: /projects");
      return;
    }
    await startNewChatPrompt(ctx, sessions, session.selectedProjectId);
  });

  bot.command("cancel", (ctx) => handleCancel(ctx, manager, sessions));

  bot.command("status", (ctx) => handleStatus(ctx, manager, sessions, config));

  bot.command("mcp", async (ctx) => {
    if (!ctx.from) return;
    const session = sessions.get(ctx.from.id);
    if (session.selectedProjectId) {
      const project = manager.getProject(session.selectedProjectId);
      if (project) {
        await sendMcpList(ctx, project);
        return;
      }
    }
    await sendMcpList(ctx, undefined);
  });

  // ---------- CALLBACKS ----------
  bot.callbackQuery(CB.ROOT, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Главное меню:", { reply_markup: rootKeyboard() });
  });

  bot.callbackQuery(CB.PROJECTS, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Выберите проект:", {
      reply_markup: projectsKeyboard(config.projects),
    });
  });

  bot.callbackQuery(CB.HELP, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(HELP_TEXT, { reply_markup: rootKeyboard() });
  });

  bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Проект не найден", show_alert: true });
      return;
    }
    sessions.patch(ctx.from.id, {
      selectedProjectId: project.id,
      activeAgentId: undefined,
      activeRunId: undefined,
      awaitingTextFor: undefined,
    });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(formatProjectInfo(project), {
      reply_markup: projectKeyboard(project.id),
    });
  });

  bot.callbackQuery(/^chats:(.+)$/, async (ctx) => {
    const projectId = ctx.match[1];
    if (!projectId) return;
    await ctx.answerCallbackQuery();
    await sendChatsList(ctx, manager, projectId, /*edit*/ true);
  });

  bot.callbackQuery(/^chat:([^:]+):(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    const agentId = ctx.match[2];
    if (!projectId || !agentId) return;
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Проект не найден", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    sessions.patch(ctx.from.id, {
      selectedProjectId: projectId,
      activeAgentId: agentId,
      activeRunId: undefined,
      awaitingTextFor: undefined,
    });
    try {
      await manager.resumeAgent(project, agentId);
    } catch (err) {
      logger.error({ err, agentId }, "resume failed");
      await ctx.reply("Не удалось подключиться к агенту: " + manager.describeError(err));
      return;
    }
    await ctx.reply(
      `📂 *${project.name}* · агент \`${agentId}\`\n` +
        "Пишите сообщение — оно уйдёт агенту. /cancel — прервать run, /status — статус.",
      {
        parse_mode: "Markdown",
        reply_markup: activeChatKeyboard(projectId, manager.isAgentBusy(agentId)),
      },
    );
  });

  bot.callbackQuery(/^new_chat:(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    if (!projectId) return;
    await ctx.answerCallbackQuery();
    await startNewChatPrompt(ctx, sessions, projectId);
  });

  bot.callbackQuery(/^mcp:(.+)$/, async (ctx) => {
    const projectId = ctx.match[1];
    if (!projectId) return;
    await ctx.answerCallbackQuery();
    if (projectId === "_global") {
      await sendMcpList(ctx, undefined);
      return;
    }
    const project = manager.getProject(projectId);
    if (!project) return;
    await sendMcpList(ctx, project);
  });

  bot.callbackQuery(CB.CANCEL_RUN, (ctx) => handleCancel(ctx, manager, sessions));

  // ---------- TEXT MESSAGES ----------
  bot.on("message:text", async (ctx) => {
    if (!ctx.from) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const session = sessions.get(ctx.from.id);
    const projectId = session.selectedProjectId;
    if (!projectId) {
      await ctx.reply("Сначала выберите проект: /projects");
      return;
    }
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.reply("Проект не найден. /start");
      return;
    }

    let agentId = session.activeAgentId;
    let isNewChat = false;
    if (session.awaitingTextFor === "new_chat" || !agentId) {
      try {
        const created = await manager.createAgent(project);
        agentId = created.agentId;
        sessions.patch(ctx.from.id, {
          activeAgentId: agentId,
          awaitingTextFor: undefined,
        });
        isNewChat = true;
        await ctx.reply(`🆕 Новый агент \`${agentId}\``, { parse_mode: "Markdown" });
      } catch (err) {
        logger.error({ err }, "createAgent failed");
        await ctx.reply("Не удалось создать агента: " + manager.describeError(err));
        return;
      }
    }

    if (manager.isAgentBusy(agentId)) {
      await ctx.reply("⏳ Идёт активный run. Подождите завершения или /cancel.");
      return;
    }

    let agent = manager.getCachedAgent(agentId);
    if (!agent) {
      try {
        agent = await manager.resumeAgent(project, agentId);
      } catch (err) {
        logger.error({ err, agentId }, "resume on send failed");
        await ctx.reply("Не удалось подключиться к агенту: " + manager.describeError(err));
        return;
      }
    }

    let run;
    try {
      run = await manager.sendMessage(agent, text);
    } catch (err) {
      logger.error({ err }, "agent.send failed");
      await ctx.reply("Не удалось отправить сообщение агенту: " + manager.describeError(err));
      return;
    }

    manager.setActiveRun(agentId, run);
    sessions.patch(ctx.from.id, { activeRunId: run.id });
    logger.info(
      { userId: ctx.from.id, projectId, agentId, runId: run.id, isNewChat },
      "run started",
    );

    void streamRun({
      bot,
      chatId: ctx.chat.id,
      run,
      showThinking: config.showThinking,
      debounceMs: config.streamEditDebounceMs,
    }).finally(() => {
      manager.setActiveRun(agentId!, undefined);
      sessions.patch(ctx.from!.id, { activeRunId: undefined });
    });
  });

  // ---------- ERROR HANDLER ----------
  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "bot error");
  });
}

function formatProjectInfo(project: ProjectConfig): string {
  const desc = project.description ? `\n${project.description}` : "";
  return `📁 *${project.name}*\n\`${project.cwd}\`${desc}`;
}

async function sendChatsList(
  ctx: Context,
  manager: AgentManager,
  projectId: string,
  edit = false,
): Promise<void> {
  const project = manager.getProject(projectId);
  if (!project) {
    if (edit) await ctx.editMessageText("Проект не найден.");
    else await ctx.reply("Проект не найден.");
    return;
  }
  let agents;
  try {
    agents = await manager.listAgents(project);
  } catch (err) {
    logger.error({ err, projectId }, "list agents failed");
    const msg = "Не удалось получить список чатов: " + manager.describeError(err);
    if (edit) await ctx.editMessageText(msg);
    else await ctx.reply(msg);
    return;
  }
  const header = `💬 Чаты в *${project.name}* (${agents.length})`;
  const opts = {
    parse_mode: "Markdown" as const,
    reply_markup: chatsKeyboard(projectId, agents),
  };
  if (edit) await ctx.editMessageText(header, opts);
  else await ctx.reply(header, opts);
}

async function startNewChatPrompt(
  ctx: Context,
  sessions: SessionStore,
  projectId: string,
): Promise<void> {
  if (!ctx.from) return;
  sessions.patch(ctx.from.id, {
    selectedProjectId: projectId,
    awaitingTextFor: "new_chat",
    activeAgentId: undefined,
    activeRunId: undefined,
  });
  await ctx.reply(
    "✏️ Отправьте первое сообщение — будет создан новый агент в этом проекте.",
  );
}

async function handleCancel(
  ctx: Context | CommandContext<Context> | CallbackQueryContext<Context>,
  manager: AgentManager,
  sessions: SessionStore,
): Promise<void> {
  if ("answerCallbackQuery" in ctx && "callbackQuery" in ctx && ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
  }
  if (!ctx.from) return;
  const session = sessions.get(ctx.from.id);
  const agentId = session.activeAgentId;
  if (!agentId) {
    await ctx.reply("Активного чата нет.");
    return;
  }
  try {
    const cancelled = await manager.cancelActiveRun(agentId);
    await ctx.reply(cancelled ? "🛑 Run отменён." : "Активного run нет.");
  } catch (err) {
    await ctx.reply("Не удалось отменить run: " + manager.describeError(err));
  }
}

async function handleStatus(
  ctx: Context | CommandContext<Context> | CallbackQueryContext<Context>,
  manager: AgentManager,
  sessions: SessionStore,
  config: AppConfig,
): Promise<void> {
  if (!ctx.from) return;
  const session = sessions.get(ctx.from.id);
  const project = session.selectedProjectId
    ? manager.getProject(session.selectedProjectId)
    : undefined;
  const lines = [
    `Модель: \`${config.defaultModel.id}\``,
    `Проект: ${project ? `*${project.name}*` : "не выбран"}`,
    `Агент: ${session.activeAgentId ? `\`${session.activeAgentId}\`` : "нет"}`,
  ];
  if (session.activeAgentId) {
    const run = manager.getActiveRun(session.activeAgentId);
    lines.push(`Run: ${run ? run.status : "неактивен"}`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

async function sendMcpList(ctx: Context, project: ProjectConfig | undefined): Promise<void> {
  const cwd = project?.cwd ?? process.cwd();
  let entries;
  try {
    entries = await loadMcpServers(cwd);
  } catch (err) {
    logger.error({ err }, "loadMcpServers failed");
    await ctx.reply("Не удалось прочитать MCP-серверы.");
    return;
  }
  if (entries.length === 0) {
    await ctx.reply(
      project
        ? `MCP-серверов для проекта «${project.name}» не найдено.`
        : "Глобальных MCP-серверов не найдено (~/.cursor/mcp.json).",
    );
    return;
  }
  const header = project ? `🔌 MCP в *${project.name}*` : "🔌 Глобальные MCP";
  const lines = entries.map((entry) => {
    const tag = entry.source === "project" ? "[project]" : "[user]";
    return `${tag} *${entry.name}* — ${summarizeMcpEntry(entry)}`;
  });
  const text = `${header}\n\n${lines.join("\n")}`;
  await ctx.reply(text.length > 4000 ? text.slice(0, 4000) + "…" : text, {
    parse_mode: "Markdown",
  });
}
