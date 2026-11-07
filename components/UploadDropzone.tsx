"use client";

import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import type { DocumentRecord } from "@/lib/store/types";
import { cn } from "@/lib/utils";
import { ApiError, MAX_PDF_PAGES, MAX_UPLOAD_BYTES_CLIENT, MAX_UPLOAD_MB, uploadDocument } from "./api";
import { Button } from "./ui/button";

interface Props {
  onUploaded: (doc: DocumentRecord, findingCount: number) => void;
  onUnauthorized: () => void;
}

export function UploadDropzone({ onUploaded, onUnauthorized }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file || busy) return;
    // Client-side pre-check only; the server re-validates everything.
    if (!/\.pdf$/i.test(file.name)) {
      setError("Only .pdf files are accepted.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES_CLIENT) {
      setError(`File exceeds the ${MAX_UPLOAD_MB} MB limit.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await uploadDocument(file);
      onUploaded(res.document, res.findings.length);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : "Upload failed unexpectedly.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFile(e.dataTransfer.files[0]);
        }}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors duration-150 ease-app focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700",
          dragging ? "border-teal-700 bg-teal-50" : "border-stone-300 bg-stone-50 hover:border-stone-400",
          busy && "cursor-wait opacity-70",
        )}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin text-teal-800" strokeWidth={1.5} aria-hidden />
        ) : (
          <FileUp className="h-5 w-5 text-stone-500" strokeWidth={1.5} aria-hidden />
        )}
        <span className="text-sm font-medium text-stone-800" aria-live="polite">
          {busy ? "Uploading and analyzing…" : "Drop a contract PDF here, or click to browse"}
        </span>
        <span className="font-mono text-xs text-stone-600">
          PDF only · {MAX_UPLOAD_MB} MB max · {MAX_PDF_PAGES} pages max
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      {error && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          <p>{error}</p>
          <Button variant="ghost" size="sm" className="mt-1 px-0 text-red-900" onClick={() => inputRef.current?.click()}>
            Try another file
          </Button>
        </div>
      )}
    </div>
  );
}
