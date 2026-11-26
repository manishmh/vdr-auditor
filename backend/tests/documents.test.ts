import { Readable } from "node:stream";
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, gridfsMocks, scheduleMock, driveMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  gridfsMocks: {
    storePdf: vi.fn(),
    openPdfDownload: vi.fn(),
    deletePdf: vi.fn(),
  },
  scheduleMock: vi.fn(),
  driveMock: vi.fn(),
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
  deletePdf: gridfsMocks.deletePdf,
}));

vi.mock("../src/processing/scheduler.js", () => ({
  scheduleAfterResponse: scheduleMock,
}));

vi.mock("../src/processing/driver.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/processing/driver.js")>();
  return { ...original, driveProcessingRun: driveMock };
});

import { startApp, type RunningApp } from "./matters-fake.js";
import { createDocumentsFake, type DocumentsFake } from "./documents-fake.js";
import { parseRangeHeader } from "../src/routes/documents.js";

const URI = "mongodb://localhost:27017/testdb";
const MATTER_ID = "64f1a2b3c4d5e6f7890abc01";
const OTHER_MATTER_ID = "64f1a2b3c4d5e6f7890abc02";
const DOC_ID = "64f1a2b3c4d5e6f7890abc03";
const PDF_BYTES = Buffer.from("%PDF-1.4\ntrailer\n");

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
  gridfsMocks.storePdf.mockResolvedValue(undefined);
  gridfsMocks.deletePdf.mockResolvedValue(undefined);
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
  delete process.env["MAX_PDF_BYTES"];
  await app?.close();
  app = undefined;
});

function seedDoc(overrides: {
  id?: string;
  matterId?: string;
  filename?: string;
  sizeBytes?: number;
  extractionStatus?: "pending" | "processing" | "completed" | "no_text" | "failed";
  extractedText?: string;
  pageCount?: number;
  bytesStored?: boolean;
  extractionError?: string;
}): void {
  fake.state.documents.push({
    _id: new ObjectId(overrides.id ?? DOC_ID),
    matterId: new ObjectId(overrides.matterId ?? MATTER_ID),
    filename: overrides.filename ?? "a.pdf",
    contentType: "application/pdf",
    sizeBytes: overrides.sizeBytes ?? 100,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    ...(overrides.extractionStatus !== undefined
      ? { extractionStatus: overrides.extractionStatus }
      : {}),
    ...(overrides.extractedText !== undefined
      ? { extractedText: overrides.extractedText }
      : {}),
    ...(overrides.pageCount !== undefined ? { pageCount: overrides.pageCount } : {}),
    ...(overrides.bytesStored !== undefined ? { bytesStored: overrides.bytesStored } : {}),
    ...(overrides.extractionError !== undefined
      ? { extractionError: overrides.extractionError }
      : {}),
  });
}

