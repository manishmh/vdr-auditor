import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getStore, resetServerContext } from "@/backend/src/context";
import { closeMongo } from "@/backend/src/repositories/mongo-client";
import { MongoStore } from "@/backend/src/repositories/mongo-store";

/**
 * Storage implementation parity: development and production resolve the
 * same MongoDB store through identical configuration semantics. Filesystem
 * storage is never selected by real environments (unit tests and the
 * offline eval harness instantiate LocalFileStore directly instead).
 */

const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI;

if (!TEST_MONGODB_URI) {
  throw new Error(
    "TEST_MONGODB_URI is required for MongoDB repository tests. " +
      "Start a disposable instance, e.g. `docker run -d -p 127.0.0.1:27017:27017 mongo:8`, " +
      "and set TEST_MONGODB_URI=mongodb://127.0.0.1:27017/vdr_auditor_test.",
  );
}

const uri: string = TEST_MONGODB_URI;
const TOKEN = "test-pilot-token-0123456789abcdef";

afterEach(async () => {
  vi.unstubAllEnvs();
  resetConfigCache();
  resetServerContext();
  await closeMongo();
});

describe("storage implementation parity", () => {
  it("development configuration selects the MongoDB store", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STORAGE_BACKEND", "mongodb");
    vi.stubEnv("MONGODB_URI", uri);
    vi.stubEnv("MONGODB_DB", "vdr_auditor_parity_test");
    const store = await getStore();
    expect(store).toBeInstanceOf(MongoStore);
    expect(await store.listDocuments()).toEqual([]);
  });

  it("production configuration selects the MongoDB store with the default database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PILOT_ACCESS_TOKEN", TOKEN);
    vi.stubEnv("FRONTEND_ORIGIN", "https://pilot.example.com");
    vi.stubEnv("STORAGE_BACKEND", "mongodb");
    vi.stubEnv("MONGODB_URI", uri);
    delete process.env.MONGODB_DB;
    const store = await getStore();
    expect(store).toBeInstanceOf(MongoStore);
  });

  it("rejects filesystem storage for real environments", async () => {
    vi.stubEnv("STORAGE_BACKEND", "local");
    await expect(getStore()).rejects.toThrow(/STORAGE_BACKEND=mongodb/);
  });

  it("rejects an unconfigured backend instead of defaulting to files", async () => {
    delete process.env.STORAGE_BACKEND;
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_DB;
    await expect(getStore()).rejects.toThrow(/STORAGE_BACKEND=mongodb/);
  });

  it("requires an explicit database name outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STORAGE_BACKEND", "mongodb");
    vi.stubEnv("MONGODB_URI", uri);
    delete process.env.MONGODB_DB;
    await expect(getStore()).rejects.toThrow(/MONGODB_DB must be set explicitly/);
  });
});
