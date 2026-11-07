import { afterAll, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import {
  closeMongo,
  getMongoDb,
  getMongoUriTlsWarning,
} from "@/backend/src/repositories/mongo-client";

const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI;

if (!TEST_MONGODB_URI) {
  throw new Error(
    "TEST_MONGODB_URI is required for MongoDB repository tests. " +
      "Start a disposable instance, e.g. `docker run -d -p 127.0.0.1:27017:27017 mongo:8`, " +
      "and set TEST_MONGODB_URI=mongodb://127.0.0.1:27017/vdr_auditor_test.",
  );
}

const uri: string = TEST_MONGODB_URI;

afterAll(async () => {
  await closeMongo();
});

describe("mongo client lifecycle", () => {
  it("single-flights concurrent connects into one underlying connect", async () => {
    await closeMongo();
    const spy = vi.spyOn(MongoClient.prototype, "connect");
    try {
      const dbs = await Promise.all(
        Array.from({ length: 20 }, () => getMongoDb(uri, "vdr_auditor_test")),
      );
      expect(dbs).toHaveLength(20);
      // Without the single-flight lock this is ~20 connects; overlapping
      // cold-start connects race, and the loser can poison the cache with
      // a failed client (later requests: "Topology is closed").
      expect(spy).toHaveBeenCalledTimes(1);
      for (const db of dbs) {
        await expect(db.command({ ping: 1 })).resolves.toMatchObject({ ok: 1 });
      }
    } finally {
      spy.mockRestore();
      await closeMongo();
    }
  });

  it("never caches a failed connect: the next call starts clean", async () => {
    await closeMongo();
    await expect(getMongoDb("mongodb://127.0.0.1:1/vdr_auditor_test", "vdr_auditor_test")).rejects.toThrow();
    const db = await getMongoDb(uri, "vdr_auditor_test");
    await expect(db.command({ ping: 1 })).resolves.toMatchObject({ ok: 1 });
    await closeMongo();
  });

  it("ensures indexes on every fresh connect", async () => {
    await closeMongo();
    const db = await getMongoDb(uri, "vdr_auditor_test");
    await expect(db.collection("findings").listIndexes().toArray()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "documentId_1" })]),
    );
    await expect(db.collection("reviewEvents").listIndexes().toArray()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "documentId_1" })]),
    );
    await expect(db.collection("documents").listIndexes().toArray()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "createdAt_-1" })]),
    );
    await closeMongo();
  });

  it("reconnects after closeMongo", async () => {
    await closeMongo();
    const spy = vi.spyOn(MongoClient.prototype, "connect");
    try {
      await getMongoDb(uri, "vdr_auditor_test");
      await closeMongo();
      const db = await getMongoDb(uri, "vdr_auditor_test");
      await expect(db.command({ ping: 1 })).resolves.toMatchObject({ ok: 1 });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      await closeMongo();
    }
  });
});

describe("getMongoUriTlsWarning", () => {
  it("accepts SRV URIs (TLS implied)", () => {
    expect(getMongoUriTlsWarning("mongodb+srv://user:pass@cluster0.abc.mongodb.net/db")).toBeNull();
  });

  it("accepts localhost without TLS", () => {
    expect(getMongoUriTlsWarning("mongodb://127.0.0.1:27017/db")).toBeNull();
    expect(getMongoUriTlsWarning("mongodb://localhost/db")).toBeNull();
    expect(getMongoUriTlsWarning("mongodb://user:pass@localhost:27017,127.0.0.1:27018/db")).toBeNull();
  });

  it("accepts remote mongodb:// URIs with explicit TLS", () => {
    expect(getMongoUriTlsWarning("mongodb://host.example.com:27017/db?tls=true")).toBeNull();
    expect(getMongoUriTlsWarning("mongodb://host.example.com/db?retryWrites=true&tls=true")).toBeNull();
    expect(getMongoUriTlsWarning("mongodb://host.example.com/db?ssl=true")).toBeNull();
  });

  it("warns on remote mongodb:// URIs without TLS", () => {
    const warning = getMongoUriTlsWarning("mongodb://cluster0-shard.example.com:27017/db?retryWrites=true");
    expect(warning).toContain("without tls=true");
    expect(warning).toContain("cluster0-shard.example.com");
    expect(warning).toContain("mongodb+srv://");
  });

  it("returns null for unparseable input (driver reports those)", () => {
    expect(getMongoUriTlsWarning("not-a-uri")).toBeNull();
    expect(getMongoUriTlsWarning("")).toBeNull();
  });
});
