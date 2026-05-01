import type { Context } from "grammy";
import { GrammyError } from "grammy";

function isNotModifiedError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return err.description?.includes("message is not modified") ?? false;
  }
  return (err as Error)?.message?.includes("message is not modified") ?? false;
}

/**
 * Wraps `ctx.editMessageText` and silently swallows Telegram's
 * `400: Bad Request: message is not modified` response, which is
 * thrown whenever the user re-clicks an inline button that would
 * leave the message body and reply markup unchanged (e.g. tapping
 * "Help" while already on the Help screen).
 *
 * Any other error is re-thrown so real failures still surface.
 */
export async function safeEditMessageText(
  ctx: Context,
  ...args: Parameters<Context["editMessageText"]>
): Promise<void> {
  try {
    await ctx.editMessageText(...args);
  } catch (err) {
    if (isNotModifiedError(err)) return;
    throw err;
  }
}
