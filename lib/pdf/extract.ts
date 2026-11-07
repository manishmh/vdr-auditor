import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/**
 * Load the ESM-only pdfjs-dist build lazily via dynamic import(). A static
 * import would become a top-level require() of a .mjs file in the CommonJS
 * production bundle, which throws ERR_REQUIRE_ESM on Node runtimes without
 * require(esm) support — crashing every route at load time, including
 * /api/health. Dynamic import() of ESM works from CJS on all supported
 * Node versions, and pdf.js only loads when a PDF actually needs parsing.
 */
async function loadPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  try {
    return await pdfjsPromise;
  } catch (err) {
    pdfjsPromise = null;
    throw err;
  }
}

export type PdfFailureReason = "malformed" | "encrypted" | "too_many_pages" | "missing_assets";

export class PdfExtractionError extends Error {
  readonly reason: PdfFailureReason;
  constructor(reason: PdfFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfExtractionError";
    this.reason = reason;
  }
}

export interface PageText {
  pageNumber: number;
  text: string;
}

export interface ExtractedPdf {
  pages: PageText[];
  pageCount: number;
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

function isTextItem(value: unknown): value is PdfTextItem {
  return typeof value === "object" && value !== null && "str" in value;
}

export interface ExtractOptions {
  /**
   * Override for the pdf.js `standardFontDataUrl` parameter (must end with
   * "/"). Defaults to the locally installed pdfjs-dist `standard_fonts`
   * directory. There is no opt-out: unresolved or missing assets fail
   * extraction with `missing_assets` rather than degrading silently.
   */
  standardFontDataUrl?: string;
}

/**
 * Resolve the pinned pdfjs-dist `standard_fonts` directory for this install.
 * pdf.js reads these files with `fs.readFile` (Node factory), so the value is
 * a local path with a trailing slash — never a remote URL. Returns null when
 * the package layout cannot be resolved (extraction still works; pdf.js warns
 * and falls back to font substitution without the metric files).
 */
export function resolveStandardFontDataUrl(): string | null {
  const candidates: string[] = [];
  try {
    const pkgPath = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");
    candidates.push(join(dirname(pkgPath), "standard_fonts"));
  } catch {
    // Fall through to the cwd-based candidate below.
  }
  candidates.push(join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts"));
  for (const dir of candidates) {
    try {
      if (existsSync(join(dir, "LiberationSans-Regular.ttf"))) return `${dir}/`;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Extract text while preserving page boundaries. One entry per page, in order.
 * Throws PdfExtractionError for malformed, encrypted, or oversized documents.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  maxPages: number,
  options: ExtractOptions = {},
): Promise<ExtractedPdf> {
  // Copy: pdf.js takes ownership of (detaches) the buffer it is given.
  const data = bytes.slice();
  // Fail closed: without the standard-font metric files, pdf.js warns and
  // extracts with font substitution — a successful-looking result built on
  // degraded glyph mapping. Missing assets are an explicit extraction
  // failure (document `failed`, never analyzed), not a warning.
  const standardFontDataUrl =
    options.standardFontDataUrl !== undefined
      ? options.standardFontDataUrl
      : resolveStandardFontDataUrl();
  if (standardFontDataUrl === null) {
    throw new PdfExtractionError(
      "missing_assets",
      "PDF font assets are unavailable; refusing to extract with degraded font mapping.",
    );
  }
  if (!existsSync(standardFontDataUrl)) {
    throw new PdfExtractionError(
      "missing_assets",
      "Configured PDF font assets are missing; refusing to extract with degraded font mapping.",
    );
  }
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, standardFontDataUrl });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    if (err instanceof Error && (err.name === "PasswordException" || /password|encrypted/i.test(err.message))) {
      throw new PdfExtractionError("encrypted", "PDF is encrypted or password-protected.", { cause: err });
    }
    throw new PdfExtractionError("malformed", "File could not be parsed as a PDF.", { cause: err });
  }

  try {
    if (doc.numPages > maxPages) {
      throw new PdfExtractionError(
        "too_many_pages",
        `PDF has ${doc.numPages} pages, above the ${maxPages}-page limit.`,
      );
    }
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const parts: string[] = [];
        for (const raw of content.items) {
          if (!isTextItem(raw) || typeof raw.str !== "string") continue;
          parts.push(raw.str);
          parts.push(raw.hasEOL ? "\n" : " ");
        }
        const text = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        pages.push({ pageNumber: n, text });
      } finally {
        page.cleanup();
      }
    }
    return { pages, pageCount: doc.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

/** Characters of non-whitespace text across all pages. Near-zero means scanned/image PDF. */
export function countSignificantChars(pages: PageText[]): number {
  return pages.reduce((sum, p) => sum + p.text.replace(/\s/g, "").length, 0);
}
