import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { analysisSettingsFromEnv } from "../ai/analysis.js";
import { runAnalysisJob } from "../ai/job.js";
import { metaConfigFromEnv } from "../ai/metaClient.js";
import { getAnalysesCollections } from "../db/analyses.js";
import { getDocumentsCollection } from "../db/documents.js";
import { getMattersCollection } from "../db/matters.js";
import { PAGE_SEPARATOR } from "../extraction/service.js";
import {
  parseReviewStatusUpdate,
  toAnalysisRunResponse,
  toFindingResponse,
} from "../models/analysis.js";
import { parseDocumentId } from "../models/document.js";
import { parseMatterId } from "../models/matter.js";
import { PROCESSING_BUDGET_MS } from "../processing/driver.js";
import type { Env } from "../config/env.js";

export interface AnalysesRouterOptions {
  env: Env;
}

// Re-exported for route tests that seed extraction output consistently.
export { PAGE_SEPARATOR as ANALYSIS_PAGE_SEPARATOR };

function databaseUnavailable(res: Response): void {
  res.status(503).json({
    error: "database_unavailable",
    message: "The database is not reachable. Try again later.",
  });
}

function requestParam(params: object, name: string): unknown {
  return (params as Record<string, unknown>)[name];
}

function matterObjectId(rawId: unknown): ObjectId | undefined {
  return typeof rawId === "string" ? parseMatterId(rawId) : undefined;
}

function documentObjectId(rawId: unknown): ObjectId | undefined {
  return typeof rawId === "string" ? parseDocumentId(rawId) : undefined;
}