async function postPdf(
  matterId: string,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${(app as RunningApp).baseUrl}/api/matters/${matterId}/documents`, {
    method: "POST",
    headers: { "content-type": "application/pdf", ...headers },
    body,
  });
}

describe("POST upload", () => {
  it("accepts durably and returns 201 without waiting for byte storage", async () => {
    // The response must not wait for the GridFS streaming write: slow
    // uplinks used to push it past client and serverless timeouts even
    // though the work completed.
    let persist: (() => Promise<unknown>) | undefined;
    scheduleMock.mockImplementationOnce(async (task: () => Promise<unknown>) => {
      persist = task;
    });
    app = await startApp(URI);
    const res = await Promise.race([
      postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "Contract.pdf" }),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error("201 timed out")), 5000);
      }),
    ]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    const document = body["document"] as Record<string, unknown>;
    expect(document["id"]).toMatch(/^[0-9a-f]{24}$/);
    expect(document).toMatchObject({
      matterId: MATTER_ID,
      filename: "Contract.pdf",
      contentType: "application/pdf",
      sizeBytes: PDF_BYTES.length,
      bytesStored: false,
    });
    expect(body["processing"]).toBeNull();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(fake.state.documents).toHaveLength(1);
    expect(persist).toBeDefined();
  });

  it("persists bytes, flips the stored flag, then starts processing", async () => {
    let persist: (() => Promise<unknown>) | undefined;
    scheduleMock.mockImplementationOnce(async (task: () => Promise<unknown>) => {
      persist = task;
    });
    app = await startApp(URI);
    const res = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "Contract.pdf" });
    expect(res.status).toBe(201);
    expect(gridfsMocks.storePdf).not.toHaveBeenCalled();
    await persist?.();
    expect(gridfsMocks.storePdf).toHaveBeenCalledTimes(1);
    const stored = gridfsMocks.storePdf.mock.calls[0];
    expect(stored?.[1]).toBeInstanceOf(ObjectId);
    expect(stored?.[2]).toBe("Contract.pdf");
    expect(stored?.[3]).toEqual(PDF_BYTES);
    expect(fake.state.documents[0]).toMatchObject({ bytesStored: true });
    expect(driveMock).toHaveBeenCalledTimes(1);
    const driven = driveMock.mock.calls[0];
    expect(driven?.[0]).toBeInstanceOf(ObjectId);
  });

  it("still returns 201 when scheduling fails; recovery fails the record later", async () => {
    silenceErrors();
    scheduleMock.mockRejectedValueOnce(new Error("no waitUntil context"));
    app = await startApp(URI);
    const res = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "a.pdf" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["processing"]).toBeNull();
    expect(fake.state.documents).toHaveLength(1);
    expect(fake.state.documents[0]).toMatchObject({ bytesStored: false });
  });

  it("rejects invalid uploads with 400", async () => {
    app = await startApp(URI);
    const badContentType = await postPdf(MATTER_ID, PDF_BYTES, {
      "x-filename": "a.pdf",
      "content-type": "text/plain",
    });
    expect(badContentType.status).toBe(400);
    const missingName = await postPdf(MATTER_ID, PDF_BYTES);
    expect(missingName.status).toBe(400);
    const badName = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "a.txt" });
    expect(badName.status).toBe(400);
    const badBytes = await postPdf(MATTER_ID, Buffer.from("not a pdf at all"), {
      "x-filename": "a.pdf",
    });
    expect(badBytes.status).toBe(400);
    expect(gridfsMocks.storePdf).not.toHaveBeenCalled();
    expect(fake.state.documents).toHaveLength(0);
  });

  it("rejects oversize uploads with 413", async () => {
    process.env["MAX_PDF_BYTES"] = "1024";
    app = await startApp(URI);
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(2048)]);
    const res = await postPdf(MATTER_ID, big, { "x-filename": "big.pdf" });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("file_too_large");
    expect(gridfsMocks.storePdf).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed matter id and 404 for a missing matter", async () => {
    app = await startApp(URI);
    const bad = await postPdf("nope", PDF_BYTES, { "x-filename": "a.pdf" });
    expect(bad.status).toBe(400);
    const missing = await postPdf(OTHER_MATTER_ID, PDF_BYTES, { "x-filename": "a.pdf" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "matter_not_found" });
  });

  it("fails the record as interrupted when the background store fails", async () => {
    silenceErrors();
    let persist: (() => Promise<unknown>) | undefined;
    scheduleMock.mockImplementationOnce(async (task: () => Promise<unknown>) => {
      persist = task;
    });
    gridfsMocks.storePdf.mockRejectedValueOnce(new Error("chunk write failed"));
    app = await startApp(URI);
    const res = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "a.pdf" });
    expect(res.status).toBe(201);
    await persist?.();
    expect(fake.state.documents[0]).toMatchObject({
      bytesStored: false,
      extractionStatus: "failed",
      extractionError: "upload_interrupted",
    });
    expect(driveMock).not.toHaveBeenCalled();
  });

  it("cleans orphaned bytes when the document is deleted mid-store", async () => {
    let persist: (() => Promise<unknown>) | undefined;
    scheduleMock.mockImplementationOnce(async (task: () => Promise<unknown>) => {
      persist = task;
    });
    app = await startApp(URI);
    const res = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "a.pdf" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: { id: string } };
    const deleted = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${body.document.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);
    await persist?.();
    expect(gridfsMocks.deletePdf).toHaveBeenCalled();
    expect(driveMock).not.toHaveBeenCalled();
  });

  it("returns 503 without touching storage when the metadata insert fails", async () => {
    silenceErrors();
    fake.documents.insertOne.mockRejectedValueOnce(new Error("duplicate key"));
    app = await startApp(URI);
    const res = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "a.pdf" });
    expect(res.status).toBe(503);
    expect(gridfsMocks.storePdf).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(fake.state.documents).toHaveLength(0);
  });
});

describe("GET list", () => {
  it("lists only the matter's documents, newest first", async () => {
    fake.state.documents.push(
      {
        _id: new ObjectId("64f1a2b3c4d5e6f7890abc10"),
        matterId: new ObjectId(MATTER_ID),
        filename: "old.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        _id: new ObjectId("64f1a2b3c4d5e6f7890abc11"),
        matterId: new ObjectId(MATTER_ID),
        filename: "new.pdf",
        contentType: "application/pdf",
        sizeBytes: 2,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        _id: new ObjectId("64f1a2b3c4d5e6f7890abc12"),
        matterId: new ObjectId(OTHER_MATTER_ID),
        filename: "other.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    );
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}/documents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((d) => d["filename"])).toEqual(["new.pdf", "old.pdf"]);
  });

  it("returns 404 for a missing matter", async () => {
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters/${OTHER_MATTER_ID}/documents`);
    expect(res.status).toBe(404);
  });
});

