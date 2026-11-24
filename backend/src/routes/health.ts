import { Router } from "express";
import { pingDatabase } from "../db/mongodb.js";

export const SERVICE_NAME = "vdr-auditor-backend";

export interface HealthRouterOptions {
  mongodbUri: string | undefined;
  mongodbDbName: string;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function createHealthRouter(options: HealthRouterOptions): Router {
  const router = Router();

  // Liveness: the process is running. Never touches the database. The
  // runtime version is operational metadata (like the service name): it
  // proves which Node version a deployment actually runs on.
  router.get("/", (_req, res) => {
    res.status(200).json({
      service: SERVICE_NAME,
      status: "ok",
      node: process.versions.node,
      timestamp: timestamp(),
    });
  });

  // Readiness: performs a real MongoDB ping. Reports connected only when
  // the ping succeeds; a configured URI alone is never enough.
  router.get("/ready", (_req, res) => {
    void (async () => {
      if (options.mongodbUri === undefined) {
        res.status(503).json({
          service: SERVICE_NAME,
          status: "not_ready",
          database: "unconfigured",
          timestamp: timestamp(),
        });
        return;
      }
      try {
        await pingDatabase(options.mongodbUri, options.mongodbDbName);
        res.status(200).json({
          service: SERVICE_NAME,
          status: "ready",
          database: "connected",
          timestamp: timestamp(),
        });
      } catch {
        // Deliberately generic: never leak URIs, credentials, or driver errors.
        res.status(503).json({
          service: SERVICE_NAME,
          status: "not_ready",
          database: "unavailable",
          timestamp: timestamp(),
        });
      }
    })();
  });

  return router;
}
