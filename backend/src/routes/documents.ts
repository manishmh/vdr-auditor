import express, { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { analysisSettingsFromEnv, type AnalysisSettings } from "../ai/analysis.js";
import { metaConfigFromEnv, type MetaConfig } from "../ai/metaClient.js";
import { getAnalysesCollections } from "../db/analyses.js";
import { getDocumentsCollection, markUploadInterrupted } from "../db/documents.js";
import { getMattersCollection } from "../db/matters.js";
import { getProcessingRuns, startProcessingRun } from "../db/processing.js";
import { driveProcessingRun, PROCESSING_STALE_MS } from "../processing/driver.js";
import { toProcessingRunResponse } from "../models/processing.js";
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

/**
 * Reject byte-dependent actions on documents whose upload never finished
 * persisting. Fresh records are still being stored (409: wait and retry);
 * failed ones can never heal (422: delete and re-upload). Returns true when
 * the response was handled.
 */
function rejectUnstoredBytes(
  res: Response,
  doc: { bytesStored?: boolean; extractionStatus?: string },
): boolean {
  if (doc.bytesStored !== false) {
    return false;
  }
  if (doc.extractionStatus === "failed") {
    res.status(422).json({
      error: "upload_incomplete",
      message: "This file didn't finish uploading. Delete it and upload it again.",
    });
    return true;
  }
  res.status(409).json({
    error: "upload_in_progress",
    message: "This file is still uploading. Wait a moment and try again.",
  });
  return true;
}

function isEntityTooLarge(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "entity.too.large"
  );
}

