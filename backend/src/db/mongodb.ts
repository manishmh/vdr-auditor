import { Db, MongoClient } from "mongodb";

/**
 * Shared MongoClient singleton. One client per process, safe for concurrent
 * requests and reused across warm Vercel function invocations. The client is
 * created lazily on first use so the server can boot and answer liveness
 * probes without database configuration.
 */
let client: MongoClient | undefined;
let clientUri: string | undefined;

function getClient(uri: string): MongoClient {
  if (client === undefined || clientUri !== uri) {
    client = new MongoClient(uri);
    clientUri = uri;
  }
  return client;
}

export async function getDb(uri: string, dbName: string): Promise<Db> {
  const mongoClient = getClient(uri);
  await mongoClient.connect();
  return mongoClient.db(dbName);
}

/** Run a real `ping` against the deployment. Throws when unreachable. */
export async function pingDatabase(uri: string, dbName: string): Promise<void> {
  const db = await getDb(uri, dbName);
  await db.command({ ping: 1 });
}

export async function closeDatabase(): Promise<void> {
  if (client !== undefined) {
    await client.close();
    client = undefined;
    clientUri = undefined;
  }
}
