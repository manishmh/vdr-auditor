import { MattersApiError, requestJson } from "./matters";

export interface MatterDocument {
  id: string;
  matterId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export async function listDocuments(
  apiUrl: string,
  matterId: string,
): Promise<MatterDocument[]> {
  return requestJson<MatterDocument[]>(
    apiUrl,
    `/api/matters/${matterId}/documents`,
  );
}

/**
 * POST raw PDF bytes to the backend with progress callbacks. Uses XHR
 * because fetch has no upload-progress events.
 */
export function uploadDocument(
  apiUrl: string,
  matterId: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<MatterDocument> {
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
          resolve(JSON.parse(xhr.responseText) as MatterDocument);
        } catch {
          reject(new MattersApiError("Upload succeeded but the response was invalid."));
        }
        return;
      }
      reject(uploadError(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => {
      reject(new MattersApiError("Upload failed. Check your connection and retry."));
    };
    xhr.ontimeout = () => {
      reject(new MattersApiError("Upload timed out. Try again."));
    };
    xhr.timeout = 120000;
    xhr.send(file);
  });
}

function uploadError(httpStatus: number, responseText: string): MattersApiError {
  try {
    const body = JSON.parse(responseText) as {
      error?: unknown;
      message?: unknown;
      issues?: Array<{ message?: unknown }>;
    };
    if (typeof body.message === "string") {
      return new MattersApiError(body.message, httpStatus);
    }
    if (body.error === "validation_error" && Array.isArray(body.issues)) {
      const parts = body.issues
        .map((issue) => issue.message)
        .filter((message): message is string => typeof message === "string");
      if (parts.length > 0) {
        return new MattersApiError(parts.join(" "), httpStatus);
      }
    }
  } catch {
    // Fall through to the generic message below.
  }
  return new MattersApiError(`Upload failed (HTTP ${httpStatus}).`, httpStatus);
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
      throw new MattersApiError("Download timed out. Try again.");
    }
    throw new MattersApiError("Cannot reach the backend. Is it running?");
  }
  if (!res.ok) {
    let message = `Download failed (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === "string") {
        message = body.message;
      }
    } catch {
      // Keep the generic message.
    }
    throw new MattersApiError(message, res.status);
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
