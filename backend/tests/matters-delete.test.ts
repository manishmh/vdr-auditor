import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, gridfsMocks } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  gridfsMocks: {
    storePdf: vi.fn(),
    openPdfDownload: vi.fn(),
    readPdfBytes: vi.fn(),
    deletePdf: vi.fn(),
  },
}));

vi.mock("../src/db/mongodb.js", () => ({
  pingDatabase: vi.fn(),
  getDb: getDbMock,
  closeDatabase: vi.fn(),
}));

vi.mock("../src/storage/gridfs.js", () => ({
  PDF_BUCKET_NAME: "pdfs",
  storePdf: gridfsMocks.storePdf,
  openPdfDownload: gridfsMocks.openPdfDownload,
  readPdfBytes: gridfsMocks.readPdfBytes,
  deletePdf: gridfsMocks.deletePdf,
}));

import { startApp, type RunningApp } from "./matters-fake.js";
import { createProcessingFake, type ProcessingFake } from "./processing-fake.js";

const URI = "mongodb://localhost:27017/testdb";
const MATTER_ID = "64f1a2b3c4d5e6f7890abc01";
const OTHER_MATTER_ID = "64f1a2b3c4d5e6f7890abc02";
const DOC_ID = "64f1a2b3c4d5e6f7890abc03";

let fake: ProcessingFake;
let app: RunningApp | undefined;
let errorSpy: { mockRestore: () => void } | undefined;

function silenceErrors(): void {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  fake = createProcessingFake();
  getDbMock.mockResolvedValue(fake.db);
  gridfsMocks.deletePdf.mockResolvedValue(undefined);
});

afterEach(async () => {
  errorSpy?.mockRestore();
  errorSpy = undefined;
  await app?.close();
  app = undefined;
});

function seedMatter(id: string): void {
  fake.state.matters.push({
    _id: new ObjectId(id),
    title: "Matter",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function seedDoc(matterId: string, docId: string): void {
  fake.state.documents.push({
    _id: new ObjectId(docId),
    matterId: new ObjectId(matterId),
    filename: "a.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    extractionStatus: "completed",
  });
}

function seedRun(matterId: string, docId: string, heartbeatAt: Date): void {
  fake.processingState.push({
    _id: new ObjectId(),
    matterId: new ObjectId(matterId),
    docId: new ObjectId(docId),
    stage: "analyzing",
    active: true,
    attempts: 0,
    heartbeatAt,
    startedAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("DELETE /api/matters/:id", () => {
  it("deletes the matter and cascades everything under it", async () => {
    seedMatter(MATTER_ID);
    seedMatter(OTHER_MATTER_ID);
    seedDoc(MATTER_ID, DOC_ID);
    seedDoc(OTHER_MATTER_ID, "64f1a2b3c4d5e6f7890abc04");
    const runId = new ObjectId();
    fake.runState.push({
      _id: runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      status: "completed",
      limitations: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    fake.findingState.push({
      _id: new ObjectId(),
      runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      category: "change_of_control",
      severity: "high",
      title: "Old",
      explanation: "Old explanation.",
      excerpt: "Old excerpt.",
      page: 1,
      reviewStatus: "open",
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    seedRun(MATTER_ID, DOC_ID, new Date(Date.now() - 20 * 60 * 1000));

    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(gridfsMocks.deletePdf).toHaveBeenCalledTimes(1);
    expect(fake.state.matters.map((m) => m._id.toHexString())).toEqual([OTHER_MATTER_ID]);
    expect(fake.state.documents).toHaveLength(1);
    expect(fake.runState).toHaveLength(0);
    expect(fake.findingState).toHaveLength(0);
    expect(fake.processingState).toHaveLength(0);
  });

  it("refuses deletion while a live driver owns work, allows stale runs", async () => {
    silenceErrors();
    seedMatter(MATTER_ID);
    seedDoc(MATTER_ID, DOC_ID);
    seedRun(MATTER_ID, DOC_ID, new Date());
    app = await startApp(URI);
    const busy = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}`, {
      method: "DELETE",
    });
    expect(busy.status).toBe(409);
    expect(fake.state.matters).toHaveLength(1);
    expect(gridfsMocks.deletePdf).not.toHaveBeenCalled();

    fake.processingState[0]!.heartbeatAt = new Date(Date.now() - 20 * 60 * 1000);
    const stale = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}`, {
      method: "DELETE",
    });
    expect(stale.status).toBe(204);
    expect(fake.state.matters).toHaveLength(0);
  });

  it("returns 404 for unknown matters and 400 for bad ids", async () => {
    app = await startApp(URI);
    const missing = await fetch(
      `${app.baseUrl}/api/matters/64f1a2b3c4d5e6f7890abc09`,
      { method: "DELETE" },
    );
    expect(missing.status).toBe(404);
    const invalid = await fetch(`${app.baseUrl}/api/matters/not-an-id`, {
      method: "DELETE",
    });
    expect(invalid.status).toBe(400);
  });

  it("keeps everything when storage deletion fails", async () => {
    silenceErrors();
    seedMatter(MATTER_ID);
    seedDoc(MATTER_ID, DOC_ID);
    gridfsMocks.deletePdf.mockRejectedValueOnce(new Error("gridfs down"));
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(503);
    expect(fake.state.matters).toHaveLength(1);
    expect(fake.state.documents).toHaveLength(1);
  });

  it("returns 503 without a database", async () => {
    app = await startApp(undefined);
    const res = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(503);
  });
});
