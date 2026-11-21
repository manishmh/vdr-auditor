import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { getAnalysesCollections } from "../db/analyses.js";
import { getDocumentsCollection } from "../db/documents.js";
import { getMattersCollection } from "../db/matters.js";
import { getDb } from "../db/mongodb.js";
import { getProcessingRuns } from "../db/processing.js";
import {
  parseCreateMatter,
  parseMatterId,
  toMatterResponse,
} from "../models/matter.js";
import { PROCESSING_STALE_MS } from "../processing/driver.js";
import { deletePdf } from "../storage/gridfs.js";

export interface MattersRouterOptions {
  mongodbUri: string | undefined;
  mongodbDbName: string;
}

function databaseUnavailable(res: Response): void {
  res.status(503).json({
    error: "database_unavailable",
    message: "The database is not reachable. Try again later.",
  });
}

export function createMattersRouter(options: MattersRouterOptions): Router {
  const router = Router();

  // List matters, newest first.
  router.get("/", (_req, res) => {
    void (async () => {
      if (options.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const collection = await getMattersCollection(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const docs = await collection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.status(200).json(docs.map(toMatterResponse));
      } catch (err: unknown) {
        console.error("GET /api/matters failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Create a matter. IDs and timestamps are always server-generated.
  router.post("/", (req, res) => {
    const parsed = parseCreateMatter(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: "validation_error", issues: parsed.issues });
      return;
    }
    void (async () => {
      if (options.mongodbUri === undefined) {
        databaseUnavailable(res);
        return;
      }
      try {
        const collection = await getMattersCollection(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const now = new Date();
        const { title, description, status } = parsed.value;
        const doc = {
          _id: new ObjectId(),
          title,
          status,
          createdAt: now,
          updatedAt: now,
          ...(description !== undefined ? { description } : {}),
        };
        await collection.insertOne(doc);
        res.status(201).json(toMatterResponse(doc));
      } catch (err: unknown) {
        console.error("POST /api/matters failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Fetch one matter by id.
  router.get("/:id", (req, res) => {
    const rawId: unknown = req.params.id;
    const objectId =
      typeof rawId === "string" ? parseMatterId(rawId) : undefined;
    if (objectId === undefined) {
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
        const collection = await getMattersCollection(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const doc = await collection.findOne({ _id: objectId });
        if (doc === null) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.status(200).json(toMatterResponse(doc));
      } catch (err: unknown) {
        console.error("GET /api/matters/:id failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  // Delete a matter and everything under it: documents, GridFS bytes,
  // analysis runs, findings, and processing runs. Refused while any live
  // driver owns work in the matter; stale runs do not block deletion.
  router.delete("/:id", (req, res) => {
    const rawId: unknown = req.params.id;
    const objectId =
      typeof rawId === "string" ? parseMatterId(rawId) : undefined;
    if (objectId === undefined) {
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
        const collection = await getMattersCollection(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const doc = await collection.findOne({ _id: objectId });
        if (doc === null) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const processing = await getProcessingRuns(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const activeRuns = await processing
          .find({ matterId: objectId, active: true })
          .toArray();
        const live = activeRuns.some(
          (run) => Date.now() - run.heartbeatAt.getTime() <= PROCESSING_STALE_MS,
        );
        if (live) {
          res.status(409).json({
            error: "processing_in_progress",
            message: "Cannot delete while documents are still processing.",
          });
          return;
        }
        const db = await getDb(options.mongodbUri, options.mongodbDbName);
        const documents = await getDocumentsCollection(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const { runs, findings } = await getAnalysesCollections(
          options.mongodbUri,
          options.mongodbDbName,
        );
        const matterDocs = await documents.find({ matterId: objectId }).toArray();
        try {
          for (const matterDoc of matterDocs) {
            await deletePdf(db, matterDoc._id);
          }
        } catch (err: unknown) {
          console.error("matter GridFS delete failed:", err);
          databaseUnavailable(res);
          return;
        }
        await findings.deleteMany({ matterId: objectId });
        await runs.deleteMany({ matterId: objectId });
        await processing.deleteMany({ matterId: objectId });
        await documents.deleteMany({ matterId: objectId });
        await collection.deleteOne({ _id: objectId });
        res.status(204).send();
      } catch (err: unknown) {
        console.error("DELETE /api/matters/:id failed:", err);
        databaseUnavailable(res);
      }
    })();
  });

  return router;
}
