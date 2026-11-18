import express, { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { getDocumentsCollection } from "../db/documents.js";
import { getMattersCollection } from "../db/matters.js";
import { getDb } from "../db/mongodb.js";
import {
  parseDocumentId,
  parseRawUpload,
  toDocumentResponse,
} from "../models/document.js";
import { parseMatterId } from "../models/matter.js";
import { deletePdf, openPdfDownload, storePdf } from "../storage/gridfs.js";

export interface DocumentsRouterOptions {
  mongodbUri: string | undefined;
  mongodbDbName: string;
  maxPdfBytes: number;
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
      if (options.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const matters = await getMattersCollection(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const matter = await matters.findOne({ _id: matterId });
        if (matter === null) {
          res.status(404).json({ error: "matter_not_found" });
          return;
        }
        const documents = await getDocumentsCollection(
          options.mongodbUri,
          options.mongodbDbName,
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
    express.raw({ type: "application/pdf", limit: options.maxPdfBytes }),
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
        options.maxPdfBytes,
      );
      if (!parsed.ok) {
        if (parsed.issues.some((issue) => issue.code === "file_too_large")) {
          res.status(413).json({
            error: "file_too_large",
            message: `File is larger than the ${options.maxPdfBytes}-byte limit.`,
            issues: parsed.issues,
          });
          return;
        }
        res.status(400).json({ error: "validation_error", issues: parsed.issues });
        return;
      }
      void (async () => {
        if (options.mongodbUri === undefined) {
          databaseUnavailable(res);
          return;
        }
        try {
          const db = await getDb(options.mongodbUri, options.mongodbDbName);
          const matters = await getMattersCollection(
            options.mongodbUri,
            options.mongodbDbName,
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
              options.mongodbUri,
              options.mongodbDbName,
            );
            await documents.insertOne({
              _id: fileId,
              matterId,
              filename: parsed.value.filename,
              contentType: "application/pdf",
              sizeBytes: parsed.value.sizeBytes,
              createdAt: now,
              updatedAt: now,
            });
          } catch (err: unknown) {
            console.error("document metadata insert failed:", err);
            await deletePdf(db, fileId).catch((cleanupErr: unknown) => {
              console.error("orphaned GridFS cleanup failed:", cleanupErr);
            });
            databaseUnavailable(res);
            return;
          }
          res.status(201).json(
            toDocumentResponse({
              _id: fileId,
              matterId,
              filename: parsed.value.filename,
              contentType: "application/pdf",
              sizeBytes: parsed.value.sizeBytes,
              createdAt: now,
              updatedAt: now,
            }),
          );
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
      if (options.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const db = await getDb(options.mongodbUri, options.mongodbDbName);
        const documents = await getDocumentsCollection(
          options.mongodbUri,
          options.mongodbDbName,
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
      if (options.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const db = await getDb(options.mongodbUri, options.mongodbDbName);
        const documents = await getDocumentsCollection(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const doc = await documents.findOne({ _id: docId, matterId });
        if (doc === null) {
          res.status(404).json({ error: "document_not_found" });
          return;
        }
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
          message: `File is larger than the ${options.maxPdfBytes}-byte limit.`,
        });
        return;
      }
      next(err);
    },
  );

  return router;
}
