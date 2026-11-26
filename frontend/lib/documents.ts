import {
  MattersApiError,
  bustApiCache,
  expectArray,
  expectObject,
  requestJson,
  type RequestOptions,
} from "./matters";
import { parseProcessingRunSummary, type ProcessingRunSummary } from "./processing";

export type DocumentExtractionStatus =
  | "pending"
  | "processing"
  | "completed"
  | "no_text"
  | "failed";

/** Must match the backend PAGE_SEPARATOR: splits extracted text into pages. */
export const PAGE_SEPARATOR = "\u000c";

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
  /** Leading blank pages trimmed at extraction; absent on older records. */
  pageOffset?: number;
  /**
   * False while the uploaded bytes are still being persisted after the
   * 201 response. Absent means stored (older records predate the flag).
   */
  bytesStored?: boolean;
  extractedAt?: string;
  extractionError?: string;
}

/**
 * True while a document's bytes are still being persisted in the
 * background. Only an explicit false counts: records written before the
 * flag existed (or served by an older backend) are treated as stored, and
 * terminally failed uploads are a delete-and-re-upload state, not a wait.
 */
export function isAwaitingUpload(doc: MatterDocument): boolean {
  return doc.bytesStored === false && doc.extractionStatus !== "failed";
}

export const EXTRACTION_STATUS_LABELS: Record<DocumentExtractionStatus, string> = {
  pending: "Not extracted",
  processing: "Extracting",
  completed: "Text extracted",
  no_text: "No extractable text",
  failed: "Extraction failed",
};

export function extractionErrorMessage(code: string | undefined): string {
  switch (code) {
    case "encrypted":
      return "This PDF is password-protected and cannot be read.";
    case "limit_exceeded":
      return "This PDF exceeds extraction limits.";
    case "unparseable":
      return "This PDF could not be read.";
    case "upload_interrupted":
      return "The upload was interrupted before the file was saved. Delete it and upload again.";
    default:
      return "Extraction failed.";
  }
}

export interface ListDocumentsOptions extends RequestOptions {
  /** Omit extracted text (dashboards, polling); fetch it on demand instead. */
  includeText?: boolean;
}

export async function listDocuments(
  apiUrl: string,
  matterId: string,
  options: ListDocumentsOptions = {},
): Promise<MatterDocument[]> {
  const { includeText, ...requestOptions } = options;
  const path =
    includeText === false
      ? `/api/matters/${matterId}/documents?includeText=false`
      : `/api/matters/${matterId}/documents`;
  return expectArray<MatterDocument>(
    await requestJson<unknown>(apiUrl, path, undefined, undefined, requestOptions),
    "documents",
  );
}

export interface DocumentText {
  extractionStatus: DocumentExtractionStatus;
  extractedText?: string;
  pageCount?: number;
  extractedAt?: string;
}

/** Fetch one document's extracted text on demand (never during polling). */
export async function getDocumentText(
  apiUrl: string,
  matterId: string,
  docId: string,
): Promise<DocumentText> {
  return expectObject<DocumentText>(
    await requestJson<unknown>(apiUrl, `/api/matters/${matterId}/documents/${docId}/text`),
    "extracted text",
  );
}

/**
 * POST raw PDF bytes to the backend with progress callbacks. Uses XHR
 * because fetch has no upload-progress events.
 */
export interface UploadResult {
  document: MatterDocument;
  /** The run the server started, when present and well-formed. */
  processing: ProcessingRunSummary | null;
}

