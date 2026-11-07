"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DocumentRecord } from "@/lib/store/types";
import { ApiError, fetchDocuments } from "./api";
import { DocumentList } from "./DocumentList";
import { PilotTokenPrompt } from "./PilotTokenPrompt";
import { Card, CardBody, CardHeader, CardTitle } from "./ui/card";
import { UploadDropzone } from "./UploadDropzone";

export function Dashboard() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; name: string; count: number } | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    fetchDocuments().then(
      (res) => {
        if (!active) return;
        setDocuments(res.documents);
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
        setError(err instanceof ApiError ? err.message : "Could not load documents.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  function reload() {
    setUnauthorized(false);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  if (unauthorized) {
    return <PilotTokenPrompt onUnlocked={reload} />;
  }

  const totalFindings = documents.reduce((sum, d) => sum + d.findingCount, 0);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-3xl font-medium tracking-tight text-stone-900">
            Deal documents
          </h1>
          <p className="mt-1 text-sm text-stone-600 tabular-nums">
            {documents.length} document{documents.length === 1 ? "" : "s"} · {totalFindings} candidate
            finding{totalFindings === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="mt-4 rounded-md border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900"
        >
          <span className="font-medium">{notice.name}</span> analyzed — {notice.count} candidate
          finding{notice.count === 1 ? "" : "s"}.{" "}
          <Link href={`/documents/${notice.id}`} className="font-medium underline">
            Open review
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Documents</CardTitle>
            </CardHeader>
            <CardBody>
              <DocumentList
                documents={documents}
                loading={loading}
                error={error}
                onRetry={reload}
                onDeleted={(id) => setDocuments((docs) => docs.filter((d) => d.id !== id))}
                onUnauthorized={() => setUnauthorized(true)}
              />
            </CardBody>
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Upload contract</CardTitle>
            </CardHeader>
            <CardBody>
              <UploadDropzone
                onUploaded={(doc, count) => {
                  reload();
                  setNotice({ id: doc.id, name: doc.filename, count });
                }}
                onUnauthorized={() => setUnauthorized(true)}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
