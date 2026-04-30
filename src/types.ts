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

export interface UserSession {
  userId: number;
  selectedProjectId?: string;
  activeAgentId?: string;
  activeRunId?: string;
  awaitingTextFor?: "new_chat" | undefined;
}
