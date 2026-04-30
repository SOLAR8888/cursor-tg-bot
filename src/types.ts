import type { ModelSelection } from "@cursor/sdk";

export interface ProjectConfig {
  id: string;
  name: string;
  cwd: string;
  description?: string;
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
