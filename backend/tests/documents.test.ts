import { Readable } from "node:stream";
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, gridfsMocks } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  gridfsMocks: {
    storePdf: vi.fn(),
    openPdfDownload: vi.fn(),
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
  deletePdf: gridfsMocks.deletePdf,
}));

import { startApp, type RunningApp } from "./matters-fake.js";
import { createDocumentsFake, type DocumentsFake } from "./documents-fake.js";

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
}): void {
  fake.state.documents.push({
    _id: new ObjectId(overrides.id ?? DOC_ID),
    matterId: new ObjectId(overrides.matterId ?? MATTER_ID),
    filename: overrides.filename ?? "a.pdf",
    contentType: "application/pdf",
    sizeBytes: overrides.sizeBytes ?? 100,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
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
  it("stores PDF bytes and returns 201 with the record", async () => {
    app = await startApp(URI);
    const res = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "Contract.pdf" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toMatch(/^[0-9a-f]{24}$/);
    expect(body).toMatchObject({
      matterId: MATTER_ID,
      filename: "Contract.pdf",
      contentType: "application/pdf",
      sizeBytes: PDF_BYTES.length,
    });
    expect(gridfsMocks.storePdf).toHaveBeenCalledTimes(1);
    const stored = gridfsMocks.storePdf.mock.calls[0];
    expect(stored?.[1]).toBeInstanceOf(ObjectId);
    expect(stored?.[2]).toBe("Contract.pdf");
    expect(stored?.[3]).toEqual(PDF_BYTES);
    expect(fake.state.documents).toHaveLength(1);
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

  it("returns 503 without a record when byte storage fails", async () => {
    silenceErrors();
    gridfsMocks.storePdf.mockRejectedValueOnce(new Error("chunk write failed"));
    app = await startApp(URI);
    const res = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "a.pdf" });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "database_unavailable" });
    expect(text).not.toContain("chunk write failed");
    expect(fake.state.documents).toHaveLength(0);
  });

  it("removes stored bytes when the metadata insert fails", async () => {
    silenceErrors();
    fake.documents.insertOne.mockRejectedValueOnce(new Error("duplicate key"));
    app = await startApp(URI);
    const res = await postPdf(MATTER_ID, PDF_BYTES, { "x-filename": "a.pdf" });
    expect(res.status).toBe(503);
    expect(gridfsMocks.deletePdf).toHaveBeenCalledTimes(1);
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
