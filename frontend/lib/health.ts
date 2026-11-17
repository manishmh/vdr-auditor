export interface LivenessResponse {
  service: string;
  status: string;
  timestamp: string;
}

export interface ReadinessResponse {
  service: string;
  status: string;
  database: string;
  timestamp: string;
}

const REQUEST_TIMEOUT_MS = 8000;

async function fetchJson<T>(url: string): Promise<{ httpStatus: number; body: T }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  const body = (await res.json()) as T;
  return { httpStatus: res.status, body };
}

/** Liveness probe. Resolves only when the backend answers HTTP 200. */
export async function checkBackend(apiUrl: string): Promise<LivenessResponse> {
  const { httpStatus, body } = await fetchJson<LivenessResponse>(
    `${apiUrl}/api/health`,
  );
  if (httpStatus !== 200 || body.status !== "ok") {
    throw new Error(`Backend health check failed (HTTP ${httpStatus}).`);
  }
  return body;
}

/**
 * Readiness probe. Returns the parsed body regardless of status so the caller
 * can distinguish "backend reachable, database down" (503) from unreachable.
 */
export async function checkReadiness(apiUrl: string): Promise<{
  httpStatus: number;
  body: ReadinessResponse;
}> {
  return fetchJson<ReadinessResponse>(`${apiUrl}/api/health/ready`);
}

export type ProbeState = "checking" | "ok" | "error";

export interface Probe {
  state: ProbeState;
  detail: string;
}

export interface StatusReport {
  backend: Probe;
  database: Probe;
  lastChecked: string;
}

function configError(): Probe {
  return { state: "error", detail: "NEXT_PUBLIC_API_URL is not configured." };
}

/**
 * Run both probes and return a complete report. Never throws: every failure
 * mode is captured as an error probe so the UI always renders a verdict.
 */
export async function fetchStatusReport(
  apiUrl: string | undefined,
): Promise<StatusReport> {
  if (apiUrl === undefined || apiUrl === "") {
    return {
      backend: configError(),
      database: configError(),
      lastChecked: new Date().toLocaleTimeString(),
    };
  }

  let backend: Probe;
  let backendOk = false;
  try {
    const health = await checkBackend(apiUrl);
    backendOk = true;
    backend = {
      state: "ok",
      detail: `${health.service} responded at ${health.timestamp}.`,
    };
  } catch (err: unknown) {
    backend = { state: "error", detail: toErrorMessage(err) };
  }

  let database: Probe;
  try {
    const { httpStatus, body } = await checkReadiness(apiUrl);
    if (httpStatus === 200 && body.database === "connected") {
      database = {
        state: "ok",
        detail: `MongoDB ping succeeded at ${body.timestamp}.`,
      };
    } else {
      database = {
        state: "error",
        detail:
          body.database === "unconfigured"
            ? "Backend has no MONGODB_URI configured."
            : "Backend is reachable but MongoDB is unavailable.",
      };
    }
  } catch (err: unknown) {
    database = {
      state: "error",
      detail: backendOk
        ? toErrorMessage(err)
        : "Unknown — the backend itself is unreachable.",
    };
  }

  return { backend, database, lastChecked: new Date().toLocaleTimeString() };
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "Request timed out. Is the backend running?";
  }
  if (err instanceof TypeError) {
    return "Cannot reach the backend. Is it running at the URL below?";
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Unexpected error while checking health.";
}
