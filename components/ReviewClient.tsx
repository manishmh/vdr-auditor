"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Download, Loader2, Trash2 } from "lucide-react";
import type { StoredFinding } from "@/lib/findings/schema";
import type { DocumentRecord } from "@/lib/store/types";
import { formatBytes, formatDate } from "@/lib/utils";
import { ApiError, deleteDocument, downloadOriginal, fetchDocument } from "./api";
import { DocStatusBadge, SourceBadge } from "./badges";
import { FindingsExplorer } from "./FindingsExplorer";
import { PilotTokenPrompt } from "./PilotTokenPrompt";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "./ui/card";

export function ReviewClient({ docId }: { docId: string }) {
  const router = useRouter();
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [findings, setFindings] = useState<StoredFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    fetchDocument(docId).then(
      (res) => {
        if (!active) return;
        setDocument(res.document);
        setFindings(res.findings);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          setUnauthorized(true);
          setLoading(false);
          return;
        }
        setError(err instanceof ApiError ? err.message : "Could not load this document.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [docId, reloadKey]);

  function reload() {
    setUnauthorized(false);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  async function handleDownload() {
    if (!document || downloading) return;
    setDownloading(true);
    try {
      await downloadOriginal(document.id, document.filename);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUnauthorized(true);
        return;
      }
      window.alert("Download failed. Please retry.");
    } finally {
      setDownloading(false);
    }
  }

  async function handleDelete() {
    if (!document || !window.confirm(`Delete "${document.filename}" and its findings? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteDocument(document.id);
      router.push("/");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUnauthorized(true);
        return;
      }
      window.alert("Delete failed. Please retry.");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-label="Loading document">
        <div className="h-8 w-64 animate-pulse rounded bg-stone-200" />
        <div className="h-40 animate-pulse rounded-lg bg-stone-100" />
        <div className="h-64 animate-pulse rounded-lg bg-stone-100" />
      </div>
    );
  }

  if (unauthorized) {
    return (
      <div>
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-teal-900 hover:underline">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden /> Back to documents
        </Link>
        <div className="mt-4">
          <PilotTokenPrompt onUnlocked={reload} />
        </div>
      </div>
    );
  }

  if (error || !document) {
    return (
      <div>
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-teal-900 hover:underline">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden /> Back to documents
        </Link>
        <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p>{error ?? "Document not found."}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={reload}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const showFindings = document.status === "completed" || document.status === "partial";

  return (
    <div>
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-teal-900 hover:underline">
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden /> Back to documents
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-medium tracking-tight break-words text-stone-900">
              {document.filename}
            </h1>
            <SourceBadge source={document.source} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-600 tabular-nums">
            <DocStatusBadge status={document.status} />
            <span>{document.pageCount != null ? `${document.pageCount} pages` : "Pages unknown"}</span>
            <span>{formatBytes(document.sizeBytes)}</span>
            <span>Uploaded {formatDate(document.createdAt)}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {document.source === "upload" && (
            <Button variant="secondary" size="sm" disabled={downloading} onClick={() => void handleDownload()}>
              <Download className="h-4 w-4" strokeWidth={1.5} aria-hidden /> {downloading ? "Preparing…" : "Original PDF"}
            </Button>
          )}
          <Button variant="danger" size="sm" disabled={deleting} onClick={() => void handleDelete()}>
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} aria-hidden />
            ) : (
              <Trash2 className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            )}
            Delete
          </Button>
        </div>
      </div>

      {document.source === "demo" && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Demo data: this agreement and its findings are synthetic, for exploring the workflow only.
        </p>
      )}
      {document.statusDetail && (
        <p className="mt-3 rounded-md border border-stone-200 bg-stone-100 px-4 py-2 text-sm break-words text-stone-700">
          {document.statusDetail}
        </p>
      )}
      {document.status === "failed" && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-medium">Processing failed</p>
          <p className="mt-1">This document was not analyzed. Upload it again or try a different file.</p>
        </div>
      )}
      {document.status === "needs_ocr" && (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-medium">Scanned document — not analyzed</p>
          <p className="mt-1">
            Almost no text could be extracted. OCR for scanned PDFs is planned but not available in
            this build, so no findings were produced.
          </p>
        </div>
      )}
      {(document.status === "queued" || document.status === "processing") && (
        <div className="mt-3 rounded-md border border-stone-200 bg-stone-100 px-4 py-3 text-sm text-stone-700">
          <p className="font-medium">Still processing — or the run was interrupted</p>
          <p className="mt-1">
            This document has no results yet. If it stays here, upload it again to retry; uploads
            are processed synchronously, so a finished upload always lands in a final state.
          </p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={reload}>
            Check again
          </Button>
        </div>
      )}

      {showFindings && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>
              Findings{" "}
              <span className="font-sans text-sm font-normal text-stone-600">
                — candidates for human review, not legal conclusions
              </span>
            </CardTitle>
          </CardHeader>
          <CardBody>
            <FindingsExplorer
              documentId={document.id}
              findings={findings}
              onFindingUpdated={(updated) =>
                setFindings((list) => list.map((f) => (f.id === updated.id ? updated : f)))
              }
              onUnauthorized={() => setUnauthorized(true)}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
