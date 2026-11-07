"use client";

import Link from "next/link";
import { useState } from "react";
import { FileText, Inbox, Trash2 } from "lucide-react";
import type { DocumentRecord } from "@/lib/store/types";
import { formatBytes, formatDate } from "@/lib/utils";
import { ApiError, deleteDocument } from "./api";
import { DocStatusBadge, SourceBadge } from "./badges";
import { Button } from "./ui/button";

interface Props {
  documents: DocumentRecord[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onDeleted: (id: string) => void;
  onUnauthorized: () => void;
}

export function DocumentList({ documents, loading, error, onRetry, onDeleted, onUnauthorized }: Props) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(doc: DocumentRecord) {
    if (!window.confirm(`Delete "${doc.filename}" and its findings? This cannot be undone.`)) return;
    setDeletingId(doc.id);
    try {
      await deleteDocument(doc.id);
      onDeleted(doc.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      window.alert("Delete failed. Please retry.");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-2" aria-label="Loading documents">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-md bg-stone-100" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
        <p>{error}</p>
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-4 py-10 text-center">
        <Inbox className="h-5 w-5 text-stone-500" strokeWidth={1.5} aria-hidden />
        <p className="text-sm font-medium text-stone-800">No documents yet</p>
        <p className="max-w-sm text-sm text-stone-600">
          Upload a contract PDF to see your first analysis.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-left text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-xs font-medium text-stone-600">
            <th className="px-3 py-2" scope="col">
              Document
            </th>
            <th className="w-32 px-3 py-2" scope="col">
              Status
            </th>
            <th className="w-16 px-3 py-2 text-right" scope="col">
              Pages
            </th>
            <th className="w-20 px-3 py-2 text-right" scope="col">
              Findings
            </th>
            <th className="w-44 px-3 py-2" scope="col">
              Uploaded
            </th>
            <th className="w-16 px-3 py-2 text-right" scope="col">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id} className="border-b border-stone-100 transition-colors duration-150 ease-app last:border-0 hover:bg-stone-50">
              <td className="max-w-55 px-3 py-2.5">
                <Link
                  href={`/documents/${doc.id}`}
                  className="flex items-center gap-2 font-medium text-teal-900 hover:underline"
                >
                  <FileText className="h-4 w-4 shrink-0 text-stone-500" strokeWidth={1.5} aria-hidden />
                  <span className="truncate" title={doc.filename}>
                    {doc.filename}
                  </span>
                </Link>
                <div className="mt-1 flex items-center gap-2 text-xs text-stone-600">
                  <SourceBadge source={doc.source} />
                  <span className="tabular-nums">{formatBytes(doc.sizeBytes)}</span>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <DocStatusBadge status={doc.status} />
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">{doc.pageCount ?? "—"}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{doc.findingCount}</td>
              <td className="px-3 py-2.5 text-stone-600 tabular-nums whitespace-nowrap">{formatDate(doc.createdAt)}</td>
              <td className="px-3 py-2.5 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${doc.filename}`}
                  disabled={deletingId === doc.id}
                  onClick={() => void handleDelete(doc)}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
