import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { analysisSettingsFromEnv } from "../ai/analysis.js";
import { metaConfigFromEnv } from "../ai/metaClient.js";
import { getDocumentsCollection } from "../db/documents.js";
import { getMattersCollection } from "../db/matters.js";
import { getProcessingRuns } from "../db/processing.js";
import {
  toProcessingRunResponse,
  type ProcessingRun,
} from "../models/processing.js";
import { parseMatterId } from "../models/matter.js";
import { recoverProcessingRuns } from "../processing/recovery.js";
import type { Env } from "../config/env.js";

export interface ProcessingRouterOptions {
  env: Env;
}

/** Terminal runs stay visible for a day so failures are never missed. */
const RECENT_TERMINAL_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS = 50;

export interface ProcessingRunSummary extends ProcessingRun {
  matterTitle?: string;
  filename?: string;
}

function databaseUnavailable(res: Response): void {
  res.status(503).json({
    error: "database_unavailable",
    message: "The database is not reachable. Try again later.",
  });
}

export function createProcessingRouter(options: ProcessingRouterOptions): Router {
  const router = Router();

  // Active runs plus recently finished ones, optionally scoped to a matter.
  // Powers the global progress indicator; read-only, never drives work.
  router.get("/", (req, res) => {
    const rawMatterId: unknown = req.query.matterId;
    let matterId: ObjectId | undefined;
    if (rawMatterId !== undefined) {
      if (typeof rawMatterId !== "string") {
        res.status(400).json({
          error: "invalid_id",
          message: "Matter id must be a 24-character hex string.",
        });
        return;
      }
      matterId = parseMatterId(rawMatterId);
      if (matterId === undefined) {
        res.status(400).json({
          error: "invalid_id",
          message: "Matter id must be a 24-character hex string.",
        });
        return;
      }
    }
    void (async () => {
      if (options.env.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const runs = await getProcessingRuns(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const scope = matterId === undefined ? {} : { matterId };
        const items = await runs
          .find({
            ...scope,
            $or: [
              { active: true },
              { finishedAt: { $gte: new Date(Date.now() - RECENT_TERMINAL_MS) } },
            ],
          })
          .sort({ updatedAt: -1 })
          .limit(MAX_RUNS)
          .toArray();
        const matters = await getMattersCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const matterDocs = await matters
          .find({
            _id: { $in: [...new Set(items.map((run) => run.matterId.toHexString()))].map((id) => new ObjectId(id)) },
          })
          .toArray();
        const docs = await documents
          .find({
            _id: { $in: [...new Set(items.map((run) => run.docId.toHexString()))].map((id) => new ObjectId(id)) },
          })
          .toArray();
        const titles = new Map(
          matterDocs.map((matter) => [matter._id.toHexString(), matter.title]),
        );
        const filenames = new Map(docs.map((doc) => [doc._id.toHexString(), doc.filename]));
        const summaries: ProcessingRunSummary[] = items.map((run) => ({
          ...toProcessingRunResponse(run),
          matterTitle: titles.get(run.matterId.toHexString()),
          filename: filenames.get(run.docId.toHexString()),
        }));
        res.status(200).json({ runs: summaries });
      } catch (err: unknown) {
        console.error("GET /api/processing failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Drive abandoned runs toward a terminal stage. Idempotent and safe to
  // call on a schedule: claiming arbitrates concurrent sweepers. Accepts
  // GET for cron-style schedulers (Vercel Cron issues GET) as well as POST.
  // Long-lived servers sweep automatically; serverless deployments should
  // hit this endpoint on a schedule (see README).
  const recover = (_req: unknown, res: Response): void => {
    void (async () => {
      if (options.env.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const result = await recoverProcessingRuns({
          mongodbUri: options.env.mongodbUri,
          mongodbDbName: options.env.mongodbDbName,
          meta: metaConfigFromEnv(options.env),
          analysis: analysisSettingsFromEnv(options.env),
        });
        res.status(200).json(result);
      } catch (err: unknown) {
        console.error("POST /api/processing/recover failed:", err);
        databaseUnavailable(res);
      }
    })();
  };
  router.get("/recover", recover);
  router.post("/recover", recover);

  return router;
}
