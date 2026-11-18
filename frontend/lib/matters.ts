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

const REQUEST_TIMEOUT_MS = 10000;

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

/** Map any API failure to a safe display message. Never leaks internals. */
function toApiError(httpStatus: number, body: unknown): MattersApiError {
  if (isErrorBody(body)) {
    if (body.error === "validation_error") {
      return new MattersApiError(
        issueText(body.issues) ?? "Some fields are invalid.",
        httpStatus,
      );
    }
    if (typeof body.message === "string") {
      return new MattersApiError(body.message, httpStatus);
    }
    if (body.error === "not_found" || body.error === "matter_not_found") {
      return new MattersApiError("Matter not found.", httpStatus);
    }
    if (body.error === "document_not_found") {
      return new MattersApiError("Document not found.", httpStatus);
    }
    if (body.error === "database_unavailable") {
      return new MattersApiError(
        "The database is not reachable. Try again later.",
        httpStatus,
      );
    }
  }
  return new MattersApiError(
    `Request failed (HTTP ${httpStatus}).`,
    httpStatus,
  );
}

function toNetworkError(err: unknown): MattersApiError {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new MattersApiError("Request timed out. Try again.");
  }
  if (err instanceof TypeError) {
    return new MattersApiError("Cannot reach the backend. Is it running?");
  }
  if (err instanceof MattersApiError) {
    return err;
  }
  return new MattersApiError("Unexpected error. Try again.");
}

export async function requestJson<T>(
  apiUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err: unknown) {
    throw toNetworkError(err);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  let body: unknown = null;
  try {
    body = (await res.json()) as unknown;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw toApiError(res.status, body);
  }
  return body as T;
}

export async function listMatters(apiUrl: string): Promise<Matter[]> {
  return requestJson<Matter[]>(apiUrl, "/api/matters");
}

export async function getMatter(apiUrl: string, id: string): Promise<Matter> {
  return requestJson<Matter>(apiUrl, `/api/matters/${id}`);
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
