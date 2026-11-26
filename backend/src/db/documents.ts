import type { Collection, Db, ObjectId } from "mongodb";
import type { DocumentRecord } from "../models/document.js";
import { getDb } from "./mongodb.js";

export const DOCUMENTS_COLLECTION_NAME = "documents";

/**
 * Index-creation promise, memoized per process. Document listings filter by
 * matter and sort by creation date. On failure the memo is cleared so a
 * later request retries instead of poisoning the process.
 */
let indexesEnsured: Promise<void> | undefined;

async function ensureDocumentsIndexes(db: Db): Promise<void> {
  if (indexesEnsured === undefined) {
    indexesEnsured = db
      .collection<DocumentRecord>(DOCUMENTS_COLLECTION_NAME)
      .createIndex({ matterId: 1, createdAt: -1 })
      .then(() => undefined)
      .catch((err: unknown) => {
        indexesEnsured = undefined;
        throw err;
      });
  }
  await indexesEnsured;
}

/**
 * Documents collection on the shared client. Safe for concurrent requests
 * and reused across warm Vercel invocations; importing this module performs
 * no I/O.
 */
export async function getDocumentsCollection(
  uri: string,
  dbName: string,
): Promise<Collection<DocumentRecord>> {
  const db = await getDb(uri, dbName);
  await ensureDocumentsIndexes(db);
  return db.collection<DocumentRecord>(DOCUMENTS_COLLECTION_NAME);
}

/**
 * Fail a document whose bytes never finished persisting (interrupted
 * background store, dead process). Only touches records still marked
 * unstored, so a concurrent success wins harmlessly. Never throws: callers
 * are background paths where a throw would mask the original failure.
 */
export async function markUploadInterrupted(
  uri: string,
  dbName: string,
  fileId: ObjectId,
): Promise<void> {
  try {
    const documents = await getDocumentsCollection(uri, dbName);
    await documents.updateOne(
      { _id: fileId, bytesStored: false },
      {
        $set: {
          extractionStatus: "failed",
          extractionError: "upload_interrupted",
          updatedAt: new Date(),
        },
      },
    );
  } catch (err: unknown) {
    console.error("mark upload interrupted failed:", err);
  }
}
