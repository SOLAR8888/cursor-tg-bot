import { InlineKeyboard } from "grammy";
import type { ProjectConfig } from "../types.js";
import type { SDKAgentInfo } from "@cursor/sdk";
import type { IdeChatInfo } from "../cursor/ide-store.js";

const TG_CALLBACK_DATA_LIMIT = 64;

// SDK agent IDs always start with "agent-". Strip the prefix in callback_data
// so we stay under Telegram's 64-byte limit for projects with longer ids.
export function shortenSdkAgentId(id: string): string {
  return id.startsWith("agent-") ? id.slice("agent-".length) : id;
}

export function restoreSdkAgentId(short: string): string {
  return short.startsWith("agent-") ? short : `agent-${short}`;
}

function assertCallbackFits(data: string): string {
  if (Buffer.byteLength(data, "utf8") > TG_CALLBACK_DATA_LIMIT) {
    // Telegram will reject the whole keyboard with BUTTON_DATA_INVALID. Throw
    // early so the bug surfaces in our logs instead of from the API.
    throw new Error(
      `callback_data exceeds ${TG_CALLBACK_DATA_LIMIT} bytes: ${data}`,
    );
  }
  return data;
}

export const CB = {
  ROOT: "root",
  PROJECTS: "projects",
  PROJECT: "project",
  CHATS: "chats",
  CHATS_MANAGE: "chats_m",
  CHAT_SDK: "csdk",
  CHAT_IDE: "cide",
  NEW_CHAT: "new_chat",
  CONTINUE_IDE: "cont_ide",
  MCP: "mcp",
  CANCEL_RUN: "cancel_run",
  HELP: "help",
  DELETE_ASK: "d",
  DELETE_YES: "dy",
  DELETE_NO: "dn",
} as const;

export type ChatKindShort = "s" | "i";

export function rootKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📁 Проекты", CB.PROJECTS)
    .row()
    .text("🔌 MCP (глобальные)", `${CB.MCP}:_global`)
    .row()
    .text("ℹ️ Помощь", CB.HELP);
}

export function projectsKeyboard(projects: readonly ProjectConfig[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(p.name, `${CB.PROJECT}:${p.id}`).row();
  }
  kb.text("⬅️ Назад", CB.ROOT);
  return kb;
}

export function projectKeyboard(projectId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Чаты", `${CB.CHATS}:${projectId}`)
    .row()
    .text("➕ Новый чат", `${CB.NEW_CHAT}:${projectId}`)
    .row()
    .text("🔌 MCP проекта", `${CB.MCP}:${projectId}`)
    .row()
    .text("⬅️ К проектам", CB.PROJECTS);
}

export function chatsKeyboard(
  projectId: string,
  sdkAgents: readonly SDKAgentInfo[],
  ideChats: readonly IdeChatInfo[],
  options: { manageMode?: boolean } = {},
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const manage = options.manageMode === true;

  if (sdkAgents.length === 0 && ideChats.length === 0) {
    kb.text("➕ Создать первый чат", `${CB.NEW_CHAT}:${projectId}`).row();
  } else {
    if (sdkAgents.length > 0) {
      for (const a of sdkAgents) {
        const status = a.status === "running" ? "🔵" : a.status === "error" ? "🔴" : "💬";
        const label = `${status} ${truncate(a.name || a.summary || a.agentId, manage ? 32 : 60)}`;
        const shortId = shortenSdkAgentId(a.agentId);
        const callback = assertCallbackFits(
          `${CB.CHAT_SDK}:${projectId}:${shortId}`,
        );
        if (manage) {
          kb.text(label, callback)
            .text(
              "🗑",
              assertCallbackFits(
                `${CB.DELETE_ASK}:${projectId}:s:${shortId}`,
              ),
            )
            .row();
        } else {
          kb.text(label, callback).row();
        }
      }
    }
    if (ideChats.length > 0) {
      for (const c of ideChats) {
        const label = `👀 ${truncate(c.name, 60)}`;
        const callback = assertCallbackFits(
          `${CB.CHAT_IDE}:${projectId}:${c.id}`,
        );
        kb.text(label, callback).row();
      }
    }
    if (manage) {
      kb.text("✅ Готово", `${CB.CHATS}:${projectId}`).row();
    } else {
      kb.text("➕ Новый чат", `${CB.NEW_CHAT}:${projectId}`)
        .text("🗑 Управление", `${CB.CHATS_MANAGE}:${projectId}`)
        .row();
    }
  }
  kb.text("⬅️ К проекту", `${CB.PROJECT}:${projectId}`);
  return kb;
}

export function deleteConfirmKeyboard(
  projectId: string,
  kind: ChatKindShort,
  chatId: string,
): InlineKeyboard {
  const shortId = kind === "s" ? shortenSdkAgentId(chatId) : chatId;
  return new InlineKeyboard()
    .text(
      "🗑️ Да, удалить",
      assertCallbackFits(
        `${CB.DELETE_YES}:${projectId}:${kind}:${shortId}`,
      ),
    )
    .text(
      "⬅️ Отмена",
      assertCallbackFits(`${CB.DELETE_NO}:${projectId}:${kind}:${shortId}`),
    );
}

export function activeChatKeyboard(projectId: string, isRunning: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (isRunning) kb.text("🛑 Отменить run", CB.CANCEL_RUN).row();
  kb.text("📋 Чаты", `${CB.CHATS}:${projectId}`)
    .text("➕ Новый", `${CB.NEW_CHAT}:${projectId}`)
    .row()
    .text("📁 Проекты", CB.PROJECTS)
    .text("🏠 Главное", CB.ROOT);
  return kb;
}

export function ideChatKeyboard(projectId: string, ideChatId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "🔄 Продолжить в боте",
      assertCallbackFits(
        `${CB.CONTINUE_IDE}:${projectId}:${ideChatId}`,
      ),
    )
    .row()
    .text("📋 Чаты", `${CB.CHATS}:${projectId}`)
    .text("➕ Новый", `${CB.NEW_CHAT}:${projectId}`)
    .row()
    .text("📁 Проекты", CB.PROJECTS)
    .text("🏠 Главное", CB.ROOT);
}

export function afterRunKeyboard(projectId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Чаты", `${CB.CHATS}:${projectId}`)
    .text("➕ Новый", `${CB.NEW_CHAT}:${projectId}`)
    .row()
    .text("📁 Проекты", CB.PROJECTS)
    .text("🏠 Главное", CB.ROOT);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
