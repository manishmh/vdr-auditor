import {
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

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
  const doc: PDFDocumentProxy = await getDocument({
    data,
    useWorkerFetch: false,
    useSystemFonts: true,
  }).promise;
  return doc as unknown as PdfDocumentLike;
}
