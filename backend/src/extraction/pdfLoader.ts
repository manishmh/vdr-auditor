import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Minimal structural view of a loaded PDF, decoupled from the pdf.js API
 * surface so tests can substitute a fake loader.
 */
export interface PdfPageLike {
  getTextContent(): Promise<{
    items: Array<{ str?: unknown; hasEOL?: unknown } | unknown>;
  }>;
}

export interface PdfDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  cleanup(): Promise<unknown>;
}

export type PdfLoader = (bytes: Uint8Array) => Promise<PdfDocumentLike>;

/**
 * Parse PDF bytes with Mozilla PDF.js. Runs on the main thread (no worker):
 * deterministic and serverless-safe.
 */
export async function loadPdfDocument(bytes: Uint8Array): Promise<PdfDocumentLike> {
  // pdf.js requires a plain Uint8Array; a Node Buffer is rejected even
  // though it subclasses Uint8Array, so normalize with one copy.
  const data = new Uint8Array(bytes);
  // Imported lazily: the pdf.js bundle is large, and most requests (health,
  // lists, findings) never touch it. A static import would tax every cold
  // serverless boot and spam every cold log with its warnings.
  //
  // The worker module is imported first with a literal path on purpose:
  // pdf.js loads it through a dynamic import that serverless file tracers
  // cannot see, so without this line (or the vercel.json pin) the file is
  // missing in production and every extraction fails. The import itself is
  // side-effect free (it only defines the message handler).
  void await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc: PDFDocumentProxy = await getDocument({
    data,
    useWorkerFetch: false,
    useSystemFonts: true,
  }).promise;
  return doc as unknown as PdfDocumentLike;
}
