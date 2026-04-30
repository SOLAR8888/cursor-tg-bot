import { readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { logger } from "../logger.js";
import { normalizeProjectId } from "./ide-store.js";

function sdkStoreRoot(cwd: string): string {
  return path.join(
    os.homedir(),
    ".cursor",
    "projects",
    normalizeProjectId(cwd),
    "sdk-agent-store",
  );
}

async function findSdkIndexDb(cwd: string): Promise<string | undefined> {
  const root = sdkStoreRoot(cwd);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err, root }, "failed to read sdk-agent-store");
    }
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dbPath = path.join(root, entry.name, "index.db");
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const row = db
        .prepare("SELECT 1 FROM agents WHERE workspace_ref = ? LIMIT 1")
        .get(cwd) as unknown;
      if (row) return dbPath;
    } catch (err) {
      logger.debug({ err, dbPath }, "skip non-matching sdk store");
    } finally {
      db?.close();
    }
  }
  return undefined;
}

export async function deleteSdkAgentRecords(
  cwd: string,
  agentId: string,
): Promise<boolean> {
  const dbPath = await findSdkIndexDb(cwd);
  if (!dbPath) {
    logger.warn({ cwd, agentId }, "sdk index.db not found for workspace");
    return false;
  }
  const db = new Database(dbPath);
  try {
    const tx = db.transaction((id: string) => {
      db.prepare(
        "DELETE FROM run_events WHERE run_id IN (SELECT run_id FROM runs WHERE agent_id = ?)",
      ).run(id);
      db.prepare("DELETE FROM runs WHERE agent_id = ?").run(id);
      const info = db.prepare("DELETE FROM agents WHERE agent_id = ?").run(id);
      return info.changes > 0;
    });
    const removed = tx(agentId);
    if (!removed) {
      logger.info({ agentId }, "sdk agent record not found in db");
    }
    return removed;
  } catch (err) {
    logger.error({ err, agentId, dbPath }, "failed to delete sdk agent records");
    throw err;
  } finally {
    db.close();
  }
}
