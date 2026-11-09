import type { Request, Response } from "express";
import { getConfig } from "../../../lib/config";
import { getMongoDb } from "../repositories/mongo-client";

/**
 * Authenticated readiness probe (pilot gate, same as documents). Health
 * (`/api/health`) answers liveness only and never touches a dependency;
 * this endpoint answers "can this instance reach its database right now"
 * with a read-only ping. Responses carry no secrets or driver internals;
 * the driver message stays in the server log with its error class.
 */
export async function ready(_req: Request, res: Response): Promise<void> {
  const config = getConfig();
  // getConfig guarantees the mongodb backend and URI (the app cannot boot
  // otherwise); the guard below only narrows the type.
  const uri = config.MONGODB_URI;
  if (config.STORAGE_BACKEND !== "mongodb" || !uri) {
    throw new Error("STORAGE_BACKEND=mongodb with MONGODB_URI is required.");
  }
  const started = Date.now();
  try {
    await (await getMongoDb(uri, config.MONGODB_DB)).command({ ping: 1 });
  } catch (err) {
    console.error(
      `[ready] database unavailable: ${err instanceof Error ? `${err.constructor.name}: ${err.message}` : "unknown error"}`,
    );
    res.status(503).json({ ok: false, error: "Database unavailable." });
    return;
  }
  res.json({ ok: true, storage: "mongodb", database: config.MONGODB_DB, latencyMs: Date.now() - started });
}