/** One satisfiable byte range with HTTP (inclusive) bounds. */
export interface PdfByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range` header against a known body size. Returns
 * undefined when the header is absent or should be leniently ignored
 * (malformed, multi-range): callers then serve the full body with 200.
 * Returns "unsatisfiable" when the range starts past the last byte: 416.
 * Suffix (`bytes=-N`) and open-ended (`bytes=N-`) forms are supported; the
 * end is clamped to the last byte.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): PdfByteRange | "unsatisfiable" | undefined {
  if (header === undefined || size <= 0) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) {
    return undefined;
  }
  const first = match[1] as string;
  const last = match[2] as string;
  if (first === "") {
    const suffix = Number.parseInt(last, 10);
    if (!Number.isInteger(suffix) || suffix <= 0) {
      return undefined;
    }
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number.parseInt(first, 10);
  if (!Number.isInteger(start) || start >= size) {
    return start >= size ? "unsatisfiable" : undefined;
  }
  if (last === "") {
    return { start, end: size - 1 };
  }
  const end = Number.parseInt(last, 10);
  if (!Number.isInteger(end) || end < start) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

export interface PersistUploadInput {
  mongodbUri: string;
  mongodbDbName: string;
  meta: MetaConfig | undefined;
  analysis: AnalysisSettings;
  matterId: ObjectId;
  fileId: ObjectId;
  filename: string;
  body: Buffer;
}

/**
 * Finish an accepted upload after the 201 response: stream the buffered
 * bytes into GridFS, flip the record to stored, then start processing. The
 * client already went away happy, so every outcome must converge server
 * state on its own: store failures fail the record as interrupted (nothing
 * to retry against — the bytes only existed in this task), and a document
 * deleted mid-store gets its orphaned bytes cleaned instead of resurrected.
 * Never throws: the scheduler already guards, and double-logging helps no
 * one — each failure is logged once, here, with its own scope.
 */
export async function persistUploadAndStart(input: PersistUploadInput): Promise<void> {
  const { mongodbUri, mongodbDbName, meta, analysis, matterId, fileId } = input;
  let db;
  try {
    db = await getDb(mongodbUri, mongodbDbName);
  } catch (err: unknown) {
    console.error("upload persist database unavailable:", err);
    return;
  }
  try {
    await storePdf(db, fileId, input.filename, input.body, matterId.toHexString());
  } catch (err: unknown) {
    console.error("upload bytes persist failed:", err);
    await markUploadInterrupted(mongodbUri, mongodbDbName, fileId);
    return;
  }
  try {
    const documents = await getDocumentsCollection(mongodbUri, mongodbDbName);
    const marked = await documents.updateOne(
      { _id: fileId, bytesStored: false },
      { $set: { bytesStored: true, updatedAt: new Date() } },
    );
    if (marked.matchedCount === 0) {
      // Deleted mid-upload: remove the orphaned bytes again.
      await deletePdf(db, fileId).catch((cleanupErr: unknown) => {
        console.error("orphaned GridFS cleanup failed:", cleanupErr);
      });
      return;
    }
  } catch (err: unknown) {
    // Bytes are stored but the flag is not; the recovery sweep fails the
    // record as interrupted, and deleting it removes the bytes again.
    console.error("upload stored-flag persist failed:", err);
    return;
  }
  try {
    const runs = await getProcessingRuns(mongodbUri, mongodbDbName);
    const started = await startProcessingRun(runs, matterId, fileId);
    // This already runs detached from the response, so drive inline: no
    // second scheduling hop. A killed process leaves a queued run for the
    // recovery sweep, exactly like the old schedule-then-drive path.
    await driveProcessingRun(started.run._id, {
      mongodbUri,
      mongodbDbName,
      meta,
      analysis,
    });
  } catch (err: unknown) {
    console.error("document processing schedule failed:", err);
  }
}

export function createDocumentsRouter(options: DocumentsRouterOptions): Router {
  // mergeParams exposes the :id segment from the /api/matters/:id/documents mount.
  const router = Router({ mergeParams: true });

  // List documents for one matter, newest first. Pass
  // `?includeText=false` to omit extracted text (polling, dashboards);
  // fetch one document's text on demand from GET /:docId/text instead.
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
        if (req.query.includeText === "false") {
          res.status(200).json(
            docs.map((doc) => {
              const { extractedText: _dropped, ...rest } = toDocumentResponse(doc);
              return rest;
            }),
          );
          return;
        }
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
          const matters = await getMattersCollection(
            options.env.mongodbUri,
            options.env.mongodbDbName,
          );
          const matter = await matters.findOne({ _id: matterId });
          if (matter === null) {
            res.status(404).json({ error: "matter_not_found" });
            return;
          }
          // Accept durably, persist in the background: the 201 only waits
          // for the small metadata insert, never for the multi-megabyte
          // GridFS streaming write (slow uplinks used to push the response
          // past client and serverless timeouts even though the work
          // completed). Clients discover the stored bytes and the
          // processing run through their normal polling.
          const fileId = new ObjectId();
          const now = new Date();
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
              bytesStored: false,
            });
          } catch (err: unknown) {
            console.error("document metadata insert failed:", err);
            databaseUnavailable(res);
            return;
          }
          try {
            await scheduleAfterResponse(() =>
              persistUploadAndStart({
                mongodbUri: options.env.mongodbUri as string,
                mongodbDbName: options.env.mongodbDbName,
                meta: metaConfigFromEnv(options.env),
                analysis: analysisSettingsFromEnv(options.env),
                matterId,
                fileId,
                filename: parsed.value.filename,
                body: parsed.value.body,
              }),
            );
          } catch (err: unknown) {
            // Nothing was scheduled; the recovery sweep fails the
            // bytes-less record as interrupted so it never sits in limbo.
            console.error("document upload persist scheduling failed:", err);
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
              bytesStored: false,
            }),
            processing: null,
          });
        } catch (err: unknown) {
          console.error("POST /api/matters/:id/documents failed:", err);
          databaseUnavailable(res);
        }
      })();
    },
  );

  // Download one document's bytes. Serves single HTTP ranges (206) so
  // in-browser viewers can page into large PDFs, and honors `?inline=1`
  // for display instead of attachment download. Malformed or multi-range
  // requests fall back to the full body; only out-of-bounds ranges 416.
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
        if (rejectUnstoredBytes(res, doc)) {
          return;
        }
        const inline = req.query.inline === "1";
        const range = parseRangeHeader(req.header("range") ?? undefined, doc.sizeBytes);
        if (range === "unsatisfiable") {
          res.status(416);
          res.setHeader("Content-Range", `bytes */${doc.sizeBytes}`);
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Accept-Ranges", "bytes");
        // Range-aware viewers run cross-origin (fetch), so they must be
        // allowed to read the range framing headers.
        res.setHeader(
          "Access-Control-Expose-Headers",
          "Accept-Ranges, Content-Range, Content-Length, Content-Disposition",
        );
        res.setHeader(
          "Content-Disposition",
          `${inline ? "inline" : "attachment"}; filename="${doc.filename}"`,
        );
        if (range !== undefined) {
          res.status(206);
          res.setHeader(
            "Content-Range",
            `bytes ${range.start}-${range.end}/${doc.sizeBytes}`,
          );
          res.setHeader("Content-Length", String(range.end - range.start + 1));
        } else {
          res.status(200);
          res.setHeader("Content-Length", String(doc.sizeBytes));
        }
        // GridFS bounds are end-exclusive; HTTP bounds are end-inclusive.
        const stream =
          range === undefined
            ? openPdfDownload(db, docId)
            : openPdfDownload(db, docId, { start: range.start, end: range.end + 1 });
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

  // Fetch one document's extracted text on demand, without the list payload.
  // Always answers the current extraction state; text fields are present
  // only for completed extractions.
  router.get("/:docId/text", (req, res) => {
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
        res.status(200).json({
          extractionStatus: doc.extractionStatus ?? "pending",
          ...(doc.extractedText !== undefined ? { extractedText: doc.extractedText } : {}),
          ...(doc.pageCount !== undefined ? { pageCount: doc.pageCount } : {}),
          ...(doc.extractedAt !== undefined
            ? { extractedAt: doc.extractedAt.toISOString() }
            : {}),
        });
      } catch (err: unknown) {
        console.error("GET /api/matters/:id/documents/:docId/text failed:", err);
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
        const doc = await documents.findOne({ _id: docId, matterId });
        if (doc !== null && rejectUnstoredBytes(res, doc)) {
          return;
        }
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
        if (rejectUnstoredBytes(res, doc)) {
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
                  analysis: analysisSettingsFromEnv(options.env),
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
              analysis: analysisSettingsFromEnv(options.env),
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
