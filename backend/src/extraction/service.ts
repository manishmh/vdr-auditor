import { loadPdfDocument, type PdfLoader } from "./pdfLoader.js";

/** Maximum pages read from one PDF before refusing with `limit_exceeded`. */
export const MAX_EXTRACT_PAGES = 200;
/** Maximum extracted characters kept before refusing with `limit_exceeded`. */
export const MAX_EXTRACT_CHARS = 500_000;
/** Joins page texts in `extractedText`; clients split on it to show pages. */
export const PAGE_SEPARATOR = "\u000c";

export type ExtractionFailureCode = "encrypted" | "unparseable" | "limit_exceeded";

export type ExtractionResult =
  | {
      ok: true;
      status: "completed";
      pages: string[];
      pageCount: number;
      text: string;
    }
  | { ok: true; status: "no_text"; pageCount: number }
  | { ok: false; code: ExtractionFailureCode };

export interface ExtractOptions {
  load?: PdfLoader;
  maxPages?: number;
  maxChars?: number;
}

function isPasswordError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "PasswordException"
  );
}

function itemText(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || !("str" in item)) {
    return undefined;
  }
  const str = (item as { str?: unknown }).str;
  return typeof str === "string" ? str : undefined;
}

function itemHasEol(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as { hasEOL?: unknown }).hasEOL === true
  );
}

function normalizePageText(raw: string): string {
  return raw
    .replace(/ ?\n ?/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract readable text from PDF bytes, one string per page. Never throws
 * for document problems: those return `{ ok: false, code }` instead.
 * Never logs document contents.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const {
    load = loadPdfDocument,
    maxPages = MAX_EXTRACT_PAGES,
    maxChars = MAX_EXTRACT_CHARS,
  } = options;

  let doc;
  try {
    doc = await load(bytes);
  } catch (err: unknown) {
    return { ok: false, code: isPasswordError(err) ? "encrypted" : "unparseable" };
  }

  try {
    const pageCount = doc.numPages;
    if (!Number.isInteger(pageCount) || pageCount < 0 || pageCount > maxPages) {
      return { ok: false, code: pageCount > maxPages ? "limit_exceeded" : "unparseable" };
    }
    const pages: string[] = [];
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      let content;
      try {
        const page = await doc.getPage(pageNumber);
        content = await page.getTextContent();
      } catch {
        return { ok: false, code: "unparseable" };
      }
      const parts: string[] = [];
      for (const item of content.items) {
        const str = itemText(item);
        if (str === undefined) {
          continue;
        }
        parts.push(str);
        if (itemHasEol(item)) {
          parts.push("\n");
        }
      }
      const pageText = normalizePageText(parts.join(""));
      totalChars += pageText.length;
      if (totalChars > maxChars) {
        return { ok: false, code: "limit_exceeded" };
      }
      pages.push(pageText);
    }
    while (pages.length > 0 && pages[0] === "") {
      pages.shift();
    }
    while (pages.length > 0 && pages[pages.length - 1] === "") {
      pages.pop();
    }
    const text = pages.join(PAGE_SEPARATOR);
    if (text.replace(/\s/g, "").length === 0) {
      return { ok: true, status: "no_text", pageCount };
    }
    return { ok: true, status: "completed", pages, pageCount, text };
  } finally {
    try {
      await doc.cleanup();
    } catch {
      // Best-effort resource release; never fails the extraction itself.
    }
  }
}
