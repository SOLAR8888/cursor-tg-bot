import type { Bot, CallbackQueryContext, CommandContext, Context } from "grammy";
import type { SDKImage } from "@cursor/sdk";
import type { AgentManager } from "../agents/manager.js";
import { deriveAgentName } from "../agents/manager.js";
import type { AppConfig, ProjectConfig } from "../types.js";
import type { SessionStore } from "./session.js";
import { logger, logMessages } from "../logger.js";
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
  restoreSdkAgentId,
  rootKeyboard,
} from "./keyboards.js";
import { loadMcpServers, summarizeMcpEntry } from "../cursor/mcp-loader.js";
import { bold, code, escapeMdV2 } from "../util/markdown.js";
import { safeEditMessageText } from "../util/telegram.js";
import path from "node:path";
import {
  buildBootstrapPrompt,
  getLastAssistantText as getLastIdeAssistantText,
  ideTranscriptsDir,
  listIdeChats,
  readTranscript,
} from "../cursor/ide-store.js";
import {
  MAX_TEXT_INLINE_SIZE,
  TelegramFileTooBigError,
  downloadTelegramFile,
  formatBinaryFileForPrompt,
  formatTextFileForPrompt,
  isImageMime,
  isTextLikeFile,
  mimeFromName,
  saveToInbox,
} from "./inbox.js";
import { isRestartInProgress, performGracefulRestart } from "./restart.js";

interface IncomingMessage {
  text: string;
  images?: SDKImage[];
}
import { buildOutboxInstruction, outboxDirForProject } from "./outbox.js";

const HELP_TEXT =
  "Bot for managing Cursor agents in local projects.\n\n" +
  "Commands:\n" +
  "  /start — main menu\n" +
  "  /projects — list of projects\n" +
  "  /chats — chats in the current project\n" +
  "  /new — start a new chat in the current project\n" +
  "  /cancel — cancel the active run\n" +
  "  /status — current run status\n" +
  "  /mcp — MCP servers (global)\n" +
  "  /restart — restart the bot process (recovers from stuck SDK state)\n" +
  "  /help — this help text\n\n" +
  "To start talking to an agent: pick a project → chat (or \"New chat\") and just send messages.";

