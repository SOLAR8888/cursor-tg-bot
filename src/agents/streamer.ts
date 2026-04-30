import type { Bot, Context } from "grammy";
import type { Run, SDKMessage } from "@cursor/sdk";
import { logger, logMessages } from "../logger.js";
import { TG_MAX_TEXT, chunkText } from "../util/chunk.js";
import {
  describeToolCallCompleted,
  describeToolCallStart,
  statusEmoji,
} from "./formatter.js";

interface StreamRunOptions {
  bot: Bot<Context>;
  chatId: number;
  run: Run;
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
  const { bot, chatId, run, showThinking, debounceMs } = opts;

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

  try {
    for await (const event of run.stream()) {
      if (logMessages) {
        logger.debug({ event }, "stream event");
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
  } catch (err) {
    await finishAssistantBuffer();
    logger.error({ err }, "stream error");
    const message = err instanceof Error ? err.message : String(err);
    await bot.api
      .sendMessage(chatId, "⚠️ Ошибка стриминга: " + message)
      .catch(() => undefined);
    return;
  }

  try {
    const result = await run.wait();
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
        text = `🔴 Ошибка${dur}`;
        break;
    }
    if (result.git?.branches?.length) {
      const lines = result.git.branches
        .map((b) => `• ${b.repoUrl}${b.branch ? ` @ ${b.branch}` : ""}${b.prUrl ? `\n  ${b.prUrl}` : ""}`)
        .join("\n");
      text += `\n\n${lines}`;
    }
    await bot.api.sendMessage(chatId, text);
  } catch (err) {
    logger.warn({ err }, "run.wait failed");
  }
}

export function summarizeStreamError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
