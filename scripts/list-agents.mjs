// Diagnostic: list local SDK agents in every project from projects.json.
// Usage: `node scripts/list-agents.mjs` (after `npm install`).
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Agent } from "@cursor/sdk";

const file = process.env.PROJECTS_FILE ?? "projects.json";
const { projects } = JSON.parse(await readFile(file, "utf8"));

let total = 0;
for (const p of projects) {
  const result = await Agent.list({ runtime: "local", cwd: p.cwd, limit: 100 });
  console.log(`\n=== ${p.name} (${p.id}) — ${result.items.length} agent(s)`);
  console.log(`    cwd=${p.cwd}`);
  for (const a of result.items) {
    const ts = new Date(a.lastModified).toISOString();
    console.log(`  • ${a.agentId}`);
    console.log(`    name=${a.name}  status=${a.status ?? "?"}  ${ts}`);
    if (a.summary) console.log(`    summary=${a.summary}`);
  }
  total += result.items.length;
}
console.log(`\nTotal: ${total} agent(s) across ${projects.length} project(s).`);
