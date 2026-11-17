import cors from "cors";
import express, { type Express } from "express";
import { loadEnv, type Env } from "./config/env.js";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/errorHandler.js";
import { createHealthRouter } from "./routes/health.js";

/** Build a configured Express application. No network I/O happens here. */
export function createApp(env: Env): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(
    cors({
      origin: env.frontendOrigin,
      methods: ["GET", "POST", "OPTIONS"],
      maxAge: 600,
    }),
  );

  app.use(
    "/api/health",
    createHealthRouter({
      mongodbUri: env.mongodbUri,
      mongodbDbName: env.mongodbDbName,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Default export for Vercel's zero-configuration Express support: Vercel
 * auto-detects this file (`src/app`) as the application entry point when the
 * project root is `backend/`. Local development uses `src/server.ts`, which
 * imports this same app and starts an HTTP listener.
 */
const app = createApp(loadEnv());

export default app;
