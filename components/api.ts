import type { StoredFinding } from "@/lib/findings/schema";
import type { DocumentRecord } from "@/lib/store/types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    throw new ApiError(res.status, `Request failed (HTTP ${res.status}).`);
  }
}

const PILOT_TOKEN_KEY = "vdr-pilot-token";

/** Pilot access token for this tab only. Never persisted beyond the session. */
export function getPilotToken(): string | null {
  try {
    return sessionStorage.getItem(PILOT_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setPilotToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(PILOT_TOKEN_KEY, token);
    else sessionStorage.removeItem(PILOT_TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): requests simply go without a token.
  }
}

/**
 * Express API origin. Same-origin by default (dev proxy or colocated
 * deploy); set NEXT_PUBLIC_API_BASE_URL to the backend URL when the
 * frontend and API are separate deployments. Public by design: it carries
 * no secret — authentication travels in the Authorization header, and no
 * credential ever uses a NEXT_PUBLIC_ variable.
 */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");

/**
 * Client-side upload caps. Build-time mirrors of the server's
 * MAX_UPLOAD_BYTES / MAX_PDF_PAGES — the server always re-validates, so a
 * stale value here can only produce an early client message, never a
 * bypass. Keep them in sync with the deployment's server settings.
 */
function publicInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export const MAX_UPLOAD_MB = publicInt("NEXT_PUBLIC_MAX_UPLOAD_MB", 20);
export const MAX_PDF_PAGES = publicInt("NEXT_PUBLIC_MAX_PDF_PAGES", 200);
export const MAX_UPLOAD_BYTES_CLIENT = MAX_UPLOAD_MB * 1024 * 1024;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getPilotToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const body = await parseJson(res);
  if (!res.ok) {
    const message = typeof body.error === "string" ? body.error : `Request failed (HTTP ${res.status}).`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export interface DocumentsResponse {
  documents: DocumentRecord[];
}

export interface UploadResponse {
  document: DocumentRecord;
  findings: StoredFinding[];
  droppedInvalid: number;
  droppedUnverified: number;
}

export interface DocumentDetailResponse {
  document: DocumentRecord;
  findings: StoredFinding[];
}

export interface FindingResponse {
  finding: StoredFinding;
}

export function fetchDocuments(): Promise<DocumentsResponse> {
  return request<DocumentsResponse>("/api/documents");
}

export function uploadDocument(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file, file.name);
  return request<UploadResponse>("/api/documents", { method: "POST", body: form });
}

export function fetchDocument(id: string): Promise<DocumentDetailResponse> {
  return request<DocumentDetailResponse>(`/api/documents/${encodeURIComponent(id)}`);
}

export function deleteDocument(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function patchFinding(
  documentId: string,
  findingId: string,
  patch: { status?: StoredFinding["status"]; reviewerNote?: string | null },
): Promise<FindingResponse> {
  return request<FindingResponse>(
    `/api/documents/${encodeURIComponent(documentId)}/findings/${encodeURIComponent(findingId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  );
}

/** Download the stored original with pilot credentials (anchor tags cannot send headers). */
export async function downloadOriginal(id: string, filename: string): Promise<void> {
  const token = getPilotToken();
  const res = await fetch(`${API_BASE}/api/documents/${encodeURIComponent(id)}/file`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new ApiError(res.status, `Download failed (HTTP ${res.status}).`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
