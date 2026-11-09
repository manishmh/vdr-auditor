import { getConfig } from "../../lib/config";
import { getInferenceProvider } from "../../lib/inference/index";
import type { InferenceProvider } from "../../lib/inference/types";
import type { DocumentStore } from "../../lib/store/types";
import { getMongoDb } from "./repositories/mongo-client";
import { MongoStore } from "./repositories/mongo-store";

/** Server-owned inference singleton. */
let provider: InferenceProvider | null = null;

export async function getStore(): Promise<DocumentStore> {
  const config = getConfig();
  // MongoDB is the only application storage backend (config validation
  // rejects anything else at runtime). There is deliberately no fallback:
  // filesystem storage is explicit test-only scaffolding, instantiated
  // directly by unit tests and the offline eval harness.
  if (config.STORAGE_BACKEND !== "mongodb") {
    throw new Error("STORAGE_BACKEND=mongodb is required; filesystem storage is test-only.");
  }
  const uri = config.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required when STORAGE_BACKEND=mongodb");
  // Fresh handle per call: the process-wide MongoClient underneath is
  // cached and shared (see mongo-client.ts, which also ensures indexes
  // on every fresh connect), but the store never pins a Db from a
  // previous client generation across a reconnect. Cheap when warm —
  // no I/O unless a (re)connect or a retried ensure is actually due.
  return new MongoStore(await getMongoDb(uri, config.MONGODB_DB));
}

export function getProvider(): InferenceProvider {
  if (!provider) provider = getInferenceProvider(getConfig());
  return provider;
}

/** Test hook: drop the cached provider (Mongo connection is closed separately). */
export function resetServerContext(): void {
  provider = null;
}
