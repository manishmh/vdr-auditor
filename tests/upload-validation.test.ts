import { describe, expect, it } from "vitest";
import {
  isDeclaredBodyTooLarge,
  sanitizeDisplayName,
  UploadValidationError,
  validateUpload,
} from "@/lib/pdf/validate";
import { makePdf } from "./helpers/make-pdf";

const MAX = 1024 * 1024;

function pdfBytes(): Uint8Array {
  return makePdf(["validation fixture"]);
}

describe("validateUpload", () => {
  it("accepts a valid PDF and returns a stable sha256", async () => {
    const first = await validateUpload(
      { filename: "contract.pdf", mimeType: "application/pdf", size: pdfBytes().length, bytes: pdfBytes() },
      MAX,
    );
    const second = await validateUpload(
      { filename: "contract.pdf", mimeType: "application/pdf", size: pdfBytes().length, bytes: pdfBytes() },
      MAX,
    );
    expect(first.filename).toBe("contract.pdf");
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects empty files", async () => {
    const err = await validateUpload(
      { filename: "empty.pdf", mimeType: "application/pdf", size: 0, bytes: new Uint8Array(0) },
      MAX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as UploadValidationError).reason).toBe("empty_file");
  });

  it("rejects oversized files with 413", async () => {
    const bytes = pdfBytes();
    const err = await validateUpload(
      { filename: "big.pdf", mimeType: "application/pdf", size: bytes.length, bytes },
      10,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadValidationError);
    const typed = err as UploadValidationError;
    expect(typed.reason).toBe("too_large");
    expect(typed.status).toBe(413);
  });

  it("rejects non-pdf extensions", async () => {
    const bytes = pdfBytes();
    const err = await validateUpload(
      { filename: "contract.txt", mimeType: "application/pdf", size: bytes.length, bytes },
      MAX,
    ).catch((e: unknown) => e);
    expect((err as UploadValidationError).reason).toBe("bad_extension");
  });

  it("rejects content that is not a PDF regardless of extension", async () => {
    const bytes = new TextEncoder().encode("MZ fake executable content here");
    const err = await validateUpload(
      { filename: "evil.pdf", mimeType: "application/pdf", size: bytes.length, bytes },
      MAX,
    ).catch((e: unknown) => e);
    expect((err as UploadValidationError).reason).toBe("not_a_pdf");
  });

  it("strips directory components from filenames", async () => {
    const bytes = pdfBytes();
    const result = await validateUpload(
      { filename: "..\\..\\evil.pdf", mimeType: "application/pdf", size: bytes.length, bytes },
      MAX,
    );
    expect(result.filename).toBe("evil.pdf");
    expect(result.filename).not.toContain("..");
  });
});

describe("sanitizeDisplayName", () => {
  it("removes path separators and control characters", () => {
    expect(sanitizeDisplayName('a/b\\c:d"e.pdf')).toBe("a_b_c_d_e.pdf");
    expect(sanitizeDisplayName("")).toBe("document.pdf");
  });
});

describe("isDeclaredBodyTooLarge", () => {
  it("rejects declared bodies over the cap plus multipart slack", () => {
    expect(isDeclaredBodyTooLarge(String(MAX + 1024 * 1024 + 1), MAX)).toBe(true);
    expect(isDeclaredBodyTooLarge(String(MAX), MAX)).toBe(false);
    expect(isDeclaredBodyTooLarge(String(MAX + 512), MAX)).toBe(false);
  });

  it("falls through to the post-parse check when the length is absent or unusable", () => {
    expect(isDeclaredBodyTooLarge(null, MAX)).toBe(false);
    expect(isDeclaredBodyTooLarge("not-a-number", MAX)).toBe(false);
    expect(isDeclaredBodyTooLarge("-10", MAX)).toBe(false);
  });
});
