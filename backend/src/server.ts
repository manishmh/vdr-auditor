import { getConfig } from "../../lib/config";
import { createApp } from "./app";
import { getStore } from "./context";

/**
 * Local server entry point (`npm run dev:api` / `npm run start:api`).
 * Fails fast on invalid configuration or an unreachable database; never
 * prints connection strings or secrets.
 */
async function main(): Promise<void> {
  const config = getConfig();
  if (config.STORAGE_BACKEND === "mongodb") {
    try {
      await getStore();
    } catch (err) {
      console.error(
        `[api] cannot reach MongoDB database "${config.MONGODB_DB}": ${err instanceof Error ? err.message : "unknown error"}`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.info(`[api] listening port=${config.PORT} backend=${config.STORAGE_BACKEND}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
