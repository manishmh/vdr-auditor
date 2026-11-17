import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { getMattersCollection } from "../db/matters.js";
import {
  parseCreateMatter,
  parseMatterId,
  toMatterResponse,
} from "../models/matter.js";

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

  return router;
}
