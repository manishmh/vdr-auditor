import { expectArray, expectObject, requestJson } from "./matters";

export const PROCESSING_STAGES = [
  "queued",
  "extracting",
  "analyzing",
  "validating",
  "completed",
  "completed_with_limits",
  "failed",
] as const;

export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export interface ProcessingRunSummary {
  id: string;
  matterId: string;
  docId: string;
  /** Absent when the source document was deleted after the run. */
  filename?: string;
  /** Absent when the matter was deleted after the run. */
  matterTitle?: string;
  stage: ProcessingStage;
  error?: string;
  updatedAt: string;
}

export const PROCESSING_STAGE_LABELS: Record<ProcessingStage, string> = {
  queued: "Queued",
  extracting: "Extracting text",
  analyzing: "Analyzing",
  validating: "Validating findings",
  completed: "Completed",
  completed_with_limits: "Completed with limits",
  failed: "Failed",
};

export function isActiveProcessingStage(stage: ProcessingStage): boolean {
  return (
    stage === "queued" ||
    stage === "extracting" ||
    stage === "analyzing" ||
    stage === "validating"
  );
}

export function isTerminalProcessingStage(stage: ProcessingStage): boolean {
  return !isActiveProcessingStage(stage);
}

/** Mirrors the backend staleness bound: active runs older than this are abandoned. */
export const PROCESSING_STALE_MS = 10 * 60 * 1000;

/** An active run whose state has not advanced past the staleness bound. */
export function isStaleActiveRun(run: ProcessingRunSummary, now: number = Date.now()): boolean {
  if (!isActiveProcessingStage(run.stage)) {
    return false;
  }
  const updated = Date.parse(run.updatedAt);
  return !Number.isNaN(updated) && now - updated > PROCESSING_STALE_MS;
}

/**
 * A retried document has several runs; only the newest per document is
 * shown so a superseded failure does not linger next to its retry.
 */
export function latestRunPerDoc(runs: ProcessingRunSummary[]): ProcessingRunSummary[] {
  const sorted = [...runs].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
  const seen = new Set<string>();
  const out: ProcessingRunSummary[] = [];
  for (const run of sorted) {
    if (seen.has(run.docId)) {
      continue;
    }
    seen.add(run.docId);
    out.push(run);
  }
  return out;
}

export async function listProcessingRuns(
  apiUrl: string,
  matterId?: string,
): Promise<ProcessingRunSummary[]> {
  const path =
    matterId === undefined ? "/api/processing" : `/api/processing?matterId=${matterId}`;
  const body = await requestJson<unknown>(apiUrl, path);
  const runs = expectObject<{ runs: unknown }>(body, "processing runs").runs;
  return expectArray<ProcessingRunSummary>(runs, "processing runs");
}

export async function retryProcessing(
  apiUrl: string,
  matterId: string,
  docId: string,
): Promise<ProcessingRunSummary | null> {
  const body = await requestJson<unknown>(
    apiUrl,
    `/api/matters/${matterId}/documents/${docId}/process`,
    { method: "POST" },
  );
  if (typeof body !== "object" || body === null) {
    return null;
  }
  return parseProcessingRunSummary((body as { run?: unknown }).run);
}

/**
 * Validate a run summary from a mutation response before seeding UI state
 * with it. Returns null when malformed so callers fall back to refetching.
 */
export function parseProcessingRunSummary(value: unknown): ProcessingRunSummary | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const stage = record["stage"];
  if (
    typeof record["id"] !== "string" ||
    typeof record["matterId"] !== "string" ||
    typeof record["docId"] !== "string" ||
    typeof stage !== "string" ||
    !(PROCESSING_STAGES as readonly string[]).includes(stage) ||
    typeof record["updatedAt"] !== "string"
  ) {
    return null;
  }
  const summary: ProcessingRunSummary = {
    id: record["id"],
    matterId: record["matterId"],
    docId: record["docId"],
    stage: stage as ProcessingStage,
    updatedAt: record["updatedAt"],
  };
  if (typeof record["error"] === "string") {
    summary.error = record["error"];
  }
  if (typeof record["filename"] === "string") {
    summary.filename = record["filename"];
  }
  if (typeof record["matterTitle"] === "string") {
    summary.matterTitle = record["matterTitle"];
  }
  return summary;
}

/**
 * Map the backend's safe run-error codes to display text. Must cover the
 * extraction service codes, the job-level codes, the Meta client
 * categories, and the driver-level codes persisted on the run.
 */
export function processingErrorMessage(error: string | null | undefined): string {
  switch (error) {
    case "encrypted":
      return "This PDF is password-protected and cannot be read.";
    case "unparseable":
      return "This PDF could not be read.";
    case "limit_exceeded":
      return "This PDF exceeds processing limits.";
    case "no_usable_text":
      return "The PDF has no readable text to analyze.";
    case "not_found":
    case "document_deleted":
      return "The document is no longer available.";
    case "timeout":
      return "Analysis timed out before finishing. Retry to try again.";
    case "rate_limited":
    case "network":
    case "unavailable":
      return "The analysis service is unavailable. Retry to try again.";
    case "unconfigured":
      return "Analysis is not configured on the server.";
    case "auth":
      return "Analysis authentication failed. Check the server configuration.";
    case "bad_request":
      return "The analysis request was rejected by the service. Retry to try again.";
    case "model_not_found":
      return "The analysis model is not available. Check the server configuration.";
    case "truncated":
      return "Analysis output was cut off before finishing. Retry to try again.";
    case "interrupted":
      return "Processing was interrupted before finishing. Retry to continue.";
    case "extraction_in_progress":
      return "Text extraction is already running for this document.";
    case "bad_response":
      return "The analysis service returned an invalid response. Retry to try again.";
    case "database_unavailable":
      return "The database is not reachable. Try again later.";
    case "in_progress":
      return "Processing is already running for this document.";
    default:
      return "Processing failed. Retry to try again.";
  }
}

/**
 * Window event the matter page dispatches after upload, retry, or delete so
 * the global indicator refetches once instead of polling while idle.
 */
export const PROCESSING_CHANGED_EVENT = "vdr:processing-changed";

export function notifyProcessingChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PROCESSING_CHANGED_EVENT));
  }
}
