import type { ModelSelection } from "@cursor/sdk";

export interface ProjectConfig {
  id: string;
  name: string;
  cwd: string;
  description?: string;
  /**
   * Optional per-project allowlist. If set, only these Telegram user IDs can
   * see and interact with the project. If omitted, the project is visible to
   * every user in the global `ALLOWED_USER_IDS` allowlist.
   *
   * Per-project users must also be in the global allowlist — the global
   * whitelist middleware always runs first.
   */
  allowedUserIds?: ReadonlySet<number>;
}

export interface AppConfig {
  telegramBotToken: string;
  cursorApiKey: string;
  allowedUserIds: ReadonlySet<number>;
  projects: readonly ProjectConfig[];
  defaultModel: ModelSelection;
  showThinking: boolean;
  streamEditDebounceMs: number;
}

export type AwaitingText =
  | { kind: "new_chat" }
  | { kind: "continue_ide"; ideChatId: string };

export interface UserSession {
  userId: number;
  selectedProjectId?: string;
  activeAgentId?: string;
  activeChatKind?: "sdk" | "ide";
  activeRunId?: string;
  awaitingText?: AwaitingText;
}