export function uploadDocument(
  apiUrl: string,
  matterId: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiUrl}/api/matters/${matterId}/documents`);
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status === 201) {
        try {
          const body = JSON.parse(xhr.responseText) as
            | { document?: unknown; processing?: unknown }
            | MatterDocument;
          const document =
            "document" in body && typeof body.document === "object" && body.document !== null
              ? (body.document as MatterDocument)
              : (body as MatterDocument);
          if (typeof document.id !== "string" || document.id === "") {
            throw new Error("invalid upload response");
          }
          // XHR uploads bypass requestJson, so bust the cache explicitly.
          bustApiCache();
          resolve({
            document,
            processing:
              "processing" in body ? parseProcessingRunSummary(body.processing) : null,
          });
        } catch {
          reject(new MattersApiError("The upload finished but we couldn't confirm it. Please refresh and check."));
        }
        return;
      }
      logUploadFailure(file, xhr.status, xhr.responseText);
      reject(uploadError(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => {
      reject(new MattersApiError("The upload failed. Check your connection and try again."));
    };
    xhr.ontimeout = () => {
      reject(new MattersApiError("The upload is taking too long. Please try again."));
    };
    xhr.timeout = 120000;
    xhr.send(file);
  });
}

/**
 * Developer-only console diagnostic for failed uploads: status, body shape,
 * and file metadata. Bodies are never logged: they can echo file bytes on
 * platform errors, and names/sizes are all support needs.
 */
function logUploadFailure(file: File, httpStatus: number, responseText: string): void {
  let bodyShape = "empty";
  if (responseText !== "") {
    try {
      const parsed: unknown = JSON.parse(responseText);
      bodyShape =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? `json:${String((parsed as { error?: unknown }).error ?? "no-code")}`
          : Array.isArray(parsed)
            ? "array"
            : typeof parsed;
    } catch {
      bodyShape = responseText.trimStart().startsWith("<") ? "html" : "text";
    }
  }
  console.error(
    JSON.stringify({
      scope: "vdr-upload",
      httpStatus,
      body: bodyShape,
      filename: file.name.length > 80 ? `${file.name.slice(0, 80)}…` : file.name,
      sizeBytes: file.size,
    }),
  );
}

/**
 * Map an upload failure to user-facing copy. Status-first: platform and
 * gateway failures (413/502/503/504) often carry HTML or empty bodies, so
 * the status is more reliable than parsing. Exported for tests.
 */
export function uploadError(httpStatus: number, responseText: string): MattersApiError {
  let error: unknown;
  let tooLargeIssue = false;
  try {
    const body = JSON.parse(responseText) as {
      error?: unknown;
      issues?: Array<{ code?: unknown }>;
    };
    error = body.error;
    tooLargeIssue =
      body.error === "validation_error" &&
      Array.isArray(body.issues) &&
      body.issues.some((issue) => issue.code === "file_too_large");
  } catch {
    error = undefined;
  }
  if (httpStatus === 413 || error === "file_too_large" || tooLargeIssue) {
    return new MattersApiError(
      "That file is too large to upload. Please choose a smaller PDF.",
      httpStatus,
    );
  }
  if (error === "validation_error") {
    return new MattersApiError(
      "That file isn't a valid PDF. Please choose another file.",
      httpStatus,
    );
  }
  if (error === "matter_not_found" || error === "not_found") {
    return new MattersApiError(
      "We couldn't find that matter. It may have been deleted.",
      httpStatus,
    );
  }
  if (httpStatus === 503 || error === "database_unavailable") {
    return new MattersApiError(
      "The server is busy right now. Please wait a moment and try again.",
      httpStatus,
    );
  }
  if (httpStatus === 502 || httpStatus === 504) {
    return new MattersApiError(
      "The server timed out before the upload finished. Please try again.",
      httpStatus,
    );
  }
  return new MattersApiError("The upload failed. Please try again.", httpStatus);
}

export async function downloadDocument(
  apiUrl: string,
  matterId: string,
  doc: MatterDocument,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/matters/${matterId}/documents/${doc.id}/download`, {
      signal: AbortSignal.timeout(120000),
      cache: "no-store",
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new MattersApiError("The download is taking too long. Please try again.");
    }
    throw new MattersApiError("We can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    throw new MattersApiError(
      res.status === 404
        ? "That document is no longer available. It may have been deleted."
        : res.status === 409
          ? "This file is still uploading. Please wait a moment and try again."
          : "Couldn't download this file. Please try again.",
      res.status,
    );
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = doc.filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function extractDocument(
  apiUrl: string,
  matterId: string,
  docId: string,
): Promise<MatterDocument> {
  return requestJson<MatterDocument>(
    apiUrl,
    `/api/matters/${matterId}/documents/${docId}/extract`,
    { method: "POST" },
  );
}

export async function deleteDocument(
  apiUrl: string,
  matterId: string,
  docId: string,
): Promise<void> {
  await requestJson<void>(
    apiUrl,
    `/api/matters/${matterId}/documents/${docId}`,
    { method: "DELETE" },
  );
}

/**
 * Client-side pre-check. Mirrors the backend rules; the backend still
 * decides. Returns an error message, or undefined when the file looks fine.
 */
export function validatePdfFile(file: File, maxBytes: number): string | undefined {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return "Only PDF files are accepted.";
  }
  if (file.type !== "" && file.type !== "application/pdf") {
    return "Only PDF files are accepted.";
  }
  if (file.size < 1) {
    return "The file is empty.";
  }
  if (file.size > maxBytes) {
    return `The file is larger than the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB limit.`;
  }
  return undefined;
}
