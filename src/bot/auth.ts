import type { Context, MiddlewareFn } from "grammy";
import { logger } from "../logger.js";

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
