import cors from "cors";
import express from "express";
import { getConfig } from "../../lib/config";
import { errorHandler, notFound } from "./middleware/errors";
import { demoRouter } from "./routes/demo";
import { documentsRouter } from "./routes/documents";
import { readyRouter } from "./routes/ready";

/**
 * Express application factory. CORS allows exactly one browser origin
 * (FRONTEND_ORIGIN, defaulting to local Next.js dev in non-production).
 * No cookies or credentials: clients authenticate with a Bearer header.
 */
export function createApp(): express.Express {
  const config = getConfig();
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  const allowedOrigin = config.FRONTEND_ORIGIN ?? "http://localhost:3000";
  app.use(
    cors({
      origin: (origin, callback) => {
        // No Origin (curl, same-origin, mobile): allow. Otherwise reflect
        // exactly the configured frontend origin and nothing else.
        if (!origin || origin === allowedOrigin) callback(null, true);
        else callback(null, false);
      },
      methods: ["GET", "POST", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/documents", documentsRouter());
  app.use("/api/demo", demoRouter());
  app.use("/api/ready", readyRouter());
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
