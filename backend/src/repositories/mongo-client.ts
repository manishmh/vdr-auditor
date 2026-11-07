import { Db, MongoClient } from "mongodb";

/**
 * One cached MongoClient per process. Serverless instances reuse the
 * connection across invocations via the module-level cache; concurrent
 * requests share the driver's internal pool (never one connection per
 * request).
 */
let client: MongoClient | null = null;
let connectedUri: string | null = null;

export async function getMongoDb(uri: string, dbName: string): Promise<Db> {
  if (!client || connectedUri !== uri) {
    await closeMongo();
    client = new MongoClient(uri);
    await client.connect();
    connectedUri = uri;
  }
  return client.db(dbName);
}

/** Idempotent index setup for the VDR collections. Safe to call at startup. */
export async function ensureMongoIndexes(db: Db): Promise<void> {
  await db.collection("findings").createIndex({ documentId: 1 });
  await db.collection("reviewEvents").createIndex({ documentId: 1 });
  await db.collection("documents").createIndex({ createdAt: -1 });
}

export async function closeMongo(): Promise<void> {
  if (client) {
    const closing = client;
    client = null;
    connectedUri = null;
    await closing.close();
  }
}
