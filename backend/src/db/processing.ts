import { ObjectId, type Collection, type Db } from "mongodb";
import type { ProcessingRunRecord } from "../models/processing.js";
import { getDb } from "./mongodb.js";

export const PROCESSING_RUNS_COLLECTION_NAME = "processing_runs";

/**
 * Index-creation promise, memoized per process. The partial unique index on
 * active runs is the duplicate guard: at most one active processing run per
 * document can exist, so repeated upload/process requests cannot fork state.
 */
let indexesEnsured: Promise<void> | undefined;

async function ensureProcessingIndexes(db: Db): Promise<void> {
  if (indexesEnsured === undefined) {
    indexesEnsured = db
      .collection<ProcessingRunRecord>(PROCESSING_RUNS_COLLECTION_NAME)
      .createIndex({ docId: 1 }, { unique: true, partialFilterExpression: { active: true } })
      .then(() => undefined)
      .then(() =>
        db
          .collection<ProcessingRunRecord>(PROCESSING_RUNS_COLLECTION_NAME)
          .createIndex({ matterId: 1, updatedAt: -1 })
          .then(() => undefined),
      )
      .catch((err: unknown) => {
        indexesEnsured = undefined;
        throw err;
      });
  }
  await indexesEnsured;
}

export async function getProcessingRuns(
  uri: string,
  dbName: string,
): Promise<Collection<ProcessingRunRecord>> {
  const db = await getDb(uri, dbName);
  await ensureProcessingIndexes(db);
  return db.collection<ProcessingRunRecord>(PROCESSING_RUNS_COLLECTION_NAME);
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

/**
 * Create a queued processing run for a document, or return the existing
 * active run when a concurrent request already created one. Never produces
 * duplicate active runs thanks to the partial unique index.
 */
export async function startProcessingRun(
  runs: Collection<ProcessingRunRecord>,
  matterId: ObjectId,
  docId: ObjectId,
): Promise<{ run: ProcessingRunRecord; created: boolean }> {
  const now = new Date();
  const fresh: ProcessingRunRecord = {
    _id: new ObjectId(),
    matterId,
    docId,
    stage: "queued",
    active: true,
    attempts: 0,
    heartbeatAt: now,
    startedAt: now,
    updatedAt: now,
  };
  try {
    await runs.insertOne(fresh);
    return { run: fresh, created: true };
  } catch (err: unknown) {
    if (!isDuplicateKey(err)) {
      throw err;
    }
    const existing = await runs.findOne({ docId, active: true });
    if (existing === null) {
      throw err;
    }
    return { run: existing, created: false };
  }
}
