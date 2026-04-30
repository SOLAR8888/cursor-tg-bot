import { InlineKeyboard } from "grammy";
import type { ProjectConfig } from "../types.js";
import type { SDKAgentInfo } from "@cursor/sdk";

export const CB = {
  ROOT: "root",
  PROJECTS: "projects",
  PROJECT: "project",
  CHATS: "chats",
  CHAT: "chat",
  NEW_CHAT: "new_chat",
  MCP: "mcp",
  CANCEL_RUN: "cancel_run",
  HELP: "help",
} as const;

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
  agents: readonly SDKAgentInfo[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (agents.length === 0) {
    kb.text("➕ Создать первый чат", `${CB.NEW_CHAT}:${projectId}`).row();
  } else {
    for (const a of agents) {
      const status = a.status === "running" ? "🔵" : a.status === "error" ? "🔴" : "·";
      const label = `${status} ${truncate(a.name || a.summary || a.agentId, 40)}`;
      kb.text(label, `${CB.CHAT}:${projectId}:${a.agentId}`).row();
    }
    kb.text("➕ Новый чат", `${CB.NEW_CHAT}:${projectId}`).row();
  }
  kb.text("⬅️ К проекту", `${CB.PROJECT}:${projectId}`);
  return kb;
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
