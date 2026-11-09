import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { normalizeText } from "@/lib/evidence";
import {
  countSignificantChars,
  extractPdfText,
  PdfExtractionError,
  resolveStandardFontDataUrl,
} from "@/lib/pdf/extract";
import { makeCompressedPdf, makePdf } from "./helpers/make-pdf";

function consoleNoise(): { warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> } {
  return { warn: vi.spyOn(console, "warn"), error: vi.spyOn(console, "error") };
}

function mentionedFontUrl(spies: { warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> }): boolean {
  const calls: unknown[][] = [...spies.warn.mock.calls, ...spies.error.mock.calls];
  return calls.some((args) => args.some((a) => String(a).includes("standardFontDataUrl")));
}

describe("extractPdfText", () => {
  it("extracts text while preserving page boundaries", async () => {
    const bytes = makePdf([
      "Page one contract terms and conditions apply here.",
      "Page two signature block follows below.",
    ]);
    const result = await extractPdfText(bytes, 200);
    expect(result.pageCount).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].pageNumber).toBe(1);
    expect(result.pages[1].pageNumber).toBe(2);
    expect(normalizeText(result.pages[0].text)).toContain("Page one contract terms");
    expect(normalizeText(result.pages[1].text)).toContain("Page two signature block");
    expect(result.pages[0].text).not.toContain("Page two");
  });

  it("handles multi-line pages and blank pages", async () => {
    const bytes = makePdf(["First line\nSecond line", ""]);
    const result = await extractPdfText(bytes, 200);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].text).toContain("First line");
    expect(result.pages[0].text).toContain("Second line");
    expect(result.pages[1].text).toBe("");
  });

  it("extracts text from FlateDecode-compressed streams", async () => {
    const bytes = makeCompressedPdf([
      "Compressed page one with change of control language.",
      "Compressed page two with signatures.",
    ]);
    const result = await extractPdfText(bytes, 200);
    expect(result.pageCount).toBe(2);
    expect(normalizeText(result.pages[0].text)).toContain("Compressed page one");
    expect(normalizeText(result.pages[1].text)).toContain("Compressed page two");
  });

  it("parses a header offset by leading bytes", async () => {
    const valid = makePdf(["Offset header clause with change of control language."]);
    const offset = new Uint8Array([...new Uint8Array(64).fill(0x0a), ...valid]);
    const result = await extractPdfText(offset, 200);
    expect(result.pageCount).toBe(1);
    expect(normalizeText(result.pages[0].text)).toContain("Offset header clause");
  });

  it("preserves the underlying parser exception as cause", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\n%not really a pdf at all, just text\n");
    const err = await extractPdfText(bytes, 200).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfExtractionError);
    expect((err as PdfExtractionError).reason).toBe("malformed");
    expect((err as PdfExtractionError).cause).toBeInstanceOf(Error);
  });

  it("rejects a file that is not a PDF", async () => {
    const err = await extractPdfText(new TextEncoder().encode("just some text"), 200).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PdfExtractionError);
    expect((err as PdfExtractionError).reason).toBe("malformed");
  });

  it("rejects a truncated PDF", async () => {
    const full = makePdf(["hello"]);
    const err = await extractPdfText(full.slice(0, 40), 200).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfExtractionError);
    expect((err as PdfExtractionError).reason).toBe("malformed");
  });

  it("enforces the page cap before extracting", async () => {
    const bytes = makePdf(["one", "two"]);
    const err = await extractPdfText(bytes, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfExtractionError);
    expect((err as PdfExtractionError).reason).toBe("too_many_pages");
  });

  it("keeps 1-based page numbering with a blank middle page", async () => {
    const bytes = makePdf(["alpha terms", "", "gamma signature"]);
    const result = await extractPdfText(bytes, 200);
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages[0].text).toContain("alpha terms");
    expect(result.pages[1].text).toBe("");
    expect(result.pages[2].text).toContain("gamma signature");
    expect(result.pages[2].text).not.toContain("alpha");
  });

  it("extracts punctuation, parentheses, and typographic characters", async () => {
    const bytes = makePdf(["“Change-of-control” — §4.2: buyer’s consent (see p. 3)… €1m • © 2026"]);
    const result = await extractPdfText(bytes, 200);
    const text = result.pages[0].text;
    for (const ch of ["“", "”", "—", "§", "’", "(", ")", "…", "€", "•", "©"]) {
      expect(text).toContain(ch);
    }
    expect(text).toContain("Change-of-control");
  });

  it("treats whitespace-only pages as empty text", async () => {
    const bytes = makePdf(["real text", "   "]);
    const result = await extractPdfText(bytes, 200);
    expect(result.pages[1].text).toBe("");
  });

  it("rejects empty input as malformed", async () => {
    const err = await extractPdfText(new Uint8Array(0), 200).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfExtractionError);
    expect((err as PdfExtractionError).reason).toBe("malformed");
  });

  it("emits no standardFontDataUrl warning for standard-font PDFs", async () => {
    const spies = consoleNoise();
    try {
      const result = await extractPdfText(makePdf(["plain Helvetica contract text"]), 200);
      expect(result.pages[0].text).toContain("plain Helvetica contract text");
      expect(mentionedFontUrl(spies)).toBe(false);
    } finally {
      spies.warn.mockRestore();
      spies.error.mockRestore();
    }
  });

  it("resolves standard font assets to an existing local directory", () => {
    const url = resolveStandardFontDataUrl();
    expect(url).not.toBeNull();
    expect(url).toMatch(/\/$/);
    expect(existsSync(`${url}LiberationSans-Regular.ttf`)).toBe(true);
    expect(existsSync(`${url}FoxitSerif.pfb`)).toBe(true);
  });

  it("fails extraction explicitly when font assets are misconfigured", async () => {
    // Fail closed: missing font metric files must never yield a
    // successful-looking analysis built on degraded glyph mapping.
    const err = await extractPdfText(makePdf(["degraded but readable"]), 200, {
      standardFontDataUrl: "/nonexistent-font-dir-9f8e7d6c/",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfExtractionError);
    expect((err as PdfExtractionError).reason).toBe("missing_assets");
  });
});

describe("countSignificantChars", () => {
  it("counts non-whitespace characters across pages", () => {
    expect(
      countSignificantChars([
        { pageNumber: 1, text: "  ab\n cd " },
        { pageNumber: 2, text: "" },
      ]),
    ).toBe(4);
  });
});
