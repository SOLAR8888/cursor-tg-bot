import type { Bot, CallbackQueryContext, CommandContext, Context } from "grammy";
import type { AgentManager } from "../agents/manager.js";
import { deriveAgentName } from "../agents/manager.js";
import type { AppConfig, ProjectConfig } from "../types.js";
import type { SessionStore } from "./session.js";
import { logger } from "../logger.js";
import { streamRun } from "../agents/streamer.js";
import { chunkText } from "../util/chunk.js";
import {
  CB,
  activeChatKeyboard,
  chatsKeyboard,
  deleteConfirmKeyboard,
  ideChatKeyboard,
  projectKeyboard,
  projectsKeyboard,
  rootKeyboard,
} from "./keyboards.js";
import { loadMcpServers, summarizeMcpEntry } from "../cursor/mcp-loader.js";
import path from "node:path";
import {
  buildBootstrapPrompt,
  getLastAssistantText as getLastIdeAssistantText,
  ideTranscriptsDir,
  listIdeChats,
  readTranscript,
} from "../cursor/ide-store.js";

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
      activeChatKind: undefined,
      activeRunId: undefined,
      awaitingText: undefined,
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
    await sendChatsList(ctx, manager, projectId, { edit: true });
  });

  bot.callbackQuery(/^chats_m:(.+)$/, async (ctx) => {
    const projectId = ctx.match[1];
    if (!projectId) return;
    await ctx.answerCallbackQuery();
    await sendChatsList(ctx, manager, projectId, { edit: true, manageMode: true });
  });

  bot.callbackQuery(/^csdk:([^:]+):(.+)$/, async (ctx) => {
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
      activeChatKind: "sdk",
      activeRunId: undefined,
      awaitingText: undefined,
    });
    try {
      await manager.resumeAgent(project, agentId);
    } catch (err) {
      logger.error({ err, agentId }, "resume failed");
      await ctx.reply("Не удалось подключиться к агенту: " + manager.describeError(err));
      return;
    }

    await ctx.reply(`💬 *${project.name}* · SDK-агент \`${agentId}\``, {
      parse_mode: "Markdown",
    });

    const lastText = await manager.getLastAssistantText(project, agentId);
    if (lastText) {
      const parts = chunkText(lastText);
      const lastIdx = parts.length - 1;
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === lastIdx;
        await ctx.reply(parts[i] ?? "", {
          ...(isLast
            ? {
                reply_markup: activeChatKeyboard(
                  projectId,
                  manager.isAgentBusy(agentId),
                ),
              }
            : {}),
        });
      }
    } else {
      await ctx.reply(
        "У этого агента ещё нет ответов. Напишите первое сообщение.",
        {
          reply_markup: activeChatKeyboard(projectId, manager.isAgentBusy(agentId)),
        },
      );
    }
  });

  bot.callbackQuery(/^cide:([^:]+):(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    const ideChatId = ctx.match[2];
    if (!projectId || !ideChatId) return;
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Проект не найден", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    sessions.patch(ctx.from.id, {
      selectedProjectId: projectId,
      activeAgentId: ideChatId,
      activeChatKind: "ide",
      activeRunId: undefined,
      awaitingText: undefined,
    });

    await openIdeChat(ctx, project, ideChatId);
  });

  bot.callbackQuery(/^cont_ide:([^:]+):(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    const ideChatId = ctx.match[2];
    if (!projectId || !ideChatId) return;
    await ctx.answerCallbackQuery();
    sessions.patch(ctx.from.id, {
      selectedProjectId: projectId,
      activeAgentId: undefined,
      activeChatKind: undefined,
      activeRunId: undefined,
      awaitingText: { kind: "continue_ide", ideChatId },
    });
    await ctx.reply(
      "🔄 *Перенос IDE-чата в SDK*\n\n" +
        "Отправьте следующее сообщение — будет создан **новый** SDK-агент с историей этого IDE-чата как контекстом, " +
        "и ваше сообщение уйдёт в него первым.\n\n" +
        "_Это новый агент с другим id; в IDE-чате синхронизации не будет._",
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery(/^d:([^:]+):([si]):(.+)$/, async (ctx) => {
    const projectId = ctx.match[1];
    const kindShort = ctx.match[2] as "s" | "i";
    const chatId = ctx.match[3];
    if (!projectId || !chatId) return;
    if (kindShort === "i") {
      await ctx.answerCallbackQuery({
        text: "IDE-чаты удалять нельзя — Cursor использует их транскрипты.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🗑️ *Удалить SDK-чат?*\n\`${chatId}\`\n\n_Это действие нельзя отменить._`,
      {
        parse_mode: "Markdown",
        reply_markup: deleteConfirmKeyboard(projectId, kindShort, chatId),
      },
    );
  });

  bot.callbackQuery(/^dn:([^:]+):([si]):(.+)$/, async (ctx) => {
    const projectId = ctx.match[1];
    if (!projectId) return;
    await ctx.answerCallbackQuery({ text: "Отменено" });
    try {
      await ctx.deleteMessage();
    } catch {
      // confirmation was edited, ignore
    }
    await sendChatsList(ctx, manager, projectId, { manageMode: true });
  });

  bot.callbackQuery(/^dy:([^:]+):([si]):(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    const kindShort = ctx.match[2] as "s" | "i";
    const chatId = ctx.match[3];
    if (!projectId || !chatId) return;
    if (kindShort === "i") {
      await ctx.answerCallbackQuery({
        text: "IDE-чаты удалять нельзя.",
        show_alert: true,
      });
      return;
    }
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Проект не найден", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await manager.deleteSdkAgent(project, chatId);
    } catch (err) {
      logger.error({ err, chatId }, "delete chat failed");
      await ctx.reply("Не удалось удалить чат: " + manager.describeError(err));
      return;
    }

    const session = sessions.get(ctx.from.id);
    if (session.activeAgentId === chatId) {
      sessions.patch(ctx.from.id, {
        activeAgentId: undefined,
        activeChatKind: undefined,
        activeRunId: undefined,
        awaitingText: undefined,
      });
    }

    logger.info(
      { userId: ctx.from.id, projectId, chatId, kind: kindShort },
      "chat deleted",
    );

    try {
      await ctx.deleteMessage();
    } catch {
      // ignore
    }
    await ctx.reply(`✅ Чат удалён: \`${chatId}\``, { parse_mode: "Markdown" });
    await sendChatsList(ctx, manager, projectId, { manageMode: true });
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
    let projectId = session.selectedProjectId;
    if (!projectId) {
      if (config.projects.length === 1 && config.projects[0]) {
        projectId = config.projects[0].id;
        sessions.patch(ctx.from.id, { selectedProjectId: projectId });
      } else {
        await ctx.reply("Сначала выберите проект: /projects");
        return;
      }
    }
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.reply("Проект не найден. /start");
      return;
    }

    if (session.activeChatKind === "ide" && session.awaitingText?.kind !== "continue_ide") {
      await ctx.reply(
        "👀 Это IDE-чат — он read-only. Нажмите *🔄 Продолжить в боте*, чтобы создать SDK-копию.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    let agentId = session.activeAgentId;
    let isNewChat = false;
    const awaiting = session.awaitingText;
    const isContinueIde = awaiting?.kind === "continue_ide";
    const explicitNewChat = awaiting?.kind === "new_chat";

    if (!agentId && !explicitNewChat && !isContinueIde) {
      await ctx.reply(
        `Откройте чат в проекте *${project.name}*: /chats — или нажмите «➕ Новый чат», чтобы начать новый.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    let outgoingText = text;
    if (isContinueIde && awaiting?.kind === "continue_ide") {
      const ideChatId = awaiting.ideChatId;
      const transcriptPath = path.join(
        ideTranscriptsDir(project.cwd),
        ideChatId,
        `${ideChatId}.jsonl`,
      );
      let transcript;
      try {
        transcript = await readTranscript(transcriptPath, { tail: 60 });
      } catch (err) {
        logger.error({ err, ideChatId }, "readTranscript failed");
        await ctx.reply("Не удалось прочитать историю IDE-чата: " + (err as Error).message);
        return;
      }
      outgoingText = buildBootstrapPrompt(transcript, text);
      await ctx.reply(
        `🔄 Создаю SDK-агента с историей IDE-чата (${transcript.length} сообщ.)…`,
      );
    }

    if (explicitNewChat || isContinueIde || !agentId) {
      const name = deriveAgentName(text);
      try {
        const created = await manager.createAgent(project, name);
        agentId = created.agentId;
        sessions.patch(ctx.from.id, {
          activeAgentId: agentId,
          activeChatKind: "sdk",
          awaitingText: undefined,
        });
        isNewChat = true;
        await ctx.reply(`🆕 Новый чат: *${name}*\n\`${agentId}\``, {
          parse_mode: "Markdown",
        });
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
      run = await manager.sendMessage(agent, outgoingText);
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
      projectId,
      showThinking: config.showThinking,
      debounceMs: config.streamEditDebounceMs,
    }).finally(() => {
      manager.setActiveRun(agentId!, undefined);
      sessions.patch(ctx.from!.id, { activeRunId: undefined });
    });
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
  options: { edit?: boolean; manageMode?: boolean } = {},
): Promise<void> {
  const { edit = false, manageMode = false } = options;
  const project = manager.getProject(projectId);
  if (!project) {
    if (edit) await ctx.editMessageText("Проект не найден.");
    else await ctx.reply("Проект не найден.");
    return;
  }
  const [sdkResult, ideResult] = await Promise.allSettled([
    manager.listAgentsWithNames(project),
    listIdeChats(project.cwd),
  ]);

  if (sdkResult.status === "rejected") {
    logger.error({ err: sdkResult.reason, projectId }, "list sdk agents failed");
  }
  if (ideResult.status === "rejected") {
    logger.error({ err: ideResult.reason, projectId }, "list ide chats failed");
  }

  const sdkAgents = sdkResult.status === "fulfilled" ? sdkResult.value : [];
  const ideChats = ideResult.status === "fulfilled" ? ideResult.value : [];
  const total = sdkAgents.length + ideChats.length;

  const titleIcon = manageMode ? "🗑" : "💬";
  const subtitle = manageMode
    ? "_Тапните 🗑 справа от чата, чтобы удалить._"
    : `_💬 SDK: ${sdkAgents.length} · 👀 IDE: ${ideChats.length}_`;
  const header = `${titleIcon} Чаты в *${project.name}* (${total})\n${subtitle}`;

  const opts = {
    parse_mode: "Markdown" as const,
    reply_markup: chatsKeyboard(projectId, sdkAgents, ideChats, { manageMode }),
  };
  if (edit) await ctx.editMessageText(header, opts);
  else await ctx.reply(header, opts);
}

async function openIdeChat(
  ctx: Context,
  project: ProjectConfig,
  ideChatId: string,
): Promise<void> {
  const transcriptPath = path.join(
    ideTranscriptsDir(project.cwd),
    ideChatId,
    `${ideChatId}.jsonl`,
  );
  let transcript;
  try {
    transcript = await readTranscript(transcriptPath);
  } catch (err) {
    logger.error({ err, ideChatId }, "openIdeChat read failed");
    await ctx.reply("Не удалось прочитать IDE-чат: " + (err as Error).message);
    return;
  }
  const lastText = getLastIdeAssistantText(transcript);
  const userMessageCount = transcript.filter((e) => e.role === "user").length;
  const assistantMessageCount = transcript.filter((e) => e.role === "assistant").length;

  await ctx.reply(
    `👀 *${project.name}* · IDE-чат \`${ideChatId}\`\n` +
      `_${userMessageCount} user · ${assistantMessageCount} assistant сообщ. Read-only._`,
    { parse_mode: "Markdown" },
  );

  if (lastText) {
    const parts = chunkText(lastText);
    const lastIdx = parts.length - 1;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === lastIdx;
      await ctx.reply(parts[i] ?? "", {
        ...(isLast ? { reply_markup: ideChatKeyboard(project.id, ideChatId) } : {}),
      });
    }
  } else {
    await ctx.reply("В этом IDE-чате нет ответов ассистента.", {
      reply_markup: ideChatKeyboard(project.id, ideChatId),
    });
  }
}

async function startNewChatPrompt(
  ctx: Context,
  sessions: SessionStore,
  projectId: string,
): Promise<void> {
  if (!ctx.from) return;
  sessions.patch(ctx.from.id, {
    selectedProjectId: projectId,
    awaitingText: { kind: "new_chat" },
    activeAgentId: undefined,
    activeChatKind: undefined,
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
  const kind = session.activeChatKind === "ide" ? "👀 IDE" : "💬 SDK";
  const lines = [
    `Модель: \`${config.defaultModel.id}\``,
    `Проект: ${project ? `*${project.name}*` : "не выбран"}`,
    `Активный чат: ${session.activeAgentId ? `${kind} \`${session.activeAgentId}\`` : "нет"}`,
  ];
  if (session.activeAgentId && session.activeChatKind === "sdk") {
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
