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

import { PAGE_SEPARATOR } from "../src/extraction/service.js";
import type { DocumentExtractionStatus } from "../src/models/document.js";
import { startApp, type RunningApp } from "./matters-fake.js";
import { createDocumentsFake, type DocumentsFake } from "./documents-fake.js";
import { buildCorruptPdf, buildPdf } from "./pdf-fixtures.js";

const URI = "mongodb://localhost:27017/testdb";
const MATTER_ID = "64f1a2b3c4d5e6f7890abc01";
const OTHER_MATTER_ID = "64f1a2b3c4d5e6f7890abc02";
const DOC_ID = "64f1a2b3c4d5e6f7890abc03";

let fake: DocumentsFake;
let app: RunningApp | undefined;
let errorSpy: { mockRestore: () => void } | undefined;

function silenceErrors(): void {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  fake = createDocumentsFake();
  getDbMock.mockResolvedValue(fake.db);
  fake.state.matters.push({
    _id: new ObjectId(MATTER_ID),
    title: "Matter",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

afterEach(async () => {
  errorSpy?.mockRestore();
  errorSpy = undefined;
  await app?.close();
  app = undefined;
});

function seedDoc(overrides: {
  id?: string;
  matterId?: string;
  status?: DocumentExtractionStatus;
  text?: string;
}): void {
  fake.state.documents.push({
    _id: new ObjectId(overrides.id ?? DOC_ID),
    matterId: new ObjectId(overrides.matterId ?? MATTER_ID),
    filename: "a.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    extractionStatus: overrides.status ?? "pending",
    ...(overrides.text !== undefined
      ? {
          extractedText: overrides.text,
          pageCount: 1,
          extractedAt: new Date("2026-02-02T00:00:00.000Z"),
        }
      : {}),
  });
}

function storedDoc() {
  return fake.state.documents.find((d) => d._id.toHexString() === DOC_ID);
}

async function postExtract(matterId: string, docId: string): Promise<Response> {
  return fetch(
    `${(app as RunningApp).baseUrl}/api/matters/${matterId}/documents/${docId}/extract`,
    { method: "POST" },
  );
}

describe("POST extract", () => {
  it("extracts text and persists the completed result", async () => {
    seedDoc({});
    gridfsMocks.readPdfBytes.mockResolvedValue(
      buildPdf([["Hello page one"], ["Second page here"]]),
    );
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: DOC_ID, extractionStatus: "completed", pageCount: 2 });
    expect(body["extractedText"]).toBe(`Hello page one${PAGE_SEPARATOR}Second page here`);
    expect(body["extractedAt"]).toBeDefined();
    expect(body["pageOffset"]).toBe(0);
    expect(storedDoc()).toMatchObject({ extractionStatus: "completed", pageCount: 2 });
    expect(storedDoc()?.pageOffset).toBe(0);
    expect(storedDoc()?.extractedText).toContain("Hello page one");
  });

  it("persists no_text for PDFs without a text layer", async () => {
    seedDoc({});
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[], []]));
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ extractionStatus: "no_text", pageCount: 2 });
    expect(body).not.toHaveProperty("extractedText");
    expect(storedDoc()?.extractionStatus).toBe("no_text");
  });

  it("persists a failed result for unparseable PDFs", async () => {
    seedDoc({});
    gridfsMocks.readPdfBytes.mockResolvedValue(buildCorruptPdf());
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "extraction_failed", code: "unparseable" });
    expect(typeof body["message"]).toBe("string");
    expect(storedDoc()).toMatchObject({
      extractionStatus: "failed",
      extractionError: "unparseable",
    });
    expect(storedDoc()).not.toHaveProperty("extractedText");
  });

  it("preserves an earlier success when a retry fails", async () => {
    seedDoc({ status: "completed", text: "OLD TEXT" });
    gridfsMocks.readPdfBytes.mockResolvedValue(buildCorruptPdf());
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(422);
    expect(storedDoc()).toMatchObject({
      extractionStatus: "completed",
      extractedText: "OLD TEXT",
    });
    expect(storedDoc()).not.toHaveProperty("extractionError");
  });

  it("rejects concurrent extraction with 409", async () => {
    seedDoc({ status: "processing" });
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "extraction_in_progress" });
    expect(gridfsMocks.readPdfBytes).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed ids and 404 for missing or cross-matter docs", async () => {
    seedDoc({ matterId: OTHER_MATTER_ID });
    app = await startApp(URI);
    const bad = await postExtract("nope", DOC_ID);
    expect(bad.status).toBe(400);
    const cross = await postExtract(MATTER_ID, DOC_ID);
    expect(cross.status).toBe(404);
    const missing = await postExtract(MATTER_ID, "64f1a2b3c4d5e6f7890abc99");
    expect(missing.status).toBe(404);
    expect(gridfsMocks.readPdfBytes).not.toHaveBeenCalled();
  });

  it("returns 503 and restores pending when the database fails", async () => {
    silenceErrors();
    seedDoc({});
    getDbMock.mockRejectedValueOnce(new Error("topology closed"));
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "database_unavailable" });
    expect(text).not.toContain("topology closed");
    expect(storedDoc()?.extractionStatus).toBe("pending");
  });

  it("returns 503 and restores pending when the byte read fails", async () => {
    silenceErrors();
    seedDoc({});
    gridfsMocks.readPdfBytes.mockRejectedValueOnce(new Error("socket hang up"));
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(503);
    expect(storedDoc()?.extractionStatus).toBe("pending");
  });

  it("returns 500 without leaking internals when bytes are missing", async () => {
    silenceErrors();
    seedDoc({});
    gridfsMocks.readPdfBytes.mockResolvedValue(undefined);
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(storedDoc()?.extractionStatus).toBe("pending");
  });

  it("returns 503 and restores pending when persisting the result fails", async () => {
    silenceErrors();
    seedDoc({});
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([["hi"]]));
    const original = fake.documents.updateOne.getMockImplementation();
    let calls = 0;
    fake.documents.updateOne.mockImplementation(async (...args: Array<never>) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("write failed");
      }
      return (original as (...inner: Array<never>) => Promise<unknown>)(...args);
    });
    app = await startApp(URI);
    const res = await postExtract(MATTER_ID, DOC_ID);
    expect(res.status).toBe(503);
    expect(storedDoc()?.extractionStatus).toBe("pending");
  });
});
