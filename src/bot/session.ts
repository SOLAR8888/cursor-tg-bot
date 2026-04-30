import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";
import type { UserSession } from "../types.js";

const SESSIONS_FILE = path.resolve("data", "sessions.json");
const SAVE_DEBOUNCE_MS = 200;

export class SessionStore {
  private readonly map = new Map<number, UserSession>();
  private saveTimer?: NodeJS.Timeout;
  private savePromise?: Promise<void>;

  async load(): Promise<void> {
    try {
      const raw = await readFile(SESSIONS_FILE, "utf8");
      const parsed = JSON.parse(raw) as Record<string, UserSession>;
      for (const [id, session] of Object.entries(parsed)) {
        const num = Number(id);
        if (Number.isInteger(num)) {
          this.map.set(num, { ...session, userId: num });
        }
      }
      logger.info({ count: this.map.size }, "sessions loaded");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        logger.info("no sessions file yet, starting fresh");
        return;
      }
      logger.warn({ err }, "failed to load sessions");
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.savePromise = this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.savePromise) {
      try {
        await this.savePromise;
      } catch {
        // previous save failure already logged
      }
    }
    const obj: Record<string, UserSession> = {};
    for (const [id, session] of this.map) {
      obj[String(id)] = session;
    }
    try {
      await mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
      await writeFile(SESSIONS_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch (err) {
      logger.warn({ err }, "failed to save sessions");
    }
  }

  get(userId: number): UserSession {
    let session = this.map.get(userId);
    if (!session) {
      session = { userId };
      this.map.set(userId, session);
    }
    return session;
  }

  patch(userId: number, patch: Partial<UserSession>): UserSession {
    const session = this.get(userId);
    Object.assign(session, patch);
    this.scheduleSave();
    return session;
  }

  reset(userId: number): void {
    this.map.set(userId, { userId });
    this.scheduleSave();
  }

  entries(): IterableIterator<[number, UserSession]> {
    return this.map.entries();
  }
}