describe("GET list includeText", () => {
  it("omits extracted text with includeText=false, keeps it by default", async () => {
    seedDoc({
      extractionStatus: "completed",
      extractedText: "sensitive page text",
      pageCount: 1,
    });
    app = await startApp(URI);
    const light = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents?includeText=false`,
    );
    expect(light.status).toBe(200);
    const lightBody = (await light.json()) as Array<Record<string, unknown>>;
    expect(lightBody).toHaveLength(1);
    expect("extractedText" in (lightBody[0] as Record<string, unknown>)).toBe(false);
    expect(lightBody[0]).toMatchObject({ pageCount: 1, extractionStatus: "completed" });
    const full = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}/documents`);
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as Array<Record<string, unknown>>;
    expect(fullBody[0]).toMatchObject({ extractedText: "sensitive page text" });
  });
});

describe("GET download", () => {
  it("streams the stored bytes as an attachment", async () => {
    seedDoc({ sizeBytes: PDF_BYTES.length });
    gridfsMocks.openPdfDownload.mockReturnValue(Readable.from([PDF_BYTES]));
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="a.pdf"');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it("returns 404 for missing or cross-matter documents", async () => {
    seedDoc({ matterId: OTHER_MATTER_ID });
    app = await startApp(URI);
    const cross = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download`,
    );
    expect(cross.status).toBe(404);
    const missing = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/64f1a2b3c4d5e6f7890abc99/download`,
    );
    expect(missing.status).toBe(404);
    expect(gridfsMocks.openPdfDownload).not.toHaveBeenCalled();
  });

  it("returns 500 without leaking internals when the stream fails", async () => {
    silenceErrors();
    seedDoc({ sizeBytes: PDF_BYTES.length });
    gridfsMocks.openPdfDownload.mockImplementation(
      () =>
        new Readable({
          read() {
            this.destroy(new Error("chunk corrupt"));
          },
        }),
    );
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download`,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("chunk corrupt");
  });

  it("serves inline display and advertises range support", async () => {
    seedDoc({ sizeBytes: PDF_BYTES.length });
    gridfsMocks.openPdfDownload.mockReturnValue(Readable.from([PDF_BYTES]));
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download?inline=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('inline; filename="a.pdf"');
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("access-control-expose-headers")).toContain("Content-Range");
  });

  it("serves single ranges with 206 and GridFS bounds", async () => {
    seedDoc({ sizeBytes: 100 });
    gridfsMocks.openPdfDownload.mockReturnValue(Readable.from([Buffer.alloc(10)]));
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download`,
      { headers: { range: "bytes=10-19" } },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(res.headers.get("content-length")).toBe("10");
    // GridFS end bound is exclusive; HTTP is inclusive.
    expect(gridfsMocks.openPdfDownload).toHaveBeenCalledWith(
      expect.anything(),
      new ObjectId(DOC_ID),
      { start: 10, end: 20 },
    );
  });

  it("supports open-ended and suffix ranges", async () => {
    seedDoc({ sizeBytes: 100 });
    gridfsMocks.openPdfDownload.mockReturnValue(Readable.from([Buffer.alloc(1)]));
    app = await startApp(URI);
    const open = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download`,
      { headers: { range: "bytes=90-" } },
    );
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 90-99/100");
    const suffix = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download`,
      { headers: { range: "bytes=-5" } },
    );
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 95-99/100");
  });

  it("returns 416 for out-of-bounds ranges without touching storage", async () => {
    seedDoc({ sizeBytes: 100 });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download`,
      { headers: { range: "bytes=100-199" } },
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */100");
    expect(gridfsMocks.openPdfDownload).not.toHaveBeenCalled();
  });

  it("falls back to 200 for malformed or multi-range headers", async () => {
    seedDoc({ sizeBytes: PDF_BYTES.length });
    gridfsMocks.openPdfDownload.mockReturnValue(Readable.from([PDF_BYTES]));
    app = await startApp(URI);
    for (const range of ["bytes=0-1,3-4", "nonsense", "bytes=-"]) {
      const res = await fetch(
        `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/download`,
        { headers: { range } },
      );
      expect(res.status).toBe(200);
    }
  });

  it("rejects byte actions on unstored uploads with 409, failed ones with 422", async () => {
    seedDoc({ id: DOC_ID, extractionStatus: "pending", bytesStored: false });
    seedDoc({
      id: "64f1a2b3c4d5e6f7890abc09",
      extractionStatus: "failed",
      extractionError: "upload_interrupted",
      bytesStored: false,
    });
    app = await startApp(URI);
    for (const [id, status, code] of [
      [DOC_ID, 409, "upload_in_progress"],
      ["64f1a2b3c4d5e6f7890abc09", 422, "upload_incomplete"],
    ] as const) {
      const download = await fetch(
        `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${id}/download`,
      );
      expect(download.status).toBe(status);
      expect(await download.json()).toMatchObject({ error: code });
      const process = await fetch(
        `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${id}/process`,
        { method: "POST" },
      );
      expect(process.status).toBe(status);
      expect(await process.json()).toMatchObject({ error: code });
    }
    expect(gridfsMocks.openPdfDownload).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});

describe("parseRangeHeader", () => {
  it("parses closed, open, and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRangeHeader("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader("bytes=-5", 100)).toEqual({ start: 95, end: 99 });
    expect(parseRangeHeader("bytes=0-999", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("ignores absent, malformed, and multi-range headers", () => {
    expect(parseRangeHeader(undefined, 100)).toBeUndefined();
    expect(parseRangeHeader("", 100)).toBeUndefined();
    expect(parseRangeHeader("bytes=0-1, 3-4", 100)).toBeUndefined();
    expect(parseRangeHeader("items=0-1", 100)).toBeUndefined();
    expect(parseRangeHeader("bytes=-", 100)).toBeUndefined();
    expect(parseRangeHeader("bytes=-0", 100)).toBeUndefined();
    expect(parseRangeHeader("bytes=0-9", 0)).toBeUndefined();
  });

  it("rejects unsatisfiable ranges", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=200-300", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=50-40", 100)).toBe("unsatisfiable");
  });
});

describe("GET text", () => {
  it("returns extracted text on demand for completed docs", async () => {
    seedDoc({
      extractionStatus: "completed",
      extractedText: "page one\fpage two",
      pageCount: 2,
    });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/text`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      extractionStatus: "completed",
      extractedText: "page one\fpage two",
      pageCount: 2,
    });
  });

  it("answers the current state without text when extraction is incomplete", async () => {
    seedDoc({ extractionStatus: "processing" });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/text`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["extractionStatus"]).toBe("processing");
    expect("extractedText" in body).toBe(false);
  });

  it("returns 404 for missing or cross-matter documents", async () => {
    seedDoc({ matterId: OTHER_MATTER_ID });
    app = await startApp(URI);
    const cross = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/text`,
    );
    expect(cross.status).toBe(404);
    const missing = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/64f1a2b3c4d5e6f7890abc99/text`,
    );
    expect(missing.status).toBe(404);
  });

  it("returns 400 for malformed ids", async () => {
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters/not-an-id/documents/${DOC_ID}/text`);
    expect(res.status).toBe(400);
  });
});

