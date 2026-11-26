export const MATTER_STATUSES = ["active", "on_hold", "completed"] as const;
export type MatterStatus = (typeof MATTER_STATUSES)[number];

export const MATTER_TITLE_MAX_LENGTH = 120;
export const MATTER_DESCRIPTION_MAX_LENGTH = 2000;

export interface Matter {
  id: string;
  title: string;
  description?: string;
  status: MatterStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMatterRequest {
  title: string;
  description?: string;
  status: MatterStatus;
}

export const MATTER_STATUS_LABELS: Record<MatterStatus, string> = {
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
};

/**
 * Client request budget. The server answers within ~8s even when its database
 * hangs, so this mostly covers cold serverless boots and slow networks. One
 * attempt only: automatic retries would double the load exactly when the
 * backend is slowest, and the UI already offers explicit retry.
 */
const REQUEST_TIMEOUT_MS = 25000;

/** How long cached GETs stay valid. Live collections are never cached. */
const GET_CACHE_TTL_MS = 30_000;
const GET_CACHE_MAX_ENTRIES = 50;
const getCache = new Map<string, { at: number; value: unknown }>();
/**
 * Mutation epoch. Bumped on every bust so a refetch issued after a mutation
 * never attaches to a request fired before it: without this, overlapping
 * reads could adopt stale pre-mutation results.
 */
let dedupEpoch = 0;
const inflightGets = new Map<string, { epoch: number; promise: Promise<unknown> }>();

/** Drop everything cached. Called automatically after any write. */
export function bustApiCache(): void {
  getCache.clear();
  dedupEpoch += 1;
}

/**
 * GETs stable enough to cache briefly: the matters list, one matter, and a
 * matter's document list. Analyses, findings, runs, and history change under
 * polling and always read live.
 */
function isCacheableGet(path: string): boolean {
  return (
    path === "/api/matters" ||
    /^\/api\/matters\/[^/]+$/.test(path) ||
    /^\/api\/matters\/[^/]+\/documents$/.test(path)
  );
}

export interface RequestOptions {
  /** Skip the cache and force a network read (polls, transitions, actions). */
  fresh?: boolean;
}

export class MattersApiError extends Error {
  readonly httpStatus: number | undefined;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "MattersApiError";
    this.httpStatus = httpStatus;
  }
}

