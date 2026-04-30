import { logger } from "../dist/logger.js";

logger.info({ smoke: true }, "smoke test info");
logger.warn({ smoke: true }, "smoke test warn");
logger.error({ smoke: true, err: new Error("smoke test error") }, "smoke test error");

await new Promise((r) => setTimeout(r, 500));
process.exit(0);
