import { getConfig } from "../../lib/config";
import { getInferenceProvider } from "../../lib/inference/index";
import type { InferenceProvider } from "../../lib/inference/types";
import { LocalFileStore } from "../../lib/store/local";
import type { DocumentStore } from "../../lib/store/types";
import { ensureMongoIndexes, getMongoDb } from "./repositories/mongo-client";
import { MongoStore } from "./repositories/mongo-store";

/** Server-owned singletons (store may need async Mongo setup). */
let store: DocumentStore | null = null;
let provider: InferenceProvider | null = null;

export async function getStore(): Promise<DocumentStore> {
  if (!store) {
    const config = getConfig();
    if (config.STORAGE_BACKEND === "mongodb") {
      const uri = config.MONGODB_URI;
      if (!uri) throw new Error("MONGODB_URI is required when STORAGE_BACKEND=mongodb");
      const db = await getMongoDb(uri, config.MONGODB_DB);
      await ensureMongoIndexes(db);
      store = new MongoStore(db);
    } else {
      store = new LocalFileStore(config.STORAGE_DIR);
    }
  }
  return store;
}

export function getProvider(): InferenceProvider {
  if (!provider) provider = getInferenceProvider(getConfig());
  return provider;
}

/** Test hook: drop cached singletons (Mongo connection is closed separately). */
export function resetServerContext(): void {
  store = null;
  provider = null;
}
