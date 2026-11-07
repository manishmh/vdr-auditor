export type UploadRejectionReason =
  | "empty_file"
  | "too_large"
  | "bad_extension"
  | "not_a_pdf";

export class UploadValidationError extends Error {
  readonly reason: UploadRejectionReason;
  readonly status: number;

  constructor(reason: UploadRejectionReason, message: string) {
    super(message);
    this.name = "UploadValidationError";
    this.reason = reason;
    this.status = reason === "too_large" ? 413 : 400;
  }
}

export interface UploadInput {
  filename: string;
  /** Client-supplied MIME type. Recorded but never trusted for the verdict. */
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

export interface ValidatedUpload {
  filename: string;
  mimeType: string;
  size: number;
  /** SHA-256 hex of the raw bytes, for dedupe and traceability. */
  sha256: string;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

/** Slack above MAX_UPLOAD_BYTES tolerated in Content-Length for multipart framing overhead. */
export const UPLOAD_LENGTH_SLACK_BYTES = 1024 * 1024;

/**
 * Pre-parse size gate: when the client declares Content-Length, reject
 * oversized bodies before buffering the multipart payload into memory.
 * Missing or unparsable lengths fall through to the post-parse byte check.
 */
export function isDeclaredBodyTooLarge(contentLength: string | null, maxBytes: number): boolean {
  if (contentLength == null) return false;
  const declared = Number(contentLength.trim());
  if (!Number.isFinite(declared) || declared < 0) return false;
  return declared > maxBytes + UPLOAD_LENGTH_SLACK_BYTES;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Server-side upload validation. The verdict rests on size, extension, and
 * magic bytes — never on client-supplied metadata alone.
 */
export async function validateUpload(input: UploadInput, maxBytes: number): Promise<ValidatedUpload> {
  if (input.size <= 0 || input.bytes.length === 0) {
    throw new UploadValidationError("empty_file", "Uploaded file is empty.");
  }
  if (input.size > maxBytes || input.bytes.length > maxBytes) {
    throw new UploadValidationError(
      "too_large",
      `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
    );
  }
  const base = input.filename.split(/[\\/]/).pop() ?? "";
  if (!/\.pdf$/i.test(base)) {
    throw new UploadValidationError("bad_extension", "Only .pdf files are accepted.");
  }
  const magicOk = PDF_MAGIC.every((b, i) => input.bytes[i] === b);
  if (!magicOk) {
    throw new UploadValidationError("not_a_pdf", "File content is not a PDF (bad magic bytes).");
  }
  return {
    filename: base.slice(0, 255) || "document.pdf",
    mimeType: input.mimeType || "application/pdf",
    size: input.bytes.length,
    sha256: await sha256Hex(input.bytes),
  };
}

/** Display-only filename cleanup. Storage paths always use generated UUIDs, never this. */
export function sanitizeDisplayName(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim().slice(0, 255) || "document.pdf";
}