interface ErrorBody {
  error?: unknown;
  message?: unknown;
  issues?: unknown;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueText(issues: unknown): string | undefined {
  if (!Array.isArray(issues)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const issue of issues) {
    if (
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as { message?: unknown }).message === "string"
    ) {
      parts.push((issue as { message: string }).message);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Map any API failure to plain user-facing copy. Backend messages and HTTP
 * codes never reach the screen: known error codes map to friendly text and
 * everything else falls back to a generic retry message.
 */
function toApiError(httpStatus: number, body: unknown): MattersApiError {
  if (isErrorBody(body) && typeof body.error === "string") {
    const friendly = friendlyErrorMessage(body.error, issueText(body.issues));
    if (friendly !== undefined) {
      return new MattersApiError(friendly, httpStatus);
    }
  }
  return new MattersApiError("Something went wrong. Please try again.", httpStatus);
}

function friendlyErrorMessage(code: string, issues: string | undefined): string | undefined {
  switch (code) {
    case "validation_error":
      return issues ?? "Please check the highlighted fields and try again.";
    case "invalid_id":
    case "not_found":
    case "matter_not_found":
      return "We couldn't find that matter. It may have been deleted.";
    case "document_not_found":
      return "That document is no longer available. It may have been deleted.";
    case "database_unavailable":
      return "We're having trouble reaching our systems. Please try again in a moment.";
    case "file_too_large":
      return "That file is too large. Please choose a smaller PDF.";
    case "processing_in_progress":
    case "extraction_in_progress":
    case "analysis_in_progress":
      return "This document is still being processed. Please wait a moment and try again.";
    case "analysis_unconfigured":
      return "Analysis isn't available right now. Please try again later.";
    case "no_usable_text":
    case "extraction_failed":
      return "We couldn't read any text from this PDF, so there was nothing to analyze.";
    case "upload_in_progress":
      return "This file is still uploading. Please wait a moment and try again.";
    case "upload_incomplete":
      return "This file didn't finish uploading. Delete it and upload it again.";
    default:
      return undefined;
  }
}

function toNetworkError(err: unknown): MattersApiError {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new MattersApiError("This is taking longer than expected. Please try again.");
  }
  if (err instanceof TypeError) {
    return new MattersApiError(
      "We can't reach the server. Check your connection and try again.",
    );
  }
  if (err instanceof MattersApiError) {
    return err;
  }
  return new MattersApiError("Something went wrong. Please try again.");
}

/**
 * Developer-only console diagnostic for failed requests. The UI always shows
 * friendly copy; this line carries what support needs (endpoint, status,
 * body shape). Bodies are never logged: they can contain document text.
 */
function logApiFailure(path: string, info: Record<string, string | number>): void {
  console.error(JSON.stringify({ scope: "vdr-api", path, ...info }));
}

function bodyShape(body: unknown): string {
  if (body === null) {
    return "null";
  }
  if (Array.isArray(body)) {
    return "array";
  }
  return typeof body;
}

export async function requestJson<T>(
  apiUrl: string,
  path: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  options: RequestOptions = {},
): Promise<T> {
  const method = init?.method ?? "GET";
  const key = `${method} ${apiUrl}${path}`;
  const readable = method === "GET" || method === "HEAD";
  if (!readable) {
    // Writes invalidate everything cached; simpler and safer than per-URL rules.
    bustApiCache();
    return fetchJson<T>(apiUrl, path, init, timeoutMs);
  }
  if (isCacheableGet(path) && options.fresh !== true) {
    const hit = getCache.get(key);
    if (hit !== undefined && Date.now() - hit.at < GET_CACHE_TTL_MS) {
      return structuredClone(hit.value) as T;
    }
    getCache.delete(key);
  }
  // Concurrent identical reads share one request instead of stacking.
  const pending = inflightGets.get(key);
  if (pending !== undefined && pending.epoch === dedupEpoch) {
    return pending.promise.then((value) => structuredClone(value) as T);
  }
  const task = fetchJson<T>(apiUrl, path, init, timeoutMs);
  inflightGets.set(key, { epoch: dedupEpoch, promise: task });
  const forget = (): void => {
    if (inflightGets.get(key)?.promise === task) {
      inflightGets.delete(key);
    }
  };
  const outcome = task.then(
    (value) => {
      forget();
      if (isCacheableGet(path) && options.fresh !== true) {
        if (getCache.size >= GET_CACHE_MAX_ENTRIES && !getCache.has(key)) {
          const oldest = getCache.keys().next();
          if (!oldest.done) {
            getCache.delete(oldest.value);
          }
        }
        getCache.set(key, { at: Date.now(), value: structuredClone(value) });
      }
      return value;
    },
    (err: unknown) => {
      forget();
      throw err;
    },
  );
  return outcome;
}

function failureDetail(err: unknown): Record<string, string | number> {
  if (err instanceof DOMException) {
    return { reason: err.name };
  }
  if (err instanceof Error) {
    // Fetch failure messages are browser-generated ("Failed to fetch") and
    // carry no content; truncated defensively regardless.
    const detail =
      err.message.length > 80 ? `${err.message.slice(0, 80)}…` : err.message;
    return { reason: "network-error", detail };
  }
  return { reason: "network-error" };
}

async function fetchJson<T>(
  apiUrl: string,
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<T> {
  const method = init?.method ?? "GET";
  const readable = method === "GET" || method === "HEAD";
  let res: Response;
  let retried = false;
  for (;;) {
    try {
      res = await fetch(`${apiUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      break;
    } catch (err: unknown) {
      // One silent retry when the connection itself fails before any
      // response arrives. Timeouts deliberately do NOT retry: doubling slow
      // requests piles load onto a struggling backend.
      if (readable && !retried && err instanceof TypeError) {
        retried = true;
        continue;
      }
      logApiFailure(path, failureDetail(err));
      throw toNetworkError(err);
    }
  }
  if (res.status === 204) {
    return undefined as T;
  }
  let body: unknown = null;
  let parsed = true;
  try {
    body = (await res.json()) as unknown;
  } catch {
    parsed = false;
    body = null;
  }
  if (!res.ok) {
    logApiFailure(path, { httpStatus: res.status, body: bodyShape(body) });
    throw toApiError(res.status, body);
  }
  if (!parsed) {
    logApiFailure(path, { httpStatus: res.status, body: "unparseable" });
  }
  return body as T;
}

/** Shown when the app itself is misconfigured; the user cannot fix it. */
export const APP_CONFIG_ERROR_MESSAGE = "Something went wrong. Please try again later.";

/**
 * The network is not trusted: a torn 200 (empty body, literal null) must
 * surface as a retryable error, never as a null that crashes render.
 */
export function expectArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) {
    logApiFailure(what, { reason: "unexpected-shape", body: bodyShape(value) });
    throw new MattersApiError(`Couldn't load ${what}. Please try again.`);
  }
  return value as T[];
}

export function expectObject<T extends object>(value: unknown, what: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    logApiFailure(what, { reason: "unexpected-shape", body: bodyShape(value) });
    throw new MattersApiError(`Couldn't load ${what}. Please try again.`);
  }
  return value as T;
}

export async function listMatters(
  apiUrl: string,
  options: RequestOptions = {},
): Promise<Matter[]> {
  return expectArray<Matter>(
    await requestJson<unknown>(apiUrl, "/api/matters", undefined, REQUEST_TIMEOUT_MS, options),
    "matters",
  );
}

export async function getMatter(
  apiUrl: string,
  id: string,
  options: RequestOptions = {},
): Promise<Matter> {
  return expectObject<Matter>(
    await requestJson<unknown>(apiUrl, `/api/matters/${id}`, undefined, REQUEST_TIMEOUT_MS, options),
    "this matter",
  );
}

export async function createMatter(
  apiUrl: string,
  input: CreateMatterRequest,
): Promise<Matter> {
  return requestJson<Matter>(apiUrl, "/api/matters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteMatter(apiUrl: string, id: string): Promise<void> {
  await requestJson<void>(apiUrl, `/api/matters/${id}`, { method: "DELETE" });
}

export interface MatterFormErrors {
  title?: string;
  description?: string;
}

/** Client-side validation. Mirrors the backend rules; backend still decides. */
export function validateMatterForm(values: {
  title: string;
  description: string;
}): MatterFormErrors {
  const errors: MatterFormErrors = {};
  const title = values.title.trim();
  if (title === "") {
    errors.title = "Title is required.";
  } else if (title.length > MATTER_TITLE_MAX_LENGTH) {
    errors.title = `Title must be at most ${MATTER_TITLE_MAX_LENGTH} characters.`;
  }
  if (values.description.length > MATTER_DESCRIPTION_MAX_LENGTH) {
    errors.description = `Description must be at most ${MATTER_DESCRIPTION_MAX_LENGTH} characters.`;
  }
  return errors;
}