export function registerHandlers(
  bot: Bot<Context>,
  config: AppConfig,
  manager: AgentManager,
  sessions: SessionStore,
): void {
  // ---------- COMMANDS ----------
  bot.command("start", async (ctx) => {
    if (ctx.from) sessions.reset(ctx.from.id);
    await ctx.reply("Main menu:", { reply_markup: rootKeyboard() });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("projects", async (ctx) => {
    await ctx.reply("Pick a project:", {
      reply_markup: projectsKeyboard(config.projects),
    });
  });

  bot.command("chats", async (ctx) => {
    if (!ctx.from) return;
    const session = sessions.get(ctx.from.id);
    if (!session.selectedProjectId) {
      await ctx.reply("Pick a project first: /projects");
      return;
    }
    await sendChatsList(ctx, manager, session.selectedProjectId);
  });

  bot.command("new", async (ctx) => {
    if (!ctx.from) return;
    const session = sessions.get(ctx.from.id);
    if (!session.selectedProjectId) {
      await ctx.reply("Pick a project first: /projects");
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

  bot.command("restart", (ctx) => handleRestart(ctx, bot, manager, sessions));

  // ---------- CALLBACKS ----------
  bot.callbackQuery(CB.ROOT, async (ctx) => {
    await ctx.answerCallbackQuery();
    await safeEditMessageText(ctx, "Main menu:", { reply_markup: rootKeyboard() });
  });

  bot.callbackQuery(CB.PROJECTS, async (ctx) => {
    await ctx.answerCallbackQuery();
    await safeEditMessageText(ctx, "Pick a project:", {
      reply_markup: projectsKeyboard(config.projects),
    });
  });

  bot.callbackQuery(CB.HELP, async (ctx) => {
    await ctx.answerCallbackQuery();
    await safeEditMessageText(ctx, HELP_TEXT, { reply_markup: rootKeyboard() });
  });

  bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Project not found", show_alert: true });
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
    await safeEditMessageText(ctx, formatProjectInfo(project), {
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
    const agentId = ctx.match[2] ? restoreSdkAgentId(ctx.match[2]) : undefined;
    if (!projectId || !agentId) return;
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Project not found", show_alert: true });
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
      await ctx.reply("Failed to connect to agent: " + manager.describeError(err));
      return;
    }

    await ctx.reply(`💬 *${project.name}* · SDK agent \`${agentId}\``, {
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
        "This agent has no responses yet. Send the first message.",
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
      await ctx.answerCallbackQuery({ text: "Project not found", show_alert: true });
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
      "🔄 *Transfer IDE chat to SDK*\n\n" +
        "Send your next message — a **new** SDK agent will be created with this IDE chat's history as context, " +
        "and your message will be its first.\n\n" +
        "_This is a new agent with a different id; the IDE chat will not be synced._",
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery(/^d:([^:]+):([si]):(.+)$/, async (ctx) => {
    const projectId = ctx.match[1];
    const kindShort = ctx.match[2] as "s" | "i";
    const rawChatId = ctx.match[3];
    if (!projectId || !rawChatId) return;
    const chatId = kindShort === "s" ? restoreSdkAgentId(rawChatId) : rawChatId;
    if (kindShort === "i") {
      await ctx.answerCallbackQuery({
        text: "IDE chats can't be deleted — Cursor uses their transcripts.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🗑️ *Delete SDK chat?*\n\`${chatId}\`\n\n_This action cannot be undone._`,
      {
        parse_mode: "Markdown",
        reply_markup: deleteConfirmKeyboard(projectId, kindShort, chatId),
      },
    );
  });

  bot.callbackQuery(/^dn:([^:]+):([si]):(.+)$/, async (ctx) => {
    const projectId = ctx.match[1];
    if (!projectId) return;
    await ctx.answerCallbackQuery({ text: "Cancelled" });
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
    const rawChatId = ctx.match[3];
    if (!projectId || !rawChatId) return;
    const chatId = kindShort === "s" ? restoreSdkAgentId(rawChatId) : rawChatId;
    if (kindShort === "i") {
      await ctx.answerCallbackQuery({
        text: "IDE chats can't be deleted.",
        show_alert: true,
      });
      return;
    }
    const project = manager.getProject(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Project not found", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await manager.deleteSdkAgent(project, chatId);
    } catch (err) {
      logger.error({ err, chatId }, "delete chat failed");
      await ctx.reply("Failed to delete chat: " + manager.describeError(err));
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
    await ctx.reply(`✅ Chat deleted: \`${chatId}\``, { parse_mode: "Markdown" });
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

  // ---------- USER MESSAGES (text / photo / document) ----------
  bot.on("message:text", async (ctx) => {
    if (!ctx.from) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    await dispatchUserMessage(ctx, bot, config, manager, sessions, { text });
  });

  bot.on("message:photo", async (ctx) => {
    if (!ctx.from) return;
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (!largest) return;
    let downloaded;
    try {
      downloaded = await downloadTelegramFile(bot, largest.file_id);
    } catch (err) {
      if (err instanceof TelegramFileTooBigError) {
        await ctx.reply("📎 " + err.message);
        return;
      }
      logger.error({ err }, "photo download failed");
      await ctx.reply("Failed to download photo: " + (err as Error).message);
      return;
    }
    const caption = ctx.message.caption?.trim() ?? "";
    const text = caption.length > 0 ? caption : "What's in this image?";
    await dispatchUserMessage(ctx, bot, config, manager, sessions, {
      text,
      images: [{ data: downloaded.buf.toString("base64"), mimeType: "image/jpeg" }],
    });
  });

  bot.on("message:document", async (ctx) => {
    if (!ctx.from) return;
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const doc = ctx.message.document;
    if (!doc) return;
    const fileName = doc.file_name ?? `file-${doc.file_id.slice(0, 8)}`;
    const mime = doc.mime_type ?? mimeFromName(fileName);
    let downloaded;
    try {
      downloaded = await downloadTelegramFile(bot, doc.file_id);
    } catch (err) {
      if (err instanceof TelegramFileTooBigError) {
        await ctx.reply("📎 " + err.message);
        return;
      }
      logger.error({ err, fileName }, "document download failed");
      await ctx.reply("Failed to download file: " + (err as Error).message);
      return;
    }

    const caption = ctx.message.caption?.trim() ?? "";

    // Image-document: send as image to the agent.
    if (isImageMime(mime)) {
      const text = caption.length > 0 ? caption : "What's in this image?";
      await dispatchUserMessage(ctx, bot, config, manager, sessions, {
        text,
        images: [
          { data: downloaded.buf.toString("base64"), mimeType: mime ?? "image/png" },
        ],
      });
      return;
    }

    const projectId = sessions.get(ctx.from.id).selectedProjectId
      ?? (config.projects.length === 1 ? config.projects[0]?.id : undefined);

    // Text-like and small enough — embed in prompt.
    if (
      isTextLikeFile(mime, fileName) &&
      downloaded.size <= MAX_TEXT_INLINE_SIZE
    ) {
      let content: string;
      try {
        content = downloaded.buf.toString("utf8");
      } catch (err) {
        logger.warn({ err, fileName }, "document utf8 decode failed; treating as binary");
        content = "";
      }
      if (content.length > 0) {
        await dispatchUserMessage(ctx, bot, config, manager, sessions, {
          text: formatTextFileForPrompt(fileName, caption, content),
        });
        return;
      }
    }

    // Fallback: save to inbox, give agent the absolute path.
    if (!projectId) {
      await ctx.reply("Pick a project first: /projects");
      return;
    }
    let savedPath;
    try {
      savedPath = await saveToInbox(projectId, fileName, downloaded.buf);
    } catch (err) {
      logger.error({ err, fileName }, "saveToInbox failed");
      await ctx.reply("Failed to save file: " + (err as Error).message);
      return;
    }
    await dispatchUserMessage(ctx, bot, config, manager, sessions, {
      text: formatBinaryFileForPrompt(fileName, savedPath, caption, downloaded.size),
    });
  });

  bot.on("message:audio", async (ctx) => {
    const a = ctx.message.audio;
    if (!a) return;
    const fromMeta = [a.performer, a.title].filter(Boolean).join(" - ").trim();
    const name =
      a.file_name ??
      (fromMeta.length > 0 ? `${fromMeta}.mp3` : `audio-${a.file_id.slice(0, 8)}.mp3`);
    await dispatchAttachedMedia(ctx, bot, config, manager, sessions, {
      fileId: a.file_id,
      fileName: name,
      mimeType: a.mime_type,
      defaultPrompt:
        "An audio file is attached. Describe what's in it if you can — otherwise ask for a transcript.",
    });
  });

  bot.on("message:voice", async (ctx) => {
    const v = ctx.message.voice;
    if (!v) return;
    await dispatchAttachedMedia(ctx, bot, config, manager, sessions, {
      fileId: v.file_id,
      fileName: `voice-${v.file_id.slice(0, 8)}.ogg`,
      mimeType: v.mime_type ?? "audio/ogg",
      defaultPrompt:
        "A voice message is attached. If you have a transcription tool — transcribe it, otherwise ask the user to send text.",
    });
  });

  bot.on("message:video", async (ctx) => {
    const v = ctx.message.video;
    if (!v) return;
    await dispatchAttachedMedia(ctx, bot, config, manager, sessions, {
      fileId: v.file_id,
      fileName: v.file_name ?? `video-${v.file_id.slice(0, 8)}.mp4`,
      mimeType: v.mime_type ?? "video/mp4",
      defaultPrompt:
        "A video is attached. Describe what's in it if you have a video-analysis tool.",
    });
  });

  bot.on("message:video_note", async (ctx) => {
    const v = ctx.message.video_note;
    if (!v) return;
    await dispatchAttachedMedia(ctx, bot, config, manager, sessions, {
      fileId: v.file_id,
      fileName: `video-note-${v.file_id.slice(0, 8)}.mp4`,
      mimeType: "video/mp4",
      defaultPrompt:
        "A round video message is attached. Describe what's in it if you have a video-analysis tool.",
    });
  });
}

interface AttachedMediaOptions {
  fileId: string;
  fileName: string;
  mimeType: string | undefined;
  defaultPrompt: string;
}

async function dispatchAttachedMedia(
  ctx: Context,
  bot: Bot<Context>,
  config: AppConfig,
  manager: AgentManager,
  sessions: SessionStore,
  opts: AttachedMediaOptions,
): Promise<void> {
  if (!ctx.from) return;
  await ctx.replyWithChatAction("typing").catch(() => undefined);
  let downloaded;
  try {
    downloaded = await downloadTelegramFile(bot, opts.fileId);
  } catch (err) {
    if (err instanceof TelegramFileTooBigError) {
      await ctx.reply("📎 " + err.message);
      return;
    }
    logger.error({ err, fileName: opts.fileName }, "media download failed");
    await ctx.reply("Failed to download file: " + (err as Error).message);
    return;
  }
  const projectId =
    sessions.get(ctx.from.id).selectedProjectId ??
    (config.projects.length === 1 ? config.projects[0]?.id : undefined);
  if (!projectId) {
    await ctx.reply("Pick a project first: /projects");
    return;
  }
  let savedPath;
  try {
    savedPath = await saveToInbox(projectId, opts.fileName, downloaded.buf);
  } catch (err) {
    logger.error({ err, fileName: opts.fileName }, "saveToInbox failed");
    await ctx.reply("Failed to save file: " + (err as Error).message);
    return;
  }
  const caption = ctx.message?.caption?.trim() ?? "";
  const prompt = caption.length > 0 ? caption : opts.defaultPrompt;
  await dispatchUserMessage(ctx, bot, config, manager, sessions, {
    text: formatBinaryFileForPrompt(opts.fileName, savedPath, prompt, downloaded.size),
  });
}

async function dispatchUserMessage(
  ctx: Context,
  bot: Bot<Context>,
  config: AppConfig,
  manager: AgentManager,
  sessions: SessionStore,
  incoming: IncomingMessage,
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const text = incoming.text;
  const images = incoming.images;

  const session = sessions.get(ctx.from.id);
  let projectId = session.selectedProjectId;
  if (!projectId) {
    if (config.projects.length === 1 && config.projects[0]) {
      projectId = config.projects[0].id;
      sessions.patch(ctx.from.id, { selectedProjectId: projectId });
    } else {
      await ctx.reply("Pick a project first: /projects");
      return;
    }
  }
  const project = manager.getProject(projectId);
  if (!project) {
    await ctx.reply("Project not found. /start");
    return;
  }

  if (session.activeChatKind === "ide" && session.awaitingText?.kind !== "continue_ide") {
    await ctx.reply(
      "👀 This is an IDE chat — read-only. Tap *🔄 Continue in bot* to create an SDK copy.",
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
      `Open a chat in *${project.name}*: /chats — or tap "➕ New chat" to start a new one.`,
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
      await ctx.reply("Failed to read IDE chat history: " + (err as Error).message);
      return;
    }
    outgoingText = buildBootstrapPrompt(transcript, text);
    await ctx.reply(
      `🔄 Creating an SDK agent with IDE chat history (${transcript.length} msgs)…`,
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
      await ctx.reply(`🆕 New chat: *${name}*\n\`${agentId}\``, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      logger.error({ err }, "createAgent failed");
      await ctx.reply("Failed to create agent: " + manager.describeError(err));
      return;
    }
  }

  if (isNewChat) {
    const outboxDir = outboxDirForProject(project.id);
    outgoingText = `${buildOutboxInstruction(outboxDir)}\n\n${outgoingText}`;
  }

  if (manager.isAgentBusy(agentId)) {
    await ctx.reply("⏳ A run is already active. Wait for it to finish or /cancel.");
    return;
  }

  let agent = manager.getCachedAgent(agentId);
  if (!agent) {
    try {
      agent = await manager.resumeAgent(project, agentId);
    } catch (err) {
      logger.error({ err, agentId }, "resume on send failed");
      await ctx.reply("Failed to connect to agent: " + manager.describeError(err));
      return;
    }
  }

  const sdkMessage =
    images && images.length > 0 ? { text: outgoingText, images } : outgoingText;
  let run;
  try {
    run = await manager.sendMessage(agent, sdkMessage);
  } catch (err) {
    logger.error({ err }, "agent.send failed");
    await ctx.reply("Failed to send message to agent: " + manager.describeError(err));
    return;
  }

  manager.setActiveRun(agentId, run);
  sessions.patch(ctx.from.id, { activeRunId: run.id });
  logger.info(
    {
      userId: ctx.from.id,
      projectId,
      agentId,
      runId: run.id,
      isNewChat,
      hasImages: Boolean(images?.length),
      promptLen: outgoingText.length,
      ...(logMessages
        ? { promptPreview: outgoingText.slice(0, 240) }
        : {}),
    },
    "run started",
  );

  void streamRun({
    bot,
    chatId: ctx.chat.id,
    run,
    projectId,
    userId: ctx.from.id,
    showThinking: config.showThinking,
    debounceMs: config.streamEditDebounceMs,
  }).finally(() => {
    manager.setActiveRun(agentId!, undefined);
    sessions.patch(ctx.from!.id, { activeRunId: undefined });
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
    if (edit) await safeEditMessageText(ctx, "Project not found.");
    else await ctx.reply("Project not found.");
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
    ? "_Tap the 🗑 next to a chat to delete it._"
    : `_💬 SDK: ${sdkAgents.length} · 👀 IDE: ${ideChats.length}_`;
  const header = `${titleIcon} Chats in *${project.name}* (${total})\n${subtitle}`;

  const opts = {
    parse_mode: "Markdown" as const,
    reply_markup: chatsKeyboard(projectId, sdkAgents, ideChats, { manageMode }),
  };
  if (edit) await safeEditMessageText(ctx, header, opts);
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
    await ctx.reply("Failed to read IDE chat: " + (err as Error).message);
    return;
  }
  const lastText = getLastIdeAssistantText(transcript);
  const userMessageCount = transcript.filter((e) => e.role === "user").length;
  const assistantMessageCount = transcript.filter((e) => e.role === "assistant").length;

  await ctx.reply(
    `👀 *${project.name}* · IDE chat \`${ideChatId}\`\n` +
      `_${userMessageCount} user · ${assistantMessageCount} assistant msgs. Read-only._`,
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
    await ctx.reply("This IDE chat has no assistant replies.", {
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
    "✏️ Send your first message — a new agent will be created in this project.",
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
    await ctx.reply("No active chat.");
    return;
  }
  try {
    const cancelled = await manager.cancelActiveRun(agentId);
    await ctx.reply(cancelled ? "🛑 Run cancelled." : "No active run.");
  } catch (err) {
    await ctx.reply("Failed to cancel run: " + manager.describeError(err));
  }
}

async function handleRestart(
  ctx: CommandContext<Context>,
  bot: Bot<Context>,
  manager: AgentManager,
  sessions: SessionStore,
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;

  if (isRestartInProgress()) {
    await ctx.reply("🔄 Restart already in progress…");
    return;
  }

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  let placeholderMessageId: number | undefined;
  try {
    const sent = await ctx.reply(
      "🔄 *Restarting bot…*\n_All active runs will be aborted. " +
        "I'll ping you here once I'm back up._",
      { parse_mode: "Markdown" },
    );
    placeholderMessageId = sent.message_id;
  } catch (err) {
    logger.warn({ err }, "restart: failed to send placeholder; continuing");
  }

  logger.info(
    { userId, chatId, messageId: placeholderMessageId },
    "restart: requested via /restart",
  );

  void performGracefulRestart({
    bot,
    manager,
    sessions,
    request: {
      userId,
      chatId,
      requestedAt: Date.now(),
      ...(placeholderMessageId !== undefined
        ? { messageId: placeholderMessageId }
        : {}),
    },
  });
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
    `Model: \`${config.defaultModel.id}\``,
    `Project: ${project ? `*${project.name}*` : "not selected"}`,
    `Active chat: ${session.activeAgentId ? `${kind} \`${session.activeAgentId}\`` : "none"}`,
  ];
  if (session.activeAgentId && session.activeChatKind === "sdk") {
    const run = manager.getActiveRun(session.activeAgentId);
    lines.push(`Run: ${run ? run.status : "inactive"}`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

const TELEGRAM_MAX_TEXT = 4000;

async function sendMcpList(ctx: Context, project: ProjectConfig | undefined): Promise<void> {
  const cwd = project?.cwd ?? process.cwd();
  let entries;
  try {
    entries = await loadMcpServers(cwd);
  } catch (err) {
    logger.error({ err }, "loadMcpServers failed");
    await ctx.reply("Failed to read MCP servers.");
    return;
  }
  if (entries.length === 0) {
    await ctx.reply(
      project
        ? `No MCP servers found for "${project.name}".`
        : "No global MCP servers found (~/.cursor/mcp.json).",
    );
    return;
  }

  const header = project
    ? `🔌 MCP in ${bold(project.name)}`
    : `🔌 ${bold("Global MCP")}`;
  const lines = entries.map((entry) => {
    const tag = entry.source === "project" ? "\\[project\\]" : "\\[user\\]";
    const dash = escapeMdV2(" — ");
    return `${tag} ${bold(entry.name)}${dash}${code(summarizeMcpEntry(entry))}`;
  });

  let body = "";
  let truncated = false;
  for (const line of lines) {
    const projected = header.length + 2 + (body.length ? body.length + 1 : 0) + line.length + 4;
    if (projected > TELEGRAM_MAX_TEXT) {
      truncated = true;
      break;
    }
    body += (body ? "\n" : "") + line;
  }
  const text = `${header}\n\n${body}` + (truncated ? "\n…" : "");

  try {
    await ctx.reply(text, { parse_mode: "MarkdownV2" });
  } catch (err) {
    logger.warn({ err }, "MCP list MarkdownV2 send failed, falling back to plain text");
    const plainLines = entries.map((entry) => {
      const tag = entry.source === "project" ? "[project]" : "[user]";
      return `${tag} ${entry.name} — ${summarizeMcpEntry(entry)}`;
    });
    const plainHeader = project ? `🔌 MCP in ${project.name}` : "🔌 Global MCP";
    const plain = `${plainHeader}\n\n${plainLines.join("\n")}`;
    await ctx.reply(plain.length > TELEGRAM_MAX_TEXT ? plain.slice(0, TELEGRAM_MAX_TEXT) + "…" : plain);
  }
}
