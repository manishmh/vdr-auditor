import { Db, MongoClient } from "mongodb";
import { getMongoUriTlsWarning } from "../../../lib/mongo-uri";

/**
 * One cached MongoClient per process, shared across warm serverless
 * invocations via the module-level cache; concurrent requests share the
 * driver's internal pool (never one connection per request).
 *
 * Two invariants keep warm instances healthy:
 *
 * 1. Concurrent callers single-flight on the pending connect. Without the
 *    lock, overlapping cold-start connects race: the loser can overwrite
 *    the cached client with a failed one (the driver leaves a failed
 *    connect's topology closed but referenced) while the winner marks the
 *    URI connected — poisoning every later request on that instance with
 *    "Topology is closed", with no recovery until the instance recycles.
 * 2. A failed connect is never cached. On failure the cache is cleared
 *    before the error propagates, so the next request starts clean.
 */
let client: MongoClient | null = null;
let connectedUri: string | null = null;
let indexesReady = false;
let everConnected = false;
let pending: { uri: string; promise: Promise<MongoClient> } | null = null;

export async function getMongoDb(uri: string, dbName: string): Promise<Db> {
  for (;;) {
    if (client && connectedUri === uri) {
      const db = client.db(dbName);
      if (!indexesReady) {
        await ensureMongoIndexes(db);
        indexesReady = true;
      }
      return db;
    }
    if (pending) {
      // Another connect is in flight (possibly for a different URI, in
      // tests): await it, then loop and re-evaluate from current state.
      try {
        await pending.promise;
      } catch {
        // The pending attempt failed; loop around and start our own.
      }
      continue;
    }
    const attempt = connectFresh(uri, dbName);
    pending = { uri, promise: attempt };
    try {
      const fresh = await attempt;
      return fresh.db(dbName);
    } finally {
      if (pending?.promise === attempt) pending = null;
    }
  }
}

/**
 * Connect a new client and make it current. Closes any previous client
 * first (URI switches happen only in tests). Indexes are ensured here so
 * concurrent waiters on the single-flight receive a fully-ready client.
 */
async function connectFresh(uri: string, dbName: string): Promise<MongoClient> {
  const tlsWarning = getMongoUriTlsWarning(uri);
  if (tlsWarning) console.warn(`[mongo] ${tlsWarning}`);
  await closeMongo();
  const fresh = new MongoClient(uri, {
    // Identifies this app's connections in Atlas logs/profiler.
    appName: "vdr-auditor",
    // The driver's 30 s connect/selection defaults outlast serverless
    // function durations, turning an unreachable Atlas cluster into an
    // opaque platform timeout; 10 s still allows slow TLS handshakes
    // while failing fast with a logged, honest 500. Socket timeout stays
    // unlimited so large original-file reads/writes are never cut mid-op.
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });
  try {
    await fresh.connect();
  } catch (err) {
    // Rethrow untouched: the driver's message (TLS alert, auth failure,
    // DNS) is the diagnosis. The cache stays empty so the next request
    // starts clean — a failed client is never left behind for later
    // operations to trip over as "Topology is closed".
    indexesReady = false;
    throw err;
  }
  client = fresh;
  connectedUri = uri;
  console.info(`[mongo] ${everConnected ? "reconnected" : "connected"} db=${dbName}`);
  everConnected = true;
  // Set only after success: a transient ensure failure (auth hiccup, TLS
  // flap) leaves the client cached but stale-flagged, so the next request
  // retries the ensure instead of storming reconnects.
  indexesReady = false;
  await ensureMongoIndexes(fresh.db(dbName));
  indexesReady = true;
  return fresh;
}

/** Idempotent index setup for the VDR collections. Safe to call at startup. */
export async function ensureMongoIndexes(db: Db): Promise<void> {
  await db.collection("findings").createIndex({ documentId: 1 });
  await db.collection("reviewEvents").createIndex({ documentId: 1 });
  await db.collection("documents").createIndex({ createdAt: -1 });
}

export async function closeMongo(): Promise<void> {
  indexesReady = false;
  if (client) {
    const closing = client;
    client = null;
    connectedUri = null;
    await closing.close();
  }
}

// Re-exported so existing importers keep working; the implementation lives
// in lib/ so server config validation can share it (lib must not import
// backend/).
export { getMongoUriTlsWarning };
