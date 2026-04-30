import type { Bot, Context } from "grammy";
import type { Run, SDKMessage } from "@cursor/sdk";
import { logger, logMessages } from "../logger.js";
import { TG_MAX_TEXT, chunkText } from "../util/chunk.js";
import { afterRunKeyboard } from "../bot/keyboards.js";
import { startOutboxWatcher } from "../bot/outbox.js";
import {
  describeToolCallCompleted,
  describeToolCallStart,
  statusEmoji,
} from "./formatter.js";

interface StreamRunOptions {
  bot: Bot<Context>;
  chatId: number;
  run: Run;
  projectId: string;
  userId?: number;
  showThinking: boolean;
  debounceMs: number;
}

interface AssistantBuffer {
  messageId: number;
  text: string;
  flushedText: string;
  pendingTimer?: NodeJS.Timeout;
}

export async function streamRun(opts: StreamRunOptions): Promise<void> {
  const { bot, chatId, run, projectId, userId, showThinking, debounceMs } =
    opts;

  const outbox = startOutboxWatcher({ bot, chatId, projectId });

  let assistant: AssistantBuffer | undefined;
  const toolMessageIds = new Map<string, number>();

  const flushAssistant = async (final: boolean): Promise<void> => {
    if (!assistant) return;
    if (assistant.text === assistant.flushedText && !final) return;
    if (assistant.pendingTimer) {
      clearTimeout(assistant.pendingTimer);
      assistant.pendingTimer = undefined;
    }
    const buf = assistant;
    const text = buf.text;
    const cursor = final ? "" : " ▋";
    const visible = (text + cursor).slice(0, TG_MAX_TEXT);
    if (visible.length === 0) return;
    try {
      await bot.api.editMessageText(chatId, buf.messageId, visible, {
        parse_mode: undefined,
      });
      buf.flushedText = text;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("message is not modified")) {
        buf.flushedText = text;
        return;
      }
      logger.warn({ err, chatId }, "failed to edit assistant message");
    }
  };

  const scheduleFlush = (): void => {
    if (!assistant) return;
    if (assistant.pendingTimer) return;
    assistant.pendingTimer = setTimeout(() => {
      assistant!.pendingTimer = undefined;
      void flushAssistant(false);
    }, debounceMs);
  };

  const startAssistantBuffer = async (): Promise<AssistantBuffer> => {
    const sent = await bot.api.sendMessage(chatId, "💬 …");
    return {
      messageId: sent.message_id,
      text: "",
      flushedText: "",
    };
  };

  const handleAssistantText = async (text: string): Promise<void> => {
    if (!text) return;
    if (!assistant) assistant = await startAssistantBuffer();
    assistant.text += text;
    if (assistant.text.length > TG_MAX_TEXT) {
      await flushAssistant(true);
      const overflow = assistant.text.slice(TG_MAX_TEXT);
      assistant = undefined;
      const parts = chunkText(overflow);
      for (const part of parts) {
        const sent = await bot.api.sendMessage(chatId, part);
        assistant = {
          messageId: sent.message_id,
          text: part,
          flushedText: part,
        };
      }
      return;
    }
    scheduleFlush();
  };

  const finishAssistantBuffer = async (): Promise<void> => {
    if (!assistant) return;
    await flushAssistant(true);
    assistant = undefined;
  };

  const handleToolCall = async (msg: Extract<SDKMessage, { type: "tool_call" }>): Promise<void> => {
    await finishAssistantBuffer();
    const existingId = toolMessageIds.get(msg.call_id);
    if (msg.status === "running") {
      if (existingId !== undefined) return;
      const text = describeToolCallStart(msg);
      try {
        const sent = await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
        toolMessageIds.set(msg.call_id, sent.message_id);
      } catch (err) {
        logger.warn({ err, name: msg.name }, "tool start send failed");
      }
      return;
    }
    const text = describeToolCallCompleted(msg);
    if (existingId !== undefined) {
      try {
        await bot.api.editMessageText(chatId, existingId, text, { parse_mode: "MarkdownV2" });
      } catch (err) {
        logger.warn({ err, name: msg.name }, "tool finish edit failed");
      }
    } else {
      try {
        await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
      } catch (err) {
        logger.warn({ err, name: msg.name }, "tool finish send failed");
      }
    }
  };

  const startedAt = Date.now();
  let lastEventAt = startedAt;
  let eventCount = 0;
  let cancelledByWatchdog = false;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    logger.warn(
      {
        projectId,
        runId: run.id,
        agentId: run.agentId,
        sinceStartMs: now - startedAt,
        sinceLastEventMs: now - lastEventAt,
        eventCount,
      },
      "stream heartbeat (no events recently)",
    );
  }, 30_000);
  // Auto-cancel a stuck run: if the SDK has not delivered any new event for
  // STALL_TIMEOUT_MS we assume the backend is hung and cancel the run so
  // the user is not stuck waiting (e.g. ~10 min) for the server timeout.
  const STALL_TIMEOUT_MS = 3 * 60 * 1000;
  const watchdog = setInterval(() => {
    if (Date.now() - lastEventAt < STALL_TIMEOUT_MS) return;
    if (cancelledByWatchdog) return;
    cancelledByWatchdog = true;
    logger.error(
      {
        projectId,
        runId: run.id,
        agentId: run.agentId,
        userId,
        sinceLastEventMs: Date.now() - lastEventAt,
        eventCount,
      },
      "stream stalled — cancelling run",
    );
    void bot.api
      .sendMessage(
        chatId,
        `⏱ Run завис — нет событий ${Math.floor(STALL_TIMEOUT_MS / 1000)}с. Отменяю и можно отправить запрос заново.`,
      )
      .catch(() => undefined);
    void run.cancel().catch((err) => {
      logger.warn({ err, runId: run.id }, "watchdog: run.cancel() failed");
    });
  }, 15_000);

  try {
    try {
      for await (const event of run.stream()) {
        eventCount += 1;
        lastEventAt = Date.now();
        const summary: Record<string, unknown> = { type: (event as { type: string }).type };
        if (event.type === "tool_call") {
          summary.name = event.name;
          summary.status = event.status;
          summary.callId = event.call_id;
        } else if (event.type === "status") {
          summary.status = event.status;
        } else if (event.type === "system") {
          summary.modelId = event.model?.id;
          summary.tools = event.tools?.length;
        } else if (event.type === "assistant") {
          const blocks = event.message?.content ?? [];
          summary.blocks = blocks.length;
          summary.kinds = blocks.map((b) => (b as { type: string }).type);
        }
        logger.debug(
          { projectId, runId: run.id, agentId: run.agentId, eventCount, ...summary },
          "stream event",
        );
        if (logMessages) {
          logger.debug({ event }, "stream event payload");
        }
        switch (event.type) {
          case "system": {
            const tools = event.tools && event.tools.length > 0
              ? ` · ${event.tools.length} tools`
              : "";
            await bot.api.sendMessage(
              chatId,
              `🟡 запуск… ${event.model?.id ?? ""}${tools}`.trim(),
            );
            break;
          }
          case "user":
            break;
          case "assistant":
            for (const block of event.message.content) {
              if (block.type === "text") {
                await handleAssistantText(block.text);
              }
            }
            break;
          case "thinking":
            if (showThinking && event.text) {
              await bot.api.sendMessage(
                chatId,
                "🧠 " + (event.text.length > 500 ? event.text.slice(0, 500) + "…" : event.text),
              );
            }
            break;
          case "tool_call":
            await handleToolCall(event);
            break;
          case "status": {
            const text = `${statusEmoji(event.status)} ${event.status}` +
              (event.message ? ` — ${event.message}` : "");
            await bot.api.sendMessage(chatId, text);
            break;
          }
          case "task":
            if (event.text) {
              await bot.api.sendMessage(chatId, "📋 " + event.text);
            }
            break;
          case "request":
            await bot.api.sendMessage(
              chatId,
              "⏸ Агент запросил подтверждение в IDE\\.",
              { parse_mode: "MarkdownV2" },
            );
            break;
        }
      }
      await finishAssistantBuffer();
      logger.info(
        {
          projectId,
          runId: run.id,
          agentId: run.agentId,
          eventCount,
          durationMs: Date.now() - startedAt,
        },
        "stream loop ended",
      );
    } catch (err) {
      await finishAssistantBuffer();
      logger.error(
        {
          err,
          projectId,
          runId: run.id,
          agentId: run.agentId,
          userId,
          eventCount,
          durationMs: Date.now() - startedAt,
        },
        "stream error",
      );
      const message = err instanceof Error ? err.message : String(err);
      await bot.api
        .sendMessage(chatId, "⚠️ Ошибка стриминга: " + message)
        .catch(() => undefined);
      return;
    }

    try {
      const result = await run.wait();
      const logPayload = {
        projectId,
        runId: run.id,
        agentId: run.agentId,
        userId,
        status: result.status,
        durationMs: result.durationMs,
        ...(result.status === "error" && result.result
          ? { errorDetail: result.result }
          : {}),
      };
      if (result.status === "error") {
        logger.error(logPayload, "run finished with error");
      } else {
        logger.info(logPayload, "run finished");
      }
      const dur = result.durationMs ? ` за ${(result.durationMs / 1000).toFixed(1)}s` : "";
      let text: string;
      switch (result.status) {
        case "finished":
          text = `🟢 Готово${dur}`;
          break;
        case "cancelled":
          text = `⚪ Отменено${dur}`;
          break;
        case "error":
          text =
            result.result && result.result.trim().length > 0
              ? `🔴 Ошибка${dur}\n\n${result.result}`
              : `🔴 Ошибка${dur}`;
          break;
      }
      if (result.git?.branches?.length) {
        const lines = result.git.branches
          .map((b) => `• ${b.repoUrl}${b.branch ? ` @ ${b.branch}` : ""}${b.prUrl ? `\n  ${b.prUrl}` : ""}`)
          .join("\n");
        text += `\n\n${lines}`;
      }
      await bot.api.sendMessage(chatId, text, {
        reply_markup: afterRunKeyboard(projectId),
      });
    } catch (err) {
      logger.warn(
        { err, projectId, runId: run.id, agentId: run.agentId, userId },
        "run.wait failed",
      );
      await bot.api
        .sendMessage(chatId, "⚠️ Не удалось получить итог run.", {
          reply_markup: afterRunKeyboard(projectId),
        })
        .catch(() => undefined);
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(watchdog);
    try {
      await outbox.stop();
    } catch (err) {
      logger.warn({ err }, "outbox stop failed");
    }
  }
}

export function summarizeStreamError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
