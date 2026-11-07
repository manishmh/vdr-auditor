import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFileStore } from "@/lib/store/local";

let dir: string;
let store: LocalFileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vdr-store-"));
  store = new LocalFileStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalFileStore", () => {
  it("round-trips documents, pages, and findings", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      sha256: "abc",
      source: "upload",
    });
    await store.savePages(doc.id, [{ pageNumber: 1, text: "hello" }]);
    const now = new Date().toISOString();
    await store.saveFindings(doc.id, [
      {
        category: "change_of_control",
        severity: "high",
        title: "t",
        explanation: "e",
        evidence: "hello",
        confidence: 0.5,
        recommendedAction: "a",
        id: "123e4567-e89b-12d3-a456-426614174000",
        documentId: doc.id,
        pageStart: 1,
        pageEnd: 1,
        status: "open",
        reviewerNote: null,
        modelId: "mock-v1",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await store.updateDocument(doc.id, { status: "completed", findingCount: 1 });

    expect((await store.getDocument(doc.id))?.status).toBe("completed");
    expect(await store.getPages(doc.id)).toHaveLength(1);
    expect(await store.getFindings(doc.id)).toHaveLength(1);
    expect(await store.listDocuments()).toHaveLength(1);
  });

  it("updates finding status and reviewer notes", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "x",
      source: "upload",
    });
    const now = new Date().toISOString();
    const findingId = "123e4567-e89b-12d3-a456-426614174000";
    await store.saveFindings(doc.id, [
      {
        category: "change_of_control",
        severity: "low",
        title: "t",
        explanation: "e",
        evidence: "ev",
        recommendedAction: "a",
        id: findingId,
        documentId: doc.id,
        pageStart: null,
        pageEnd: null,
        status: "open",
        reviewerNote: null,
        modelId: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const updated = await store.updateFinding(doc.id, findingId, {
      status: "confirmed",
      reviewerNote: "verified with counsel",
    });
    expect(updated?.status).toBe("confirmed");
    expect(updated?.reviewerNote).toBe("verified with counsel");
    expect(await store.updateFinding(doc.id, "123e4567-e89b-12d3-a456-426614174099", {})).toBeNull();
  });

  it("deletes documents and returns null/false for missing ones", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "x",
      source: "upload",
    });
    expect(await store.deleteDocument(doc.id)).toBe(true);
    expect(await store.getDocument(doc.id)).toBeNull();
    expect(await store.deleteDocument(doc.id)).toBe(false);
    expect(await store.getFindings(doc.id)).toBeNull();
  });

  it("erases originals, pages, and findings on deletion", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
      sha256: "x",
      source: "upload",
    });
    const now = new Date().toISOString();
    await store.saveOriginal(doc.id, new Uint8Array([1, 2, 3, 4]));
    await store.savePages(doc.id, [{ pageNumber: 1, text: "secret text" }]);
    await store.saveFindings(doc.id, [
      {
        category: "change_of_control",
        severity: "low",
        title: "t",
        explanation: "e",
        evidence: "secret quote",
        recommendedAction: "a",
        id: "123e4567-e89b-12d3-a456-426614174000",
        documentId: doc.id,
        pageStart: 1,
        pageEnd: 1,
        status: "open",
        reviewerNote: "secret note",
        modelId: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    expect(await store.deleteDocument(doc.id)).toBe(true);
    expect(await store.getOriginal(doc.id)).toBeNull();
    expect(await store.getPages(doc.id)).toBeNull();
    expect(await store.getFindings(doc.id)).toBeNull();
  });

  it("rejects cross-document finding updates without touching the other document", async () => {
    const doc = await store.createDocument({
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "x",
      source: "upload",
    });
    const other = await store.createDocument({
      filename: "b.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "y",
      source: "upload",
    });
    const now = new Date().toISOString();
    const findingId = "123e4567-e89b-12d3-a456-426614174000";
    await store.saveFindings(other.id, [
      {
        category: "change_of_control",
        severity: "low",
        title: "t",
        explanation: "e",
        evidence: "ev",
        recommendedAction: "a",
        id: findingId,
        documentId: other.id,
        pageStart: null,
        pageEnd: null,
        status: "open",
        reviewerNote: null,
        modelId: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    expect(await store.updateFinding(doc.id, findingId, { status: "confirmed" })).toBeNull();
    expect((await store.getFindings(other.id))?.[0].status).toBe("open");
  });

  it("rejects non-UUID ids before touching the filesystem", async () => {
    await expect(store.getDocument("../escape")).rejects.toThrow(/Invalid document id/);
    await expect(store.deleteDocument("not-a-uuid")).rejects.toThrow(/Invalid/);
  });

  it("lists empty when the directory does not exist yet", async () => {
    const fresh = new LocalFileStore(join(dir, "nothing-here"));
    expect(await fresh.listDocuments()).toEqual([]);
  });
});
