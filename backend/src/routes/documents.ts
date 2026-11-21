import express, { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { metaConfigFromEnv } from "../ai/metaClient.js";
import { getAnalysesCollections } from "../db/analyses.js";
import { getDocumentsCollection } from "../db/documents.js";
import { getMattersCollection } from "../db/matters.js";
import { getProcessingRuns, startProcessingRun } from "../db/processing.js";
import { driveProcessingRun, PROCESSING_STALE_MS } from "../processing/driver.js";
import {
  toProcessingRunResponse,
  type ProcessingRun,
} from "../models/processing.js";
import { scheduleAfterResponse } from "../processing/scheduler.js";
import {
  extractionFailureMessage,
  runExtractionJob,
} from "../extraction/job.js";
import { getDb } from "../db/mongodb.js";
import {
  parseDocumentId,
  parseRawUpload,
  toDocumentResponse,
} from "../models/document.js";
import { parseMatterId } from "../models/matter.js";
import { deletePdf, openPdfDownload, storePdf } from "../storage/gridfs.js";
import type { Env } from "../config/env.js";

export interface DocumentsRouterOptions {
  env: Env;
}

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

function isEntityTooLarge(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "entity.too.large"
  );
}

export function createDocumentsRouter(options: DocumentsRouterOptions): Router {
  // mergeParams exposes the :id segment from the /api/matters/:id/documents mount.
  const router = Router({ mergeParams: true });

  // List documents for one matter, newest first.
  router.get("/", (req, res) => {
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
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const docs = await documents
          .find({ matterId })
          .sort({ createdAt: -1 })
          .toArray();
        res.status(200).json(docs.map(toDocumentResponse));
      } catch (err: unknown) {
        console.error("GET /api/matters/:id/documents failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Upload one PDF. The raw request body is the file; the filename travels
  // in the X-Filename header. Bytes stream into GridFS, then one metadata
  // record is inserted; a metadata failure removes the stored bytes again.
  router.post(
    "/",
    express.raw({ type: "application/pdf", limit: options.env.maxPdfBytes }),
    (req, res) => {
      const matterId = matterObjectId(requestParam(req.params, "id"));
      if (matterId === undefined) {
        res.status(400).json({
          error: "invalid_id",
          message: "Matter id must be a 24-character hex string.",
        });
        return;
      }
      const parsed = parseRawUpload(
        req.header("x-filename"),
        req.header("content-type")?.split(";")[0]?.trim(),
        req.body,
        options.env.maxPdfBytes,
      );
      if (!parsed.ok) {
        if (parsed.issues.some((issue) => issue.code === "file_too_large")) {
          res.status(413).json({
            error: "file_too_large",
            message: `File is larger than the ${options.env.maxPdfBytes}-byte limit.`,
            issues: parsed.issues,
          });
          return;
        }
        res.status(400).json({ error: "validation_error", issues: parsed.issues });
        return;
      }
      void (async () => {
        if (options.env.mongodbUri === undefined) {
          databaseUnavailable(res);
          return;
        }
        try {
          const db = await getDb(options.env.mongodbUri, options.env.mongodbDbName);
          const matters = await getMattersCollection(
            options.env.mongodbUri,
            options.env.mongodbDbName,
          );
          const matter = await matters.findOne({ _id: matterId });
          if (matter === null) {
            res.status(404).json({ error: "matter_not_found" });
            return;
          }
          const fileId = new ObjectId();
          const now = new Date();
          try {
            await storePdf(
              db,
              fileId,
              parsed.value.filename,
              parsed.value.body,
              matterId.toHexString(),
            );
          } catch (err: unknown) {
            console.error("document GridFS store failed:", err);
            databaseUnavailable(res);
            return;
          }
          try {
            const documents = await getDocumentsCollection(
              options.env.mongodbUri,
              options.env.mongodbDbName,
            );
            await documents.insertOne({
              _id: fileId,
              matterId,
              filename: parsed.value.filename,
              contentType: "application/pdf",
              sizeBytes: parsed.value.sizeBytes,
              createdAt: now,
              updatedAt: now,
              extractionStatus: "pending",
            });
          } catch (err: unknown) {
            console.error("document metadata insert failed:", err);
            await deletePdf(db, fileId).catch((cleanupErr: unknown) => {
              console.error("orphaned GridFS cleanup failed:", cleanupErr);
            });
            databaseUnavailable(res);
            return;
          }
          let processing: ProcessingRun | null = null;
          try {
            const runs = await getProcessingRuns(
              options.env.mongodbUri as string,
              options.env.mongodbDbName,
            );
            const started = await startProcessingRun(runs, matterId, fileId);
            processing = toProcessingRunResponse(started.run);
            const meta = metaConfigFromEnv(options.env);
            await scheduleAfterResponse(() =>
              driveProcessingRun(started.run._id, {
                mongodbUri: options.env.mongodbUri as string,
                mongodbDbName: options.env.mongodbDbName,
                meta,
              }),
            );
          } catch (err: unknown) {
            // Upload succeeded; processing simply did not start. The client
            // shows the document as not processed with a manual start action.
            console.error("document processing schedule failed:", err);
          }
          res.status(201).json({
            document: toDocumentResponse({
              _id: fileId,
              matterId,
              filename: parsed.value.filename,
              contentType: "application/pdf",
              sizeBytes: parsed.value.sizeBytes,
              createdAt: now,
              updatedAt: now,
              extractionStatus: "pending",
            }),
            processing,
          });
        } catch (err: unknown) {
          console.error("POST /api/matters/:id/documents failed:", err);
          databaseUnavailable(res);
        }
      })();
    },
  );

  // Download one document's bytes.
  router.get("/:docId/download", (req, res) => {
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
        const db = await getDb(options.env.mongodbUri, options.env.mongodbDbName);
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const doc = await documents.findOne({ _id: docId, matterId });
        if (doc === null) {
          res.status(404).json({ error: "document_not_found" });
          return;
        }
        res.status(200);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Length", String(doc.sizeBytes));
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${doc.filename}"`,
        );
        const stream = openPdfDownload(db, docId);
        stream.once("error", (err: unknown) => {
          console.error("document GridFS download failed:", err);
          if (!res.headersSent) {
            res.status(500).json({ error: "internal_error" });
          } else {
            res.destroy();
          }
        });
        stream.pipe(res);
      } catch (err: unknown) {
        console.error(
          "GET /api/matters/:id/documents/:docId/download failed:",
          err,
        );
        databaseUnavailable(res);
      }
    })();
  });

  // Extract text from a document's PDF bytes, synchronously. Safe to
  // retry: only a completed attempt overwrites a previous result, and a
  // failed attempt never erases an earlier successful one.
  router.post("/:docId/extract", (req, res) => {
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
        const db = await getDb(options.env.mongodbUri, options.env.mongodbDbName);
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const outcome = await runExtractionJob(documents, db, matterId, docId);
        if (!outcome.ok) {
          switch (outcome.code) {
            case "not_found":
              res.status(404).json({ error: "document_not_found" });
              return;
            case "in_progress":
              res.status(409).json({
                error: "extraction_in_progress",
                message: "Extraction is already running for this document.",
              });
              return;
            case "unavailable":
              databaseUnavailable(res);
              return;
            case "internal":
              res.status(500).json({ error: "internal_error" });
              return;
            default:
              res.status(422).json({
                error: "extraction_failed",
                code: outcome.code,
                message: extractionFailureMessage(outcome.code),
              });
              return;
          }
        }
        res.status(200).json(outcome.document);
      } catch (err: unknown) {
        console.error("POST /api/matters/:id/documents/:docId/extract failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Start or retry automatic processing for a document. Idempotent: an
  // existing active run is returned instead of duplicating work.
  router.post("/:docId/process", (req, res) => {
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
        const runs = await getProcessingRuns(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const active = await runs.findOne({ docId, active: true });
        if (active !== null) {
          const stale =
            Date.now() - active.heartbeatAt.getTime() > PROCESSING_STALE_MS;
          if (stale) {
            await runs.updateOne(
              { _id: active._id },
              { $set: { attempts: 0, heartbeatAt: new Date(), updatedAt: new Date() } },
            );
            const meta = metaConfigFromEnv(options.env);
            try {
              await scheduleAfterResponse(() =>
                driveProcessingRun(active._id, {
                  mongodbUri: options.env.mongodbUri as string,
                  mongodbDbName: options.env.mongodbDbName,
                  meta,
                }),
              );
            } catch (err: unknown) {
              console.error("processing schedule failed:", err);
            }
          }
          const current = await runs.findOne({ _id: active._id });
          res.status(200).json({
            run: toProcessingRunResponse(current ?? active),
            document: toDocumentResponse(doc),
          });
          return;
        }
        const started = await startProcessingRun(runs, matterId, docId);
        const meta = metaConfigFromEnv(options.env);
        try {
          await scheduleAfterResponse(() =>
            driveProcessingRun(started.run._id, {
              mongodbUri: options.env.mongodbUri as string,
              mongodbDbName: options.env.mongodbDbName,
              meta,
            }),
          );
        } catch (err: unknown) {
          console.error("processing schedule failed:", err);
        }
        res.status(started.created ? 201 : 200).json({
          run: toProcessingRunResponse(started.run),
          document: toDocumentResponse(doc),
        });
      } catch (err: unknown) {
        console.error("POST /api/matters/:id/documents/:docId/process failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Delete a document's bytes and its metadata record.
  router.delete("/:docId", (req, res) => {
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
        const db = await getDb(options.env.mongodbUri, options.env.mongodbDbName);
        const documents = await getDocumentsCollection(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const doc = await documents.findOne({ _id: docId, matterId });
        if (doc === null) {
          res.status(404).json({ error: "document_not_found" });
          return;
        }
        const processing = await getProcessingRuns(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        const activeRun = await processing.findOne({ docId, active: true });
        if (
          activeRun !== null &&
          Date.now() - activeRun.heartbeatAt.getTime() <= PROCESSING_STALE_MS
        ) {
          res.status(409).json({
            error: "processing_in_progress",
            message: "Cannot delete while processing is active for this document.",
          });
          return;
        }
        // Remove analysis artifacts first so a failure here leaves the
        // document fully intact and retryable.
        const { runs, findings } = await getAnalysesCollections(
          options.env.mongodbUri,
          options.env.mongodbDbName,
        );
        await findings.deleteMany({ matterId, docId });
        await runs.deleteMany({ matterId, docId });
        await processing.deleteMany({ matterId, docId });
        try {
          await deletePdf(db, docId);
        } catch (err: unknown) {
          console.error("document GridFS delete failed:", err);
          databaseUnavailable(res);
          return;
        }
        // deletePdf tolerates missing bytes, so if the record delete below
        // fails, retrying this endpoint heals the state instead of orphaning it.
        await documents.deleteOne({ _id: docId });
        res.status(204).send();
      } catch (err: unknown) {
        console.error("DELETE /api/matters/:id/documents/:docId failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Map this router's raw-body size limit to HTTP 413. Other errors pass
  // through to the application error handler.
  router.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): void => {
      if (isEntityTooLarge(err)) {
        res.status(413).json({
          error: "file_too_large",
          message: `File is larger than the ${options.env.maxPdfBytes}-byte limit.`,
        });
        return;
      }
      next(err);
    },
  );

  return router;
}