describe("DELETE", () => {
  it("deletes the bytes and the record, returning 204", async () => {
    seedDoc({});
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
    expect(gridfsMocks.deletePdf).toHaveBeenCalledTimes(1);
    expect(fake.state.documents).toHaveLength(0);
  });

  it("keeps the record and reports 503 when byte deletion fails", async () => {
    silenceErrors();
    seedDoc({});
    gridfsMocks.deletePdf.mockRejectedValueOnce(new Error("AccessDenied"));
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "database_unavailable" });
    expect(text).not.toContain("AccessDenied");
    expect(fake.state.documents).toHaveLength(1);
  });

  it("returns 404 for a missing document", async () => {
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("refuses deletion while processing is actively running", async () => {
    seedDoc({});
    fake.blackhole.findOne.mockResolvedValueOnce({
      _id: new ObjectId(),
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      stage: "analyzing",
      active: true,
      attempts: 0,
      heartbeatAt: new Date(),
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "processing_in_progress" });
    expect(fake.state.documents).toHaveLength(1);
    expect(gridfsMocks.deletePdf).not.toHaveBeenCalled();
  });
});

describe("database failures", () => {
  it("returns 503 database_unavailable when MongoDB fails", async () => {
    silenceErrors();
    getDbMock.mockRejectedValueOnce(new Error("topology closed"));
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}/documents`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "database_unavailable" });
    expect(text).not.toContain("topology closed");
  });
});
