import type { Context, MiddlewareFn } from "grammy";
import { logger } from "../logger.js";
import type { ProjectConfig } from "../types.js";

export function whitelistMiddleware(
  allowedUserIds: ReadonlySet<number>,
): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !allowedUserIds.has(userId)) {
      logger.warn(
        {
          userId: userId ?? null,
          username: ctx.from?.username ?? null,
          chatId: ctx.chat?.id ?? null,
          updateType: ctx.update.update_id,
        },
        "rejected unauthorized update",
      );
      return;
    }
    await next();
  };
}

/**
 * Returns true when the project has no per-project allowlist, or when the
 * user is on it. The global whitelist is enforced separately by
 * `whitelistMiddleware`.
 */
export function isProjectVisibleToUser(
  project: ProjectConfig,
  userId: number,
): boolean {
  return !project.allowedUserIds || project.allowedUserIds.has(userId);
}

export function visibleProjectsForUser(
  projects: readonly ProjectConfig[],
  userId: number,
): readonly ProjectConfig[] {
  return projects.filter((p) => isProjectVisibleToUser(p, userId));
}
