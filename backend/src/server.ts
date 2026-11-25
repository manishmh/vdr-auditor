import { analysisSettingsFromEnv } from "./ai/analysis.js";
import { metaConfigFromEnv } from "./ai/metaClient.js";
import app from "./app.js";
import { loadEnv } from "./config/env.js";
import { closeDatabase } from "./db/mongodb.js";
import { startRecoveryLoop } from "./processing/recovery.js";

/** Local HTTP server. Not used on Vercel (serverless; see src/app.ts). */
function main(): void {
  const env = loadEnv();

  const server = app.listen(env.port, () => {
    console.log(
      `vdr-auditor-backend listening on http://localhost:${env.port} (${env.nodeEnv})`,
    );
  });

  // Recover runs abandoned by an earlier process (restart, crash, code
  // reload) and keep sweeping while this process lives. Serverless
  // deployments sweep through GET/POST /api/processing/recover instead.
  let stopRecovery: (() => void) | undefined;
  if (env.mongodbUri !== undefined) {
    stopRecovery = startRecoveryLoop({
      mongodbUri: env.mongodbUri,
      mongodbDbName: env.mongodbDbName,
      meta: metaConfigFromEnv(env),
      analysis: analysisSettingsFromEnv(env),
    });
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    stopRecovery?.();
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
