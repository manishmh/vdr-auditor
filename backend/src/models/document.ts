import { ObjectId } from "mongodb";

export const DOCUMENT_FILENAME_MAX_LENGTH = 255;
export const PDF_CONTENT_TYPE = "application/pdf";

export const EXTRACTION_STATUSES = [
  "pending",
  "processing",
  "completed",
  "no_text",
  "failed",
] as const;
export type DocumentExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/**
 * Native MongoDB metadata shape. PDF bytes live in GridFS under the same
 * `_id`, so no separate storage reference is needed. Extraction fields are
 * optional so records written before extraction existed still map cleanly.
 */
export interface DocumentRecord {
  _id: ObjectId;
  matterId: ObjectId;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
  extractionStatus?: DocumentExtractionStatus;
  extractedText?: string;
  pageCount?: number;
  extractedAt?: Date;
  extractionError?: string;
}

/** API response shape. Never includes storage internals. */
export interface MatterDocument {
  id: string;
  matterId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  extractionStatus: DocumentExtractionStatus;
  extractedText?: string;
  pageCount?: number;
  extractedAt?: string;
  extractionError?: string;
}

export interface UploadValidationIssue {
  field: string;
  message: string;
  code?: "file_too_large";
}

export interface ValidatedRawUpload {
  filename: string;
  sizeBytes: number;
  body: Buffer;
}

export type RawUploadParseResult =
  | { ok: true; value: ValidatedRawUpload }
  | { ok: false; issues: UploadValidationIssue[] };

/**
 * Sanitize a user-supplied filename for display and for use in download
 * headers. Strips directories, control characters, and quote/backslash
 * characters that would break a Content-Disposition value.
 */
export function sanitizeFilename(name: string): string {
  const segments = name.split(/[\\/]/);
  const base = (segments[segments.length - 1] ?? "").trim();
  const cleaned = base.replace(/[\x00-\x1F\x7F"\\]/g, "").trim();
  if (cleaned === "") {
    return "document.pdf";
  }
  return cleaned.slice(0, DOCUMENT_FILENAME_MAX_LENGTH);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-

/** Verify bytes start with the PDF magic header. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) {
    return false;
  }
  return PDF_MAGIC.every((expected, index) => bytes[index] === expected);
}

function decodeFilenameHeader(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Validate a raw-PDF upload: the filename header, the content type, and the
 * measured request bytes. Size is measured server-side, never trusted from
 * the client.
 */
export function parseRawUpload(
  filenameHeader: unknown,
  contentType: unknown,
  body: unknown,
  maxBytes: number,
): RawUploadParseResult {
  const issues: UploadValidationIssue[] = [];

  let filename = "";
  if (typeof filenameHeader !== "string" || filenameHeader.trim() === "") {
    issues.push({ field: "filename", message: "Filename is required." });
  } else {
    const decoded = decodeFilenameHeader(filenameHeader.trim());
    if (decoded.trim().length > DOCUMENT_FILENAME_MAX_LENGTH) {
      issues.push({
        field: "filename",
        message: `Filename must be at most ${DOCUMENT_FILENAME_MAX_LENGTH} characters.`,
      });
    } else {
      filename = sanitizeFilename(decoded.trim());
      if (!filename.toLowerCase().endsWith(".pdf")) {
        issues.push({ field: "filename", message: "Only PDF files are accepted." });
      }
    }
  }

  if (contentType !== PDF_CONTENT_TYPE) {
    issues.push({
      field: "contentType",
      message: "Content type must be application/pdf.",
    });
  }

  let validBody: Buffer | undefined;
  if (!Buffer.isBuffer(body) || body.length < 1) {
    issues.push({
      field: "body",
      message: "Request body must contain the PDF bytes.",
    });
  } else if (body.length > maxBytes) {
    issues.push({
      field: "body",
      message: `File is larger than the ${maxBytes}-byte limit.`,
      code: "file_too_large",
    });
  } else if (!hasPdfMagic(body)) {
    issues.push({
      field: "body",
      message: "Only PDF files are accepted.",
    });
  } else {
    validBody = body;
  }

  if (issues.length > 0 || validBody === undefined) {
    return { ok: false, issues };
  }
  return { ok: true, value: { filename, sizeBytes: validBody.length, body: validBody } };
}

/**
 * Parse a route `:docId` parameter into an ObjectId. Returns undefined for
 * malformed IDs so the route can answer HTTP 400.
 */
export function parseDocumentId(id: string): ObjectId | undefined {
  if (!ObjectId.isValid(id)) {
    return undefined;
  }
  try {
    return new ObjectId(id);
  } catch {
    return undefined;
  }
}

export function toDocumentResponse(doc: DocumentRecord): MatterDocument {
  return {
    id: doc._id.toHexString(),
    matterId: doc.matterId.toHexString(),
    filename: doc.filename,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    extractionStatus: doc.extractionStatus ?? "pending",
    extractedText: doc.extractedText,
    pageCount: doc.pageCount,
    extractedAt: doc.extractedAt?.toISOString(),
    extractionError: doc.extractionError,
  };
}
