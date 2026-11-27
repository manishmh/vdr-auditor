import { describe, expect, it, vi } from "vitest";
import {
  PAGE_SEPARATOR,
  extractPdfText,
  type ExtractionResult,
} from "../src/extraction/service.js";
import type { PdfDocumentLike } from "../src/extraction/pdfLoader.js";
import { buildCorruptPdf, buildPdf } from "./pdf-fixtures.js";

function fakeLoader(pages: string[][], numPages?: number): () => Promise<PdfDocumentLike> {
  return async () => ({
    numPages: numPages ?? pages.length,
    getPage: async (n: number) => ({
      getTextContent: async () => ({
        items: [{ str: (pages[n - 1] ?? []).join(" "), hasEOL: false }],
      }),
    }),
    cleanup: async () => undefined,
  });
}

describe("extractPdfText with real PDFs", () => {
  it("extracts text preserving page boundaries", async () => {
    const bytes = buildPdf([["Hello page one"], ["Second page here"]]);
    const result: ExtractionResult = await extractPdfText(new Uint8Array(bytes));
    expect(result.ok).toBe(true);
    if (result.ok && result.status === "completed") {
      expect(result.pageCount).toBe(2);
      expect(result.pages).toEqual(["Hello page one", "Second page here"]);
      expect(result.text).toBe(`Hello page one${PAGE_SEPARATOR}Second page here`);
    } else {
      expect.unreachable("expected completed extraction");
    }
  });

  it("joins lines within a page", async () => {
    const bytes = buildPdf([["First line", "Second line"]]);
    const result = await extractPdfText(new Uint8Array(bytes));
    expect(result.ok).toBe(true);
    if (result.ok && result.status === "completed") {
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0]).toContain("First line");
      expect(result.pages[0]).toContain("Second line");
    } else {
      expect.unreachable("expected completed extraction");
    }
  });

  it("reports no_text for PDFs without a text layer", async () => {
    const bytes = buildPdf([[], []]);
    const result = await extractPdfText(new Uint8Array(bytes));
    expect(result).toEqual({ ok: true, status: "no_text", pageCount: 2 });
  });

  it("reports unparseable for malformed PDFs", async () => {
    const result = await extractPdfText(new Uint8Array(buildCorruptPdf()));
    expect(result).toEqual({ ok: false, code: "unparseable" });
  });
});

describe("extractPdfText page trimming", () => {
  it("reports zero offset when no pages are trimmed", async () => {
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), {
      load: fakeLoader([["one"], ["two"]]),
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.status === "completed") {
      expect(result.pages).toHaveLength(2);
      expect(result.pageOffset).toBe(0);
    } else {
      expect.unreachable("expected completed extraction");
    }
  });

  it("counts leading blank pages as the offset, trailing as unnumbered", async () => {
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), {
      load: fakeLoader([[], [], ["body"], []]),
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.status === "completed") {
      expect(result.pageCount).toBe(4);
      expect(result.pages).toEqual(["body"]);
      expect(result.pageOffset).toBe(2);
    } else {
      expect.unreachable("expected completed extraction");
    }
  });
});

describe("extractPdfText input handling", () => {
  it("accepts a raw Node Buffer", async () => {
    const result = await extractPdfText(buildPdf([["buffered"]]));
    expect(result.ok).toBe(true);
    if (result.ok && result.status === "completed") {
      expect(result.text).toBe("buffered");
    } else {
      expect.unreachable("expected completed extraction");
    }
  });
});

describe("extractPdfText limits and loader failures", () => {
  it("refuses documents over the page cap", async () => {
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), {
      load: fakeLoader([], 500),
      maxPages: 200,
    });
    expect(result).toEqual({ ok: false, code: "limit_exceeded" });
  });

  it("refuses output over the character cap", async () => {
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), {
      load: fakeLoader([["x".repeat(100)]]),
      maxChars: 10,
    });
    expect(result).toEqual({ ok: false, code: "limit_exceeded" });
  });

  it("maps password errors to encrypted", async () => {
    const load = vi.fn(async (): Promise<PdfDocumentLike> => {
      const err = new Error("needs password");
      err.name = "PasswordException";
      throw err;
    });
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), { load });
    expect(result).toEqual({ ok: false, code: "encrypted" });
  });

  it("maps unexpected loader failures to unparseable", async () => {
    const load = vi.fn(async (): Promise<PdfDocumentLike> => {
      throw new Error("boom");
    });
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), { load });
    expect(result).toEqual({ ok: false, code: "unparseable" });
  });

  it("maps per-page failures to unparseable", async () => {
    const load = async (): Promise<PdfDocumentLike> => ({
      numPages: 1,
      getPage: async () => {
        throw new Error("bad page");
      },
      cleanup: async () => undefined,
    });
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), { load });
    expect(result).toEqual({ ok: false, code: "unparseable" });
  });

  it("always releases the document, even on failure", async () => {
    const cleanup = vi.fn(async () => undefined);
    const load = async (): Promise<PdfDocumentLike> => ({
      numPages: 1,
      getPage: async () => {
        throw new Error("bad page");
      },
      cleanup,
    });
    await extractPdfText(new Uint8Array([1, 2, 3]), { load });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
