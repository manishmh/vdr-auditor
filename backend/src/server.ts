import app from "./app.js";
import { loadEnv } from "./config/env.js";
import { closeDatabase } from "./db/mongodb.js";

/** Local HTTP server. Not used on Vercel (serverless; see src/app.ts). */
function main(): void {
  const env = loadEnv();

  const server = app.listen(env.port, () => {
    console.log(
      `vdr-auditor-backend listening on http://localhost:${env.port} (${env.nodeEnv})`,
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => {
      void closeDatabase().finally(() => {
        process.exit(0);
      });
    });
    // Force exit if connections linger.
    setTimeout(() => {
      console.error("Shutdown timed out, forcing exit.");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
