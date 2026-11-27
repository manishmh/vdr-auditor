import { describe, expect, it } from "vitest";
import {
  isAwaitingUpload,
  uploadError,
  type MatterDocument,
} from "../lib/documents";

function doc(overrides: Partial<MatterDocument> = {}): MatterDocument {
  return {
    id: "d1",
    matterId: "m1",
    filename: "a.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    extractionStatus: "pending",
    ...overrides,
  };
}

describe("isAwaitingUpload", () => {
  it("waits only on explicitly unstored, non-failed documents", () => {
    expect(isAwaitingUpload(doc({ bytesStored: false }))).toBe(true);
    expect(isAwaitingUpload(doc({ bytesStored: true }))).toBe(false);
    expect(isAwaitingUpload(doc({}))).toBe(false);
    expect(
      isAwaitingUpload(doc({ bytesStored: false, extractionStatus: "failed" })),
    ).toBe(false);
  });
});

describe("uploadError", () => {
  it("maps size rejections in any body shape to the too-large message", () => {
    expect(uploadError(413, "<html>Request Entity Too Large</html>").message).toContain(
      "too large",
    );
    expect(uploadError(413, "").message).toContain("too large");
    expect(uploadError(400, JSON.stringify({ error: "file_too_large" })).message).toContain(
      "too large",
    );
    expect(
      uploadError(
        400,
        JSON.stringify({ error: "validation_error", issues: [{ code: "file_too_large" }] }),
      ).message,
    ).toContain("too large");
  });

  it("maps invalid PDFs and missing matters", () => {
    expect(
      uploadError(400, JSON.stringify({ error: "validation_error", issues: [] })).message,
    ).toContain("isn't a valid PDF");
    expect(uploadError(400, JSON.stringify({ error: "validation_error" })).message).toContain(
      "isn't a valid PDF",
    );
    expect(uploadError(404, JSON.stringify({ error: "matter_not_found" })).message).toContain(
      "couldn't find that matter",
    );
  });

  it("maps busy and timed-out servers to retryable messages", () => {
    expect(
      uploadError(503, JSON.stringify({ error: "database_unavailable" })).message,
    ).toContain("busy");
    expect(uploadError(503, "").message).toContain("busy");
    expect(uploadError(504, "<html>Gateway Timeout</html>").message).toContain("timed out");
    expect(uploadError(502, "").message).toContain("timed out");
  });

  it("keeps a generic fallback with the status attached", () => {
    const err = uploadError(500, JSON.stringify({ error: "internal_error" }));
    expect(err.message).toContain("upload failed");
    expect(err.httpStatus).toBe(500);
  });
});
