import type { Collection, Db } from "mongodb";
import type { MatterDocument } from "../models/matter.js";
import { getDb } from "./mongodb.js";

export const MATTERS_COLLECTION_NAME = "matters";

/**
 * Index-creation promise, memoized per process. The listing query sorts by
 * `createdAt` descending, so one index covers it. On failure the memo is
 * cleared so a later request retries instead of poisoning the process.
 */
let indexesEnsured: Promise<void> | undefined;

async function ensureMattersIndexes(db: Db): Promise<void> {
  if (indexesEnsured === undefined) {
    indexesEnsured = db
      .collection<MatterDocument>(MATTERS_COLLECTION_NAME)
      .createIndex({ createdAt: -1 })
      .then(() => undefined)
      .catch((err: unknown) => {
        indexesEnsured = undefined;
        throw err;
      });
  }
  await indexesEnsured;
}

/**
 * Matters collection on the shared client. Safe for concurrent requests and
 * reused across warm Vercel invocations; the client itself is created lazily
 * on first use, so importing this module performs no I/O.
 */
export async function getMattersCollection(
  uri: string,
  dbName: string,
): Promise<Collection<MatterDocument>> {
  const db = await getDb(uri, dbName);
  await ensureMattersIndexes(db);
  return db.collection<MatterDocument>(MATTERS_COLLECTION_NAME);
}
