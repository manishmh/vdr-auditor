"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatBytes, formatDate } from "@/lib/format";
import { getMatter, type Matter } from "@/lib/matters";
import {
  deleteDocument,
  downloadDocument,
  listDocuments,
  uploadDocument,
  validatePdfFile,
  type MatterDocument,
} from "@/lib/documents";

const API_URL = process.env["NEXT_PUBLIC_API_URL"];
const MAX_PDF_MB = (() => {
  const raw = process.env["NEXT_PUBLIC_MAX_PDF_MB"];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 25;
})();
const MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024;

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

interface UploadState {
  key: number;
  filename: string;
  phase: "uploading" | "done" | "error";
  progress: number;
  message: string | null;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export default function MatterDetailPage() {
  const params = useParams();
  const rawId = params?.id;
  const matterId = typeof rawId === "string" ? rawId : "";

  const [matter, setMatter] = useState<LoadState<Matter>>(() =>
    matterId === "" || API_URL === undefined || API_URL === ""
      ? {
          status: "error",
          message:
            matterId === ""
              ? "Missing matter id."
              : "NEXT_PUBLIC_API_URL is not configured.",
        }
      : { status: "loading" },
  );
  const [docs, setDocs] = useState<LoadState<MatterDocument[]>>({
    status: "loading",
  });
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (matterId === "" || API_URL === undefined || API_URL === "") {
      return;
    }
    const apiUrl: string = API_URL;
    const id: string = matterId;
    getMatter(apiUrl, id).then(
      (value) => {
        setMatter({ status: "ready", value });
        listDocuments(apiUrl, id).then(
          (documents) => {
            setDocs({ status: "ready", value: documents });
          },
          (err: unknown) => {
            setDocs({ status: "error", message: errorMessage(err, "Could not load documents.") });
          },
        );
      },
      (err: unknown) => {
        setMatter({ status: "error", message: errorMessage(err, "Could not load the matter.") });
        setDocs({ status: "error", message: "Could not load documents." });
      },
    );
  }, [matterId]);

  const reloadDocs = (apiUrl: string, id: string) => {
    setDocs({ status: "loading" });
    listDocuments(apiUrl, id).then(
      (documents) => {
        setDocs({ status: "ready", value: documents });
      },
      (err: unknown) => {
        setDocs({ status: "error", message: errorMessage(err, "Could not load documents.") });
      },
    );
  };

  const patchUpload = (key: number, patch: Partial<UploadState>) => {
    setUploads((prev) =>
      prev.map((upload) =>
        upload.key === key ? { ...upload, ...patch } : upload,
      ),
    );
  };

  const runUpload = async (apiUrl: string, id: string, file: File, key: number) => {
    const precheck = validatePdfFile(file, MAX_PDF_BYTES);
    if (precheck !== undefined) {
      patchUpload(key, { phase: "error", message: precheck });
      return;
    }
    try {
      patchUpload(key, { phase: "uploading", progress: 0, message: null });
      await uploadDocument(apiUrl, id, file, (progress) => {
        patchUpload(key, { progress });
      });
      patchUpload(key, { phase: "done", progress: 100 });
    } catch (err: unknown) {
      patchUpload(key, { phase: "error", message: errorMessage(err, "Upload failed.") });
    }
    reloadDocs(apiUrl, id);
  };

  const onFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    // Snapshot first: event.target.files is live, so resetting the input
    // below would otherwise empty the list before it is read.
    const files: File[] =
      event.target.files === null ? [] : [...event.target.files];
    event.target.value = "";
    if (
      files.length === 0 ||
      API_URL === undefined ||
      API_URL === "" ||
      matterId === ""
    ) {
      return;
    }
    const apiUrl: string = API_URL;
    const id: string = matterId;
    const now = Date.now();
    const entries: UploadState[] = files.map((file, index) => ({
      key: now + index,
      filename: file.name,
      phase: "uploading",
      progress: 0,
      message: null,
    }));
    setUploads((prev) => [...prev, ...entries]);
    void (async () => {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const entry = entries[index];
        if (file !== undefined && entry !== undefined) {
          await runUpload(apiUrl, id, file, entry.key);
        }
      }
    })();
  };

  const onDownload = async (doc: MatterDocument) => {
    if (API_URL === undefined || API_URL === "" || matterId === "") {
      return;
    }
    setDownloadingId(doc.id);
    setActionError(null);
    try {
      await downloadDocument(API_URL, matterId, doc);
    } catch (err: unknown) {
      setActionError(errorMessage(err, "Could not download the document."));
    } finally {
      setDownloadingId(null);
    }
  };

  const onDelete = async (doc: MatterDocument) => {
    if (API_URL === undefined || API_URL === "" || matterId === "") {
      return;
    }
    setDeletingId(doc.id);
    setActionError(null);
    try {
      await deleteDocument(API_URL, matterId, doc.id);
      setConfirmDeleteId(null);
      reloadDocs(API_URL, matterId);
    } catch (err: unknown) {
      setActionError(errorMessage(err, "Could not delete the document."));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/" className="text-sm text-zinc-600 underline hover:text-zinc-900">
        ← All matters
      </Link>

      {matter.status === "loading" && (
        <p className="mt-4 text-sm text-zinc-600" role="status">
          Loading matter…
        </p>
      )}
      {matter.status === "error" && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {matter.message}
        </p>
      )}
      {matter.status === "ready" && (
        <>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">{matter.value.title}</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Status: {matter.value.status.replace("_", " ")}
            {matter.value.description !== undefined && matter.value.description !== ""
              ? ` — ${matter.value.description}`
              : ""}
          </p>
        </>
      )}

      <section aria-label="Documents" className="mt-8">
        <h2 className="text-lg font-semibold">Documents</h2>
        {docs.status === "loading" && (
          <p className="mt-2 text-sm text-zinc-600" role="status">
            Loading documents…
          </p>
        )}
        {docs.status === "error" && (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-800">{docs.message}</p>
            {API_URL !== undefined && API_URL !== "" && matterId !== "" && (
              <button
                type="button"
                onClick={() => reloadDocs(API_URL, matterId)}
                className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Retry
              </button>
            )}
          </div>
        )}
        {docs.status === "ready" &&
          (docs.value.length === 0 ? (
            <p className="mt-2 rounded-md border border-zinc-200 px-4 py-6 text-center text-sm text-zinc-600">
              No documents yet. Upload the first PDF below.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-200 rounded-md border border-zinc-200">
              {docs.value.map((doc) => (
                <li key={doc.id} className="px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{doc.filename}</p>
                    <p className="mt-0.5 text-sm text-zinc-600">
                      {formatBytes(doc.sizeBytes)} — uploaded {formatDate(doc.createdAt)}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={downloadingId === doc.id}
                      onClick={() => void onDownload(doc)}
                      className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-50"
                    >
                      {downloadingId === doc.id ? "Preparing…" : "Download"}
                    </button>
                    {confirmDeleteId === doc.id ? (
                      <>
                        <button
                          type="button"
                          disabled={deletingId === doc.id}
                          onClick={() => void onDelete(doc)}
                          className="rounded-md bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                        >
                          {deletingId === doc.id ? "Deleting…" : "Confirm delete"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setActionError(null);
                          setConfirmDeleteId(doc.id);
                        }}
                        className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ))}
        {actionError !== null && (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {actionError}
          </p>
        )}
      </section>

      <section aria-label="Upload documents" className="mt-10">
        <h2 className="text-lg font-semibold">Upload PDFs</h2>
        <p className="mt-1 text-sm text-zinc-600">
          PDF files only, up to {MAX_PDF_MB} MB each.
        </p>
        <input
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={onFilesSelected}
          aria-label="Choose PDF files to upload"
          className="mt-3 block w-full text-sm"
        />
        {uploads.length > 0 && (
          <ul className="mt-3 space-y-2" aria-label="Upload progress">
            {uploads.map((upload) => (
              <li
                key={upload.key}
                className="rounded-md border border-zinc-200 px-3 py-2 text-sm"
              >
                <p className="truncate font-medium">{upload.filename}</p>
                <p className="mt-0.5 text-zinc-600">
                  {upload.phase === "uploading"
                    ? `Uploading… ${upload.progress}%`
                    : upload.phase === "done"
                      ? "Done"
                      : "Failed"}
                </p>
                {upload.phase === "uploading" && (
                  <div
                    className="mt-1 h-1.5 w-full rounded bg-zinc-200"
                    role="progressbar"
                    aria-valuenow={upload.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-1.5 rounded bg-zinc-900"
                      style={{ width: `${upload.progress}%` }}
                    />
                  </div>
                )}
                {upload.phase === "error" && upload.message !== null && (
                  <p className="mt-0.5 text-red-700" role="alert">
                    {upload.message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