export function createAnalysesRouter(options: AnalysesRouterOptions): Router {
  // mergeParams exposes the :id segment from the /api/matters/:id mount.
  const router = Router({ mergeParams: true });

  // Start (and synchronously complete) an analysis run for one document.
  router.post("/documents/:docId/analysis", (req, res) => {
    const matterId = matterObjectId(requestParam(req.params, "id"));
    const docId = documentObjectId(req.params.docId);
    if (matterId === undefined || docId === undefined) {
      res.status(400).json({
        error: "invalid_id",
        message: "Matter and document ids must be 24-character hex strings.",
      });
      return;
    }
    void (async () => {
      const meta = metaConfigFromEnv(options.env);
      if (meta === undefined) {
        res.status(503).json({
          error: "analysis_unconfigured",
          message: "AI analysis is not configured.",
        });
        return;
      }
      if (options.env.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const { runs, findings } = await getAnalysesCollections(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const outcome = await runAnalysisJob({
          documents,
          analyses: { runs, findings },
          meta,
          matterId,
          docId,
          deadlineMs: Date.now() + PROCESSING_BUDGET_MS,
          analysis: analysisSettingsFromEnv(options.env),
        });
        if (!outcome.ok) {
          switch (outcome.code) {
            case "not_found":
              res.status(404).json({ error: "document_not_found" });
              return;
            case "in_progress":
              res.status(409).json({
                error: "analysis_in_progress",
                message: "Analysis is already running for this document.",
              });
              return;
            case "no_usable_text":
              res.status(422).json({
                error: "no_usable_text",
                message: "This document has no usable extracted text to analyze.",
              });
              return;
            default:
              res.status(503).json({
                error: "analysis_failed",
                message: "Analysis failed. Try again.",
              });
              return;
          }
        }
        res.status(200).json({ run: outcome.run, findings: outcome.findings });
      } catch (err: unknown) {
        console.error("POST /api/matters/:id/documents/:docId/analysis failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Latest analysis state plus current findings for one document.
  router.get("/documents/:docId/analysis", (req, res) => {
    const matterId = matterObjectId(requestParam(req.params, "id"));
    const docId = documentObjectId(req.params.docId);
    if (matterId === undefined || docId === undefined) {
      res.status(400).json({
        error: "invalid_id",
        message: "Matter and document ids must be 24-character hex strings.",
      });
      return;
    }
    void (async () => {
      if (options.env.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const doc = await documents.findOne({ _id: docId, matterId });
        if (doc === null) {
          res.status(404).json({ error: "document_not_found" });
          return;
        }
        const { runs, findings } = await getAnalysesCollections(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const allRuns = await runs
          .find({ matterId, docId })
          .sort({ startedAt: -1 })
          .toArray();
        const latest = allRuns[0] ?? null;
        const current = allRuns.find(
          (run) => run.status === "completed" || run.status === "limited",
        );
        const items =
          current === undefined
            ? []
            : await findings.find({ runId: current._id }).toArray();
        res.status(200).json({
          run: latest === null ? null : toAnalysisRunResponse(latest),
          findings: items.map((finding) => toFindingResponse(finding, doc.filename)),
        });
      } catch (err: unknown) {
        console.error("GET /api/matters/:id/documents/:docId/analysis failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Full analysis history for one document, newest first.
  router.get("/documents/:docId/analyses", (req, res) => {
    const matterId = matterObjectId(requestParam(req.params, "id"));
    const docId = documentObjectId(req.params.docId);
    if (matterId === undefined || docId === undefined) {
      res.status(400).json({
        error: "invalid_id",
        message: "Matter and document ids must be 24-character hex strings.",
      });
      return;
    }
    void (async () => {
      if (options.env.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const doc = await documents.findOne({ _id: docId, matterId });
        if (doc === null) {
          res.status(404).json({ error: "document_not_found" });
          return;
        }
        const { runs } = await getAnalysesCollections(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const allRuns = await runs
          .find({ matterId, docId })
          .sort({ startedAt: -1 })
          .toArray();
        res.status(200).json({
          analyses: allRuns.map((run) => toAnalysisRunResponse(run)),
        });
      } catch (err: unknown) {
        console.error("GET /api/matters/:id/documents/:docId/analyses failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Latest analysis run per analyzed document in a matter.
  router.get("/analyses", (req, res) => {
    const matterId = matterObjectId(requestParam(req.params, "id"));
    if (matterId === undefined) {
      res.status(400).json({
        error: "invalid_id",
        message: "Matter id must be a 24-character hex string.",
      });
      return;
    }
    void (async () => {
      if (options.env.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const matters = await getMattersCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const matter = await matters.findOne({ _id: matterId });
        if (matter === null) {
          res.status(404).json({ error: "matter_not_found" });
          return;
        }
        const { runs } = await getAnalysesCollections(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const allRuns = await runs.find({ matterId }).sort({ startedAt: -1 }).toArray();
        const latestByDoc = new Map<string, (typeof allRuns)[number]>();
        for (const run of allRuns) {
          const key = run.docId.toHexString();
          if (!latestByDoc.has(key)) {
            latestByDoc.set(key, run);
          }
        }
        const docs = await documents
          .find({
            _id: { $in: [...latestByDoc.keys()].map((id) => new ObjectId(id)) },
          })
          .toArray();
        const names = new Map(docs.map((doc) => [doc._id.toHexString(), doc.filename]));
        res.status(200).json({
          analyses: [...latestByDoc.values()].map((run) => ({
            ...toAnalysisRunResponse(run),
            filename: names.get(run.docId.toHexString()),
          })),
        });
      } catch (err: unknown) {
        console.error("GET /api/matters/:id/analyses failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // All current findings for a matter, newest runs first.
  router.get("/findings", (req, res) => {
    const matterId = matterObjectId(requestParam(req.params, "id"));
    if (matterId === undefined) {
      res.status(400).json({
        error: "invalid_id",
        message: "Matter id must be a 24-character hex string.",
      });
      return;
    }
    void (async () => {
      if (options.env.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const matters = await getMattersCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const matter = await matters.findOne({ _id: matterId });
        if (matter === null) {
          res.status(404).json({ error: "matter_not_found" });
          return;
        }
        const { runs, findings } = await getAnalysesCollections(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const allRuns = await runs.find({ matterId }).sort({ startedAt: -1 }).toArray();
        const currentRunIds = new Set<string>();
        const seenDocs = new Set<string>();
        // Latest successful run per document: a failed or still-running
        // attempt never hides the previous verified results. The run
        // endpoints surface the latest attempt's status separately, so the
        // UI can identify results as coming from an earlier success.
        for (const run of allRuns) {
          const key = run.docId.toHexString();
          if (seenDocs.has(key)) {
            continue;
          }
          if (run.status === "completed" || run.status === "limited") {
            seenDocs.add(key);
            currentRunIds.add(run._id.toHexString());
          }
        }
        const items =
          currentRunIds.size === 0
            ? []
            : await findings
                .find({
                  matterId,
                  runId: {
                    $in: [...currentRunIds].map((id) => new ObjectId(id)),
                  },
                })
                .sort({ createdAt: -1 })
                .toArray();
        const docs = await documents
          .find({
            _id: {
              $in: [...new Set(items.map((finding) => finding.docId.toHexString()))].map(
                (id) => new ObjectId(id),
              ),
            },
          })
          .toArray();
        const names = new Map(docs.map((doc) => [doc._id.toHexString(), doc.filename]));
        res.status(200).json(
          items.map((finding) =>
            toFindingResponse(finding, names.get(finding.docId.toHexString())),
          ),
        );
      } catch (err: unknown) {
        console.error("GET /api/matters/:id/findings failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Update one finding's review status.
  router.patch("/findings/:findingId", (req, res) => {
    const matterId = matterObjectId(requestParam(req.params, "id"));
    const rawFindingId: unknown = req.params.findingId;
    const findingId =
      typeof rawFindingId === "string" ? parseDocumentId(rawFindingId) : undefined;
    if (matterId === undefined || findingId === undefined) {
      res.status(400).json({
        error: "invalid_id",
        message: "Matter and finding ids must be 24-character hex strings.",
      });
      return;
    }
    const parsed = parseReviewStatusUpdate(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: "validation_error", issues: parsed.issues });
      return;
    }
    void (async () => {
      if (options.env.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const { findings } = await getAnalysesCollections(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const finding = await findings.findOne({ _id: findingId, matterId });
        if (finding === null) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const updatedAt = new Date();
        await findings.updateOne(
          { _id: findingId },
          { $set: { reviewStatus: parsed.value.reviewStatus, updatedAt } },
        );
        res.status(200).json(
          toFindingResponse({ ...finding, reviewStatus: parsed.value.reviewStatus, updatedAt }),
        );
      } catch (err: unknown) {
        console.error("PATCH /api/matters/:id/findings/:findingId failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  return router;
}
