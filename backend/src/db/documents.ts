import type { Collection, Db } from "mongodb";
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
