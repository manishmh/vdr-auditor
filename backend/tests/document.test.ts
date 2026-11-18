import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  hasPdfMagic,
  parseDocumentId,
  parseRawUpload,
  sanitizeFilename,
  toDocumentResponse,
  type DocumentRecord,
} from "../src/models/document.js";

const MAX_BYTES = 1024;
const PDF = Buffer.from("%PDF-1.4\ntrailer\n");

describe("sanitizeFilename", () => {
  it("strips directories and keeps the base name", () => {
    expect(sanitizeFilename("..\\..\\etc\\evil.pdf")).toBe("evil.pdf");
    expect(sanitizeFilename("/tmp/../contract.pdf")).toBe("contract.pdf");
  });

  it("strips control characters, quotes, and backslashes", () => {
    expect(sanitizeFilename('a"b\\c\x00d\x1F.pdf')).toBe("cd.pdf");
  });

  it("falls back when nothing safe remains", () => {
    expect(sanitizeFilename('"""')).toBe("document.pdf");
  });

  it("caps length at 255 characters", () => {
    expect(sanitizeFilename(`${"a".repeat(300)}.pdf`)).toHaveLength(255);
  });
});

describe("hasPdfMagic", () => {
  it("accepts bytes starting with %PDF-", () => {
    expect(hasPdfMagic(PDF)).toBe(true);
  });

  it("rejects short or non-PDF bytes", () => {
    expect(hasPdfMagic(Buffer.from("%PD"))).toBe(false);
    expect(hasPdfMagic(Buffer.from("not a pdf at all"))).toBe(false);
    expect(hasPdfMagic(Buffer.alloc(0))).toBe(false);
  });
});

describe("parseRawUpload", () => {
  it("accepts a valid raw upload", () => {
    const result = parseRawUpload("Contract.pdf", "application/pdf", PDF, MAX_BYTES);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filename).toBe("Contract.pdf");
      expect(result.value.sizeBytes).toBe(PDF.length);
      expect(result.value.body).toBe(PDF);
    }
  });

  it("decodes an encoded filename header", () => {
    const result = parseRawUpload("my%20contract.pdf", "application/pdf", PDF, MAX_BYTES);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filename).toBe("my contract.pdf");
    }
  });

  it("rejects a missing, blank, or over-long filename", () => {
    for (const filename of [undefined, null, "", "   ", "x".repeat(256)]) {
      const result = parseRawUpload(filename, "application/pdf", PDF, MAX_BYTES);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.field === "filename")).toBe(true);
      }
    }
  });

  it("rejects non-PDF filenames", () => {
    for (const filename of ["notes.txt", "archive.zip", "evil.pdf.exe"]) {
      const result = parseRawUpload(filename, "application/pdf", PDF, MAX_BYTES);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual({
          field: "filename",
          message: "Only PDF files are accepted.",
        });
      }
    }
  });

  it("rejects non-PDF content types", () => {
    for (const contentType of [undefined, "text/plain", "application/octet-stream"]) {
      const result = parseRawUpload("a.pdf", contentType, PDF, MAX_BYTES);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.field === "contentType")).toBe(true);
      }
    }
  });

  it("rejects missing or empty bodies", () => {
    for (const body of [undefined, null, {}, Buffer.alloc(0), "text"]) {
      const result = parseRawUpload("a.pdf", "application/pdf", body, MAX_BYTES);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.field === "body")).toBe(true);
      }
    }
  });

  it("flags over-limit bodies for HTTP 413", () => {
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(MAX_BYTES)]);
    const result = parseRawUpload("a.pdf", "application/pdf", big, MAX_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          field: "body",
          message: `File is larger than the ${MAX_BYTES}-byte limit.`,
          code: "file_too_large",
        },
      ]);
    }
  });

  it("rejects bodies without the PDF magic header", () => {
    const result = parseRawUpload(
      "a.pdf",
      "application/pdf",
      Buffer.from("definitely not a pdf"),
      MAX_BYTES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        field: "body",
        message: "Only PDF files are accepted.",
      });
    }
  });

  it("ignores client-supplied ids and storage references by construction", () => {
    // parseRawUpload only reads the filename header, content type, and
    // measured bytes, so there is no channel for ids, keys, or timestamps.
    const result = parseRawUpload("a.pdf", "application/pdf", PDF, MAX_BYTES);
    expect(result).toEqual({
      ok: true,
      value: { filename: "a.pdf", sizeBytes: PDF.length, body: PDF },
    });
  });
});

describe("parseDocumentId", () => {
  it("parses a valid 24-hex id", () => {
    const parsed = parseDocumentId("64f1a2b3c4d5e6f7890abcde");
    expect(parsed).toBeInstanceOf(ObjectId);
  });

  it("returns undefined for malformed ids", () => {
    for (const id of ["", "nope", "64f1a2b3c4d5e6f7890abcdeg"]) {
      expect(parseDocumentId(id)).toBeUndefined();
    }
  });
});

describe("toDocumentResponse", () => {
  it("maps ids to hex strings and dates to ISO strings", () => {
    const doc: DocumentRecord = {
      _id: new ObjectId("64f1a2b3c4d5e6f7890abcde"),
      matterId: new ObjectId("64f1a2b3c4d5e6f7890abcdf"),
      filename: "a.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      updatedAt: new Date("2026-01-02T03:04:05.000Z"),
    };
    const body = toDocumentResponse(doc);
    expect(body).toEqual({
      id: "64f1a2b3c4d5e6f7890abcde",
      matterId: "64f1a2b3c4d5e6f7890abcdf",
      filename: "a.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(body).not.toHaveProperty("_id");
  });
});
