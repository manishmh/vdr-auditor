import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Db } from "mongodb";
import { closeMongo, ensureMongoIndexes, getMongoDb } from "@/backend/src/repositories/mongo-client";
import { MongoStore } from "@/backend/src/repositories/mongo-store";

const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI;

if (!TEST_MONGODB_URI) {
  throw new Error(
    "TEST_MONGODB_URI is required for MongoDB repository tests. " +
      "Start a disposable instance, e.g. `docker run -d -p 127.0.0.1:27017:27017 mongo:8`, " +
      "and set TEST_MONGODB_URI=mongodb://127.0.0.1:27017/vdr_auditor_test.",
  );
}

const uri: string = TEST_MONGODB_URI;

let db: Db;
let store: MongoStore;

beforeAll(async () => {
  db = await getMongoDb(uri, "vdr_auditor_test");
  await ensureMongoIndexes(db);
  store = new MongoStore(db);
}, 60000);

afterAll(async () => {
  await closeMongo();
});

beforeEach(async () => {
  await Promise.all([
    db.collection("documents").deleteMany({}),
    db.collection("findings").deleteMany({}),
    db.collection("reviewEvents").deleteMany({}),
  ]);
});

function findingDoc(docId: string, id: string, now: string) {
  return {
    category: "change_of_control" as const,
    severity: "medium" as const,
    title: "t",
    explanation: "e",
    evidence: "ev",
    recommendedAction: "a",
    id,
    documentId: docId,
    pageStart: 1,
    pageEnd: 1,
    status: "open" as const,
    reviewerNote: null,
    modelId: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("MongoStore", () => {
  it("round-trips documents, pages, originals, and findings", async () => {
    const doc = await store.createDocument({
      filename: "deal.pdf",
      mimeType: "application/pdf",
      sizeBytes: 128,
      sha256: "abc123",
      source: "upload",
    });
    expect(doc.status).toBe("queued");
    expect(doc.findingCount).toBe(0);

    await store.saveOriginal(doc.id, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await store.savePages(doc.id, [
      { pageNumber: 1, text: "first" },
      { pageNumber: 2, text: "second" },
    ]);
    const now = new Date().toISOString();
    await store.saveFindings(doc.id, [
      { ...findingDoc(doc.id, "123e4567-e89b-12d3-a456-426614174000", now), severity: "high", pageStart: 2, confidence: 0.75, modelId: "test-model" },
    ]);

    expect(await store.getOriginal(doc.id)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(await store.getPages(doc.id)).toEqual([
      { pageNumber: 1, text: "first" },
      { pageNumber: 2, text: "second" },
    ]);
    const findings = await store.getFindings(doc.id);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]).toMatchObject({ severity: "high", confidence: 0.75, modelId: "test-model" });
    expect((await store.getDocument(doc.id))?.findingCount).toBe(1);
    expect(await store.listDocuments()).toHaveLength(1);
  });

  it("persists reviewer decisions and records review events", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "x",
      source: "upload",
    });
    const now = new Date().toISOString();
    const findingId = "123e4567-e89b-12d3-a456-426614174000";
    await store.saveFindings(doc.id, [findingDoc(doc.id, findingId, now)]);

    const updated = await store.updateFinding(doc.id, findingId, {
      status: "needs_legal_review",
      reviewerNote: "counsel should confirm",
    });
    expect(updated?.status).toBe("needs_legal_review");
    expect(updated?.reviewerNote).toBe("counsel should confirm");

    const events = await db.collection("reviewEvents").find({ documentId: doc.id }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("finding.status:needs_legal_review");
    expect(events[0].findingId).toBe(findingId);
    expect(events[0].actor).toBeNull();
  });

  it("returns null for missing findings and rejects cross-document updates", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "x",
      source: "upload",
    });
    expect(
      await store.updateFinding(doc.id, "123e4567-e89b-12d3-a456-426614174099", { status: "confirmed" }),
    ).toBeNull();
    expect(await store.getFindings("123e4567-e89b-12d3-a456-426614174099")).toBeNull();

    const other = await store.createDocument({
      filename: "b.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "y",
      source: "upload",
    });
    const now = new Date().toISOString();
    const findingId = "123e4567-e89b-12d3-a456-426614174000";
    await store.saveFindings(other.id, [findingDoc(other.id, findingId, now)]);
    expect(await store.updateFinding(doc.id, findingId, { status: "confirmed" })).toBeNull();
    expect((await store.getFindings(other.id))?.[0].status).toBe("open");
  });

  it("deletes documents with associated findings and events", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
      sha256: "x",
      source: "upload",
    });
    const now = new Date().toISOString();
    await store.saveOriginal(doc.id, new Uint8Array([1, 2, 3, 4]));
    await store.savePages(doc.id, [{ pageNumber: 1, text: "secret" }]);
    await store.saveFindings(doc.id, [findingDoc(doc.id, "123e4567-e89b-12d3-a456-426614174000", now)]);
    await store.updateFinding(doc.id, "123e4567-e89b-12d3-a456-426614174000", { status: "confirmed" });

    expect(await store.deleteDocument(doc.id)).toBe(true);
    expect(await store.getDocument(doc.id)).toBeNull();
    expect(await store.getOriginal(doc.id)).toBeNull();
    expect(await store.getPages(doc.id)).toBeNull();
    expect(await store.getFindings(doc.id)).toBeNull();
    expect(await db.collection("reviewEvents").countDocuments({ documentId: doc.id })).toBe(0);
    expect(await store.deleteDocument(doc.id)).toBe(false);
  });

  it("rejects duplicate finding identifiers explicitly", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "x",
      source: "upload",
    });
    const now = new Date().toISOString();
    const dup = findingDoc(doc.id, "123e4567-e89b-12d3-a456-426614174000", now);
    await expect(store.saveFindings(doc.id, [dup, { ...dup }])).rejects.toThrow(/Duplicate identifier/);
  });

  it("rejects non-UUID ids before touching the database", async () => {
    await expect(store.getDocument("../escape")).rejects.toThrow(/Invalid document id/);
    await expect(store.deleteDocument("not-a-uuid")).rejects.toThrow(/Invalid/);
  });
});
