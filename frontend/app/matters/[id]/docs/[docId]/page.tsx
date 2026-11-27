"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  REVIEW_STATUS_LABELS,
  SEVERITY_LABELS,
  listAnalyses,
  listDocAnalyses,
  listFindings,
  updateFindingReview,
  type AnalysisRun,
  type DocAnalysis,
  type Finding,
  type FindingSeverity,
  type ReviewStatus,
} from "@/lib/analyses";
import { formatBytes, formatDate, formatDuration } from "@/lib/format";
import {
  EMPTY_FINDING_FILTERS,
  applyFindingFilters,
  describeFindingFilters,
  isFiltered,
} from "@/lib/findingsView";
import { storedPageToPdfPage } from "@/lib/pdfText";
import {
  APP_CONFIG_ERROR_MESSAGE,
  getMatter,
  type Matter,
} from "@/lib/matters";
import {
  EXTRACTION_STATUS_LABELS,
  PAGE_SEPARATOR,
  deleteDocument,
  downloadDocument,
  extractionErrorMessage,
  getDocumentText,
  isAwaitingUpload,
  listDocuments,
  type DocumentExtractionStatus,
  type DocumentText,
  type MatterDocument,
} from "@/lib/documents";
import {
  isActiveProcessingStage,
  isStaleActiveRun,
  latestRunPerDoc,
  listProcessingRuns,
  notifyProcessingChanged,
  notifyProcessingRuns,
  PROCESSING_STAGE_LABELS,
  processingErrorMessage,
  retryProcessing,
  type ProcessingRunSummary,
  type ProcessingStage,
} from "@/lib/processing";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBlock,
  LoadingLine,
  ProgressBar,
  Section,
  type BadgeTone,
} from "../../../../components/ui";
import { FindingGroups, FindingsEmpty } from "../../../../components/findings";
import PdfViewer, { type HighlightReport } from "../../../../components/PdfViewer";
import ReviewQueue from "../../../../components/ReviewQueue";

const API_URL = process.env["NEXT_PUBLIC_API_URL"];
const POLL_MS = 4000;
/** Backoff ceiling while the run sits unchanged; analysis takes minutes. */
const POLL_MAX_MS = 15000;

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

const EXTRACTION_TONE: Record<DocumentExtractionStatus, BadgeTone> = {
  pending: "neutral",
  processing: "warning",
  completed: "success",
  no_text: "warning",
  failed: "danger",
};

const PROCESSING_TONE: Record<ProcessingStage, BadgeTone> = {
  queued: "neutral",
  extracting: "warning",
  analyzing: "warning",
  validating: "warning",
  completed: "success",
  completed_with_limits: "warning",
  failed: "danger",
};

const STEPS: Array<{ id: string; label: string }> = [
  { id: "queued", label: "Queued" },
  { id: "extracting", label: "Extracting" },
  { id: "analyzing", label: "Analyzing" },
  { id: "done", label: "Done" },
];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function runsSignature(runs: ProcessingRunSummary[]): string {
  return runs
    .map((run) => `${run.id}:${run.stage}:${run.updatedAt}`)
    .sort()
    .join("|");
}

function stepIndexFor(run: ProcessingRunSummary | undefined): number {
  if (run === undefined) {
    return 0;
  }
  switch (run.stage) {
    case "queued":
      return 0;
    case "extracting":
      return 1;
    case "analyzing":
    case "validating":
      return 2;
    default:
      return 3;
  }
}

function ExtractedText({ text }: { text: string }) {
  const pages = text.split(PAGE_SEPARATOR);
  return (
    <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      {pages.map((page, index) => (
        <div key={index} className={index > 0 ? "mt-3" : undefined}>
          {pages.length > 1 && (
            <p className="text-xs font-semibold text-slate-500">Page {index + 1}</p>
          )}
          <pre className="whitespace-pre-wrap font-sans text-sm text-slate-800">
            {page === "" ? "(blank page)" : page}
          </pre>
        </div>
      ))}
    </div>
  );
}

export default function DocumentDetailPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-7xl px-6 py-8">
          <LoadingLine>Loading document…</LoadingLine>
        </main>
      }
    >
      <DocumentDetail />
    </Suspense>
  );
}

function DocumentDetail() {
  const params = useParams();
  const router = useRouter();
  const rawMatterId = params?.id;
  const rawDocId = params?.docId;
  const matterId = typeof rawMatterId === "string" ? rawMatterId : "";
  const docId = typeof rawDocId === "string" ? rawDocId : "";
  const idsReady = matterId !== "" && docId !== "";

  // Both server and client render this identical initial state, so
  // hydration always matches; misconfiguration surfaces without an effect.
  const configError =
    !idsReady || API_URL === undefined || API_URL === ""
      ? !idsReady
        ? "We couldn't find that document."
        : APP_CONFIG_ERROR_MESSAGE
      : null;
  const [matter, setMatter] = useState<LoadState<Matter>>(
    configError === null ? { status: "loading" } : { status: "error", message: configError },
  );
  const [doc, setDoc] = useState<LoadState<MatterDocument>>(
    configError === null ? { status: "loading" } : { status: "error", message: configError },
  );
  const [runs, setRuns] = useState<ProcessingRunSummary[]>([]);
  const [analyses, setAnalyses] = useState<LoadState<DocAnalysis[]>>(
    configError === null ? { status: "loading" } : { status: "error", message: configError },
  );
  const [findings, setFindings] = useState<LoadState<Finding[]>>(
    configError === null ? { status: "loading" } : { status: "error", message: configError },
  );
  const [history, setHistory] = useState<AnalysisRun[]>([]);
  const [severityFilter, setSeverityFilter] = useState<"all" | FindingSeverity>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | ReviewStatus>("all");
  const searchParams = useSearchParams();
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(() =>
    searchParams.get("finding"),
  );
  const [manualPage, setManualPage] = useState(1);
  const [viewerNumPages, setViewerNumPages] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<HighlightReport | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [docText, setDocText] = useState<LoadState<DocumentText> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [findingsError, setFindingsError] = useState<string | null>(null);
  const pollInFlight = useRef(false);
  const lastRunsSignature = useRef("");
  // Monotonic read generation: only the newest loadAll may apply state, so
  // overlapping reads can never regress the page.
  const loadSeq = useRef(0);

  const loadAll = useCallback(
    async (apiUrl: string, id: string, targetDocId: string, silent: boolean): Promise<void> => {
      const seq = ++loadSeq.current;
      const live = (): boolean => seq === loadSeq.current;
      if (!silent) {
        setDoc({ status: "loading" });
        setAnalyses({ status: "loading" });
        setFindings({ status: "loading" });
      }
      const applyDoc = (result: PromiseSettledResult<MatterDocument[]>): void => {
        if (result.status === "fulfilled") {
          const found = result.value.find((item) => item.id === targetDocId);
          if (found === undefined) {
            setDoc({
              status: "error",
              message: "That document is no longer available. It may have been deleted.",
            });
            return;
          }
          setDoc({ status: "ready", value: found });
        } else if (!silent) {
          setDoc({
            status: "error",
            message: errorMessage(result.reason, "Couldn't load this document. Please try again."),
          });
        }
      };
      const applyAnalyses = (result: PromiseSettledResult<DocAnalysis[]>): void => {
        if (result.status === "fulfilled") {
          setAnalyses({ status: "ready", value: result.value });
        } else if (!silent) {
          setAnalyses({
            status: "error",
            message: errorMessage(result.reason, "Couldn't load analysis. Please try again."),
          });
        }
      };
      const applyFindings = (result: PromiseSettledResult<Finding[]>): void => {
        if (result.status === "fulfilled") {
          setFindings({ status: "ready", value: result.value });
        } else if (!silent) {
          setFindings({
            status: "error",
            message: errorMessage(result.reason, "Couldn't load findings. Please try again."),
          });
        }
      };
      if (!silent) {
        // First load: everything in parallel for speed. Documents arrive
        // without extracted text; text loads on demand from its own section.
        const [runsRes, analysesRes, docsRes, findingsRes, historyRes] = await Promise.allSettled([
          listProcessingRuns(apiUrl, id),
          listAnalyses(apiUrl, id),
          listDocuments(apiUrl, id, { includeText: false }),
          listFindings(apiUrl, id),
          listDocAnalyses(apiUrl, id, targetDocId),
        ]);
        if (!live()) {
          return;
        }
        if (runsRes.status === "fulfilled") {
          const latest = latestRunPerDoc(runsRes.value);
          lastRunsSignature.current = runsSignature(latest);
          setRuns(latest);
          notifyProcessingRuns(latest);
        } else {
          setRuns([]);
        }
        applyAnalyses(analysesRes);
        applyDoc(docsRes);
        applyFindings(findingsRes);
        if (historyRes.status === "fulfilled") {
          setHistory(historyRes.value);
        }
        return;
      }
      // Silent refresh: light collections first, heavy only on real change.
      // Silent refetches bypass the cache; only the initial load may serve it.
      const [runsRes, analysesRes] = await Promise.allSettled([
        listProcessingRuns(apiUrl, id),
        listAnalyses(apiUrl, id),
      ]);
      if (!live()) {
        return;
      }
      let heavy = false;
      if (runsRes.status === "fulfilled") {
        const latest = latestRunPerDoc(runsRes.value);
        heavy = runsSignature(latest) !== lastRunsSignature.current;
        lastRunsSignature.current = runsSignature(latest);
        setRuns(latest);
        // Let the global indicator reuse this fetch instead of polling the
        // same runs itself a moment later.
        notifyProcessingRuns(latest);
      }
      if (analysesRes.status === "fulfilled") {
        setAnalyses({ status: "ready", value: analysesRes.value });
      }
      if (!heavy) {
        return;
      }
      const [docsRes, findingsRes, historyRes] = await Promise.allSettled([
        listDocuments(apiUrl, id, { fresh: true, includeText: false }),
        listFindings(apiUrl, id),
        listDocAnalyses(apiUrl, id, targetDocId),
      ]);
      if (!live()) {
        return;
      }
      if (docsRes.status === "fulfilled") {
        const found = docsRes.value.find((item) => item.id === targetDocId);
        if (found === undefined) {
          setDoc({
            status: "error",
            message: "That document is no longer available. It may have been deleted.",
          });
        } else {
          setDoc({ status: "ready", value: found });
        }
      }
      if (findingsRes.status === "fulfilled") {
        setFindings({ status: "ready", value: findingsRes.value });
      }
      if (historyRes.status === "fulfilled") {
        setHistory(historyRes.value);
      }
    },
    [],
  );

  useEffect(() => {
    if (!idsReady || API_URL === undefined || API_URL === "") {
      return;
    }
    const apiUrl: string = API_URL;
    const id: string = matterId;
    const targetDocId: string = docId;
    getMatter(apiUrl, id).then(
      (value) => {
        setMatter({ status: "ready", value });
        void loadAll(apiUrl, id, targetDocId, false);
      },
      (err: unknown) => {
        const message = errorMessage(err, "Couldn't load this matter. Please try again.");
        setMatter({ status: "error", message });
        setDoc({ status: "error", message });
        setAnalyses({ status: "error", message });
        setFindings({ status: "error", message });
      },
    );
  }, [matterId, docId, idsReady, loadAll]);

  const run = runs.find((item) => item.docId === docId);
  const runActive = run !== undefined && isActiveProcessingStage(run.stage);
  const runStale = run !== undefined && isStaleActiveRun(run);
  const readyAnalyses = analyses.status === "ready" ? analyses.value : [];
  const docAnalyses = readyAnalyses.filter((item) => item.docId === docId);
  const latestAnalysis = docAnalyses[0];
  const runningAnalysis =
    latestAnalysis?.status === "running" ? latestAnalysis : undefined;
  const docFindings =
    findings.status === "ready"
      ? findings.value.filter((item) => item.docId === docId)
      : [];
  const analysisInProgress = runActive || runningAnalysis !== undefined;
  // Uploads acknowledge before their bytes land; keep polling until the
  // bytes arrive (processing then starts) or the upload fails.
  const awaitingUpload =
    doc.status === "ready" ? isAwaitingUpload(doc.value) : false;
  const railFilters = {
    ...EMPTY_FINDING_FILTERS,
    severity: severityFilter,
    reviewStatus: statusFilter,
  };
  const visibleFindings = applyFindingFilters(docFindings, railFilters);
  const railFiltered = isFiltered(railFilters);
  const selectedFinding =
    selectedFindingId === null
      ? undefined
      : docFindings.find((item) => item.id === selectedFindingId);
  // The viewer follows the selected finding's real PDF page; manual page
  // controls deselect and take over instead. Fully derived: no sync effects.
  const viewerLength =
    viewerNumPages ?? (doc.status === "ready" ? (doc.value.pageCount ?? null) : null);
  const selectedPdfPage = storedPageToPdfPage(
    selectedFinding?.page ?? null,
    doc.status === "ready" ? doc.value.pageOffset : undefined,
    viewerLength,
  );
  const viewerPage = selectedPdfPage ?? manualPage;
  const viewerExcerpt =
    selectedFinding === undefined || selectedFinding.page === null
      ? null
      : selectedFinding.excerpt;
  const railFilterSummary = describeFindingFilters(railFilters, {
    severityLabel: (severity) => SEVERITY_LABELS[severity],
    categoryLabel: (category) => category,
    statusLabel: (status) => REVIEW_STATUS_LABELS[status],
    docName: () => undefined,
  });
  const severityCounts: Record<FindingSeverity, number> = {
    high: docFindings.filter((item) => item.severity === "high").length,
    medium: docFindings.filter((item) => item.severity === "medium").length,
    low: docFindings.filter((item) => item.severity === "low").length,
  };

  // Follow this document's run while it is active. Ticks funnel through
  // the sequenced loadAll, which refetches the heavy collections only when
  // the run actually advances. Ticks never overlap, never fire for a hidden
  // tab, and back off while nothing changes: analysis runs for minutes per
  // document, so a fixed 4s cadence would fire hundreds of requests per
  // document for no new information.
  useEffect(() => {
    if (
      !idsReady ||
      API_URL === undefined ||
      API_URL === "" ||
      (!analysisInProgress && !awaitingUpload)
    ) {
      return;
    }
    const apiUrl: string = API_URL;
    const id: string = matterId;
    const targetDocId: string = docId;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let quietTicks = 0;
    const schedule = (delayMs: number): void => {
      if (!stopped) {
        timer = setTimeout(tick, delayMs);
      }
    };
    const tick = () => {
      if (stopped) {
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        schedule(POLL_MS);
        return;
      }
      if (pollInFlight.current) {
        schedule(POLL_MS);
        return;
      }
      const before = lastRunsSignature.current;
      pollInFlight.current = true;
      void loadAll(apiUrl, id, targetDocId, true).finally(() => {
        pollInFlight.current = false;
        if (stopped) {
          return;
        }
        quietTicks = lastRunsSignature.current === before ? quietTicks + 1 : 0;
        schedule(Math.min(POLL_MS * 2 ** quietTicks, POLL_MAX_MS));
      });
    };
    schedule(POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [matterId, docId, idsReady, analysisInProgress, awaitingUpload, loadAll]);

  const ready = API_URL !== undefined && API_URL !== "" && idsReady;
  const viewerUrl =
    ready && doc.status === "ready"
      ? `${API_URL}/api/matters/${matterId}/documents/${docId}/download?inline=1`
      : null;

  const selectFinding = (finding: Finding): void => {
    setHighlight(null);
    setSelectedFindingId(finding.id);
  };

  const onViewerPageChange = (pageNumber: number): void => {
    // Manual navigation takes over: the viewer stays where the user put it.
    setManualPage(pageNumber);
    setSelectedFindingId(null);
    setHighlight(null);
  };

  // Bring a selected (or deep-linked) card into view without stealing
  // focus. Re-runs as findings load so deep links land after the fetch.
  useEffect(() => {
    if (selectedFindingId === null) {
      return;
    }
    document
      .getElementById(`finding-card-${selectedFindingId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedFindingId, docFindings.length]);

  const onDownload = async () => {
    if (!ready || doc.status !== "ready") {
      return;
    }
    setDownloading(true);
    setActionError(null);
    try {
      await downloadDocument(API_URL, matterId, doc.value);
    } catch (err: unknown) {
      setActionError(errorMessage(err, "Couldn't download this file. Please try again."));
    } finally {
      setDownloading(false);
    }
  };

  const seedRuns = (seeded: ProcessingRunSummary[]): void => {
    // Functional merge: the follow-up loadAll recomputes the signature.
    setRuns((prev) => latestRunPerDoc([...seeded, ...prev]));
  };

  const onRetry = async () => {
    if (!ready) {
      return;
    }
    setRetrying(true);
    setActionError(null);
    try {
      const run = await retryProcessing(API_URL, matterId, docId);
      if (run !== null) {
        seedRuns([run]);
      }
      void loadAll(API_URL, matterId, docId, true);
      notifyProcessingChanged();
    } catch (err: unknown) {
      setActionError(errorMessage(err, "Couldn't restart processing. Please try again."));
      void loadAll(API_URL, matterId, docId, true);
    } finally {
      setRetrying(false);
    }
  };

  const onDelete = async () => {
    if (!ready) {
      return;
    }
    setDeleting(true);
    setActionError(null);
    try {
      await deleteDocument(API_URL, matterId, docId);
      notifyProcessingChanged();
      router.push(`/matters/${matterId}`);
    } catch (err: unknown) {
      setActionError(errorMessage(err, "Couldn't delete this document. Please try again."));
      void loadAll(API_URL, matterId, docId, true);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const onReviewChange = async (finding: Finding, reviewStatus: ReviewStatus) => {
    if (!ready) {
      return;
    }
    setFindingsError(null);
    try {
      const updated = await updateFindingReview(API_URL, matterId, finding.id, reviewStatus);
      setFindings((prev) =>
        prev.status === "ready"
          ? {
              status: "ready",
              value: prev.value.map((item) => (item.id === updated.id ? updated : item)),
            }
          : prev,
      );
    } catch (err: unknown) {
      setFindingsError(errorMessage(err, "Couldn't save that change. Please try again."));
      throw err instanceof Error ? err : new Error("Couldn't save that change.");
    }
  };

  const toggleText = (): void => {
    const next = !textOpen;
    setTextOpen(next);
    if (next && docText === null && ready) {
      setDocText({ status: "loading" });
      void getDocumentText(API_URL, matterId, docId).then(
        (value) => {
          setDocText({ status: "ready", value });
        },
        (err: unknown) => {
          setDocText({
            status: "error",
            message: errorMessage(err, "Couldn't load extracted text. Please try again."),
          });
        },
      );
    }
  };

  const failedAnalyses = docAnalyses.filter((item) => item.status === "failed");
  const limitedAnalyses = docAnalyses.filter((item) => item.status === "limited");
  const completedAnalyses = docAnalyses.filter((item) => item.status === "completed");
  const latestHistory = history[0];
  const currentHistory = history.find(
    (item) => item.status === "completed" || item.status === "limited",
  );
  const historyDuration =
    latestHistory?.finishedAt === undefined
      ? null
      : formatDuration(
          Date.parse(latestHistory.finishedAt) - Date.parse(latestHistory.startedAt),
        );
  const stepIndex = stepIndexFor(run);
  const progressTotal = runningAnalysis?.sectionsTotal ?? 0;
  const progressDone = runningAnalysis?.sectionsAnalyzed ?? 0;
  const showProgressBar =
    runActive && run?.stage !== "queued" && run?.stage !== "extracting" && progressTotal > 0;
  const deleteBlocked = runActive && !runStale;
  const showRetry = run?.stage === "failed" || runStale;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-2 text-sm">
          <li>
            <Link
              href="/"
              className="rounded text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
            >
              Matters
            </Link>
          </li>
          <li aria-hidden="true" className="text-slate-400">
            /
          </li>
          <li>
            <Link
              href={`/matters/${matterId}`}
              className="rounded text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
            >
              {matter.status === "ready" ? matter.value.title : "…"}
            </Link>
          </li>
          <li aria-hidden="true" className="text-slate-400">
            /
          </li>
          <li aria-current="page" className="truncate text-slate-600">
            {doc.status === "ready" ? doc.value.filename : "…"}
          </li>
        </ol>
      </nav>

      {doc.status === "loading" && (
        <div className="mt-4">
          <LoadingLine>Loading document…</LoadingLine>
        </div>
      )}
      {doc.status === "error" && (
        <div className="mt-4">
          <ErrorBlock
            message={doc.message}
            onRetry={ready ? () => loadAll(API_URL, matterId, docId, false) : undefined}
          />
          <p className="mt-3 text-sm">
            <Link
              href={`/matters/${matterId}`}
              className="rounded text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
            >
              ← Back to the matter
            </Link>
          </p>
        </div>
      )}
      {doc.status === "ready" && (
        <>
          <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="break-words text-2xl font-semibold tracking-tight text-slate-900">
                {doc.value.filename}
              </h1>
              <p className="mt-2 text-[13px] tabular-nums text-slate-500">
                {formatBytes(doc.value.sizeBytes)} · Uploaded {formatDate(doc.value.createdAt)}
                {doc.value.pageCount !== undefined &&
                  ` · ${doc.value.pageCount} ${doc.value.pageCount === 1 ? "page" : "pages"}`}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              {run === undefined ? (
                awaitingUpload ? (
                  <Badge tone="info">Uploading</Badge>
                ) : (
                  <Badge tone={EXTRACTION_TONE[doc.value.extractionStatus]}>
                    {EXTRACTION_STATUS_LABELS[doc.value.extractionStatus]}
                  </Badge>
                )
              ) : (
                <Badge tone={PROCESSING_TONE[run.stage]}>
                  {PROCESSING_STAGE_LABELS[run.stage]}
                </Badge>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={downloading || awaitingUpload}
              title={awaitingUpload ? "Available once the file finishes uploading." : undefined}
              onClick={() => void onDownload()}
            >
              {downloading ? "Preparing…" : "Download"}
            </Button>
            {showRetry && (
              <Button size="sm" disabled={retrying} onClick={() => void onRetry()}>
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            )}
            {confirmDelete ? (
              <>
                <Button size="sm" variant="danger" disabled={deleting} onClick={() => void onDelete()}>
                  {deleting ? "Deleting…" : "Confirm delete"}
                </Button>
                <Button size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={deleteBlocked}
                title={
                  deleteBlocked ? "Deletion is paused while this document is processing." : undefined
                }
                onClick={() => {
                  setActionError(null);
                  setConfirmDelete(true);
                }}
              >
                Delete
              </Button>
            )}
          </div>
          {actionError !== null && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {actionError}
            </p>
          )}

          {(runActive || run?.stage === "failed") && (
            <section
              aria-label="Review progress"
              className="mt-6 rounded-lg border border-slate-200 bg-white px-5 py-4"
            >
              <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                {STEPS.map((step, index) => {
                  const reached = index < stepIndex;
                  const current = index === stepIndex && runActive;
                  return (
                    <li key={step.id} className="flex items-center gap-3">
                      {index > 0 && <span aria-hidden="true" className="text-slate-300">→</span>}
                      <span
                        className={
                          current
                            ? "font-semibold text-slate-900"
                            : reached
                              ? "text-slate-600"
                              : "text-slate-400"
                        }
                        aria-current={current ? "step" : undefined}
                      >
                        {step.label}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-3">
                {run?.stage === "failed" ? (
                  <p className="text-sm text-red-700" role="alert">
                    {processingErrorMessage(run.error)}
                  </p>
                ) : run?.stage === "extracting" || run?.stage === "queued" ? (
                  <p className="text-sm text-slate-600" role="status">
                    Reading the PDF and pulling out its text…
                  </p>
                ) : showProgressBar ? (
                  <>
                    <ProgressBar
                      value={progressDone}
                      max={progressTotal}
                      label={`Analyzed ${progressDone} of ${progressTotal} sections`}
                    />
                    <p className="mt-1 text-[13px] tabular-nums text-slate-600" role="status">
                      Analyzing section {Math.min(progressDone + 1, progressTotal)} of{" "}
                      {progressTotal}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-slate-600" role="status">
                    Analyzing the document…
                  </p>
                )}
                {runStale && runActive && (
                  <p className="mt-1 text-[13px] text-amber-700">
                    Taking longer than usual — retry resumes it.
                  </p>
                )}
              </div>
            </section>
          )}

          {(failedAnalyses.length > 0 || limitedAnalyses.length > 0) && (
            <div className="mt-6 space-y-3">
              {failedAnalyses.map((item) => (
                <p key={item.id} className="text-sm text-red-700" role="alert">
                  The latest analysis failed. Retry above to try again; earlier verified
                  results are kept below.
                </p>
              ))}
              {limitedAnalyses.map((item) => (
                <div
                  key={item.id}
                  className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3"
                >
                  <p className="text-sm text-amber-800">
                    Analysis covered only part of this document
                    {item.totalPages !== undefined
                      ? ` (${item.pagesAnalyzed ?? 0} of ${item.totalPages} pages)`
                      : ""}
                    .
                  </p>
                  {item.limitations.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-sm text-amber-800">
                      {item.limitations.map((limitation, index) => (
                        <li key={index}>{limitation}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <section aria-label="Document viewer" className="min-h-0 min-w-0">
              <div className="h-[65vh] lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]">
                {viewerUrl === null ? (
                  <div className="flex h-full items-center justify-center rounded-lg border border-slate-200 bg-white px-6">
                    <LoadingLine>Loading document…</LoadingLine>
                  </div>
                ) : awaitingUpload ? (
                  <div className="flex h-full items-center justify-center rounded-lg border border-slate-200 bg-white px-6">
                    <LoadingLine>
                      Saving the file… the viewer appears automatically.
                    </LoadingLine>
                  </div>
                ) : (
                  <PdfViewer
                    key={viewerUrl}
                    url={viewerUrl}
                    page={viewerPage}
                    excerpt={viewerExcerpt}
                    highlightKey={selectedFinding?.id ?? ""}
                    onPagesKnown={setViewerNumPages}
                    onPageChange={onViewerPageChange}
                    onHighlight={setHighlight}
                  />
                )}
              </div>
            </section>

            <section aria-label="Findings" className="min-h-0 min-w-0">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Findings</h2>
                  <p className="mt-0.5 text-sm text-slate-600">
                    {docFindings.length === 0
                      ? "Due-diligence issues, each linked to its evidence."
                      : `${visibleFindings.length} of ${docFindings.length} · ${railFilterSummary}`}
                  </p>
                </div>
                {visibleFindings.length > 0 && (
                  <Button size="sm" variant="primary" onClick={() => setReviewOpen(true)}>
                    Review
                  </Button>
                )}
              </div>

              {docFindings.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div
                    className="flex items-center gap-1 text-[13px]"
                    role="group"
                    aria-label="Filter by severity"
                  >
                    {(
                      [
                        ["all", `All (${docFindings.length})`],
                        ["high", `High (${severityCounts.high})`],
                        ["medium", `Medium (${severityCounts.medium})`],
                        ["low", `Low (${severityCounts.low})`],
                      ] as Array<["all" | FindingSeverity, string]>
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setSeverityFilter(value)}
                        aria-pressed={severityFilter === value}
                        className={`rounded-full px-2.5 py-1 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800 ${
                          severityFilter === value
                            ? "bg-slate-900 text-white"
                            : "text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <select
                    aria-label="Filter by review status"
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as "all" | ReviewStatus)
                    }
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
                  >
                    <option value="all">All statuses</option>
                    {(Object.keys(REVIEW_STATUS_LABELS) as ReviewStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {REVIEW_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                  {railFiltered && (
                    <button
                      type="button"
                      onClick={() => {
                        setSeverityFilter("all");
                        setStatusFilter("all");
                      }}
                      className="rounded px-1 text-[13px] font-medium text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}

              <div className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
                {selectedFinding === undefined ? (
                  <p className="text-sm text-slate-600">
                    Select a finding below to locate its evidence in the PDF.
                  </p>
                ) : (
                  <>
                    <p className="text-[13px] font-medium text-slate-700">
                      Evidence
                      {selectedFinding.page !== null
                        ? ` · Page ${selectedPdfPage ?? selectedFinding.page}`
                        : " · no page cited"}
                    </p>
                    <blockquote className="mt-1 border-l-2 border-slate-300 pl-3 text-sm text-slate-600">
                      <p className="whitespace-pre-wrap break-words">{selectedFinding.excerpt}</p>
                    </blockquote>
                    <p className="mt-1 text-[13px] text-slate-600" role="status">
                      {selectedFinding.page === null
                        ? "This finding cites no page number, so the viewer stays put."
                        : highlight === null
                          ? `Locating evidence on page ${selectedPdfPage}…`
                          : highlight.matches > 0
                            ? `Highlighted on page ${selectedPdfPage} (${highlight.matches} ${highlight.matches === 1 ? "match" : "matches"}).`
                            : `Exact position not found on page ${selectedPdfPage} — line wrapping or text differences; the excerpt above is the evidence.`}
                    </p>
                  </>
                )}
              </div>

              <div className="mt-4 space-y-8">
                {(analyses.status === "loading" || findings.status === "loading") && (
                  <LoadingLine>Loading findings…</LoadingLine>
                )}
                {(analyses.status === "error" || findings.status === "error") && (
                  <ErrorBlock
                    message={
                      analyses.status === "error"
                        ? analyses.message
                        : "Couldn't load findings. Please try again."
                    }
                    onRetry={ready ? () => loadAll(API_URL, matterId, docId, false) : undefined}
                  />
                )}
                {analyses.status === "ready" &&
                  findings.status === "ready" &&
                  (docAnalyses.length === 0 ? (
                    <EmptyState
                      title="No findings yet"
                      body="Findings will appear here after analysis runs over this document."
                    />
                  ) : (
                    <>
                      {analysisInProgress && (
                        <LoadingLine>
                          Analysis in progress… verified findings appear below as sections
                          complete.
                        </LoadingLine>
                      )}
                      {docFindings.length === 0 ? (
                        <FindingsEmpty
                          input={{
                            analysisInProgress,
                            failedCount: failedAnalyses.length,
                            limitedCount: limitedAnalyses.length,
                            completedCount: completedAnalyses.length,
                          }}
                        />
                      ) : visibleFindings.length === 0 ? (
                        <EmptyState
                          title="No findings match these filters"
                          body="Loosen or clear the filters to see the rest."
                        />
                      ) : (
                        <FindingGroups
                          findings={visibleFindings}
                          showFilename={false}
                          onReviewChange={(finding, reviewStatus) => {
                            void onReviewChange(finding, reviewStatus).catch(() => undefined);
                          }}
                          selectedId={selectedFinding?.id ?? null}
                          onSelect={selectFinding}
                        />
                      )}
                    </>
                  ))}
                <p className="text-[13px] text-slate-500">
                  Findings are issue-spotting results for human review, not legal advice.
                </p>
              </div>
              {findingsError !== null && (
                <p className="mt-2 text-sm text-red-700" role="alert">
                  {findingsError}
                </p>
              )}
            </section>
          </div>

          {history.length > 0 && latestHistory !== undefined && (
            <Section
              label="Analysis history"
              description="Every analysis run for this document, newest first."
              action={
                <Button size="sm" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}>
                  {historyOpen ? "Hide history" : `Show all ${history.length} runs`}
                </Button>
              }
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  tone={
                    latestHistory.status === "completed"
                      ? "success"
                      : latestHistory.status === "limited"
                        ? "warning"
                        : latestHistory.status === "failed"
                          ? "danger"
                          : "info"
                  }
                >
                  {latestHistory.status === "completed"
                    ? "Completed"
                    : latestHistory.status === "limited"
                      ? "Partial"
                      : latestHistory.status === "failed"
                        ? "Failed"
                        : "Running"}
                </Badge>
                <span className="tabular-nums text-slate-600">
                  {formatDate(latestHistory.startedAt)}
                </span>
                {historyDuration !== null && (
                  <span className="tabular-nums text-slate-500">· {historyDuration}</span>
                )}
                {latestHistory.totalPages !== undefined && (
                  <span className="tabular-nums text-slate-500">
                    · {latestHistory.pagesAnalyzed ?? 0} of {latestHistory.totalPages} pages
                  </span>
                )}
              </div>
              {currentHistory !== undefined && currentHistory.id !== latestHistory.id ? (
                <p className="mt-1 text-[13px] text-slate-600">
                  Showing results from the {formatDate(currentHistory.startedAt)}{" "}
                  {currentHistory.status === "completed" ? "completed" : "partial"} run — the
                  latest attempt did not produce results.
                </p>
              ) : (
                <p className="mt-1 text-[13px] text-slate-600">
                  {docFindings.length === 0
                    ? "No current findings from this run."
                    : `${docFindings.length} current ${docFindings.length === 1 ? "finding" : "findings"} from this run.`}
                </p>
              )}
              {historyOpen && (
                <ul className="mt-3 space-y-2">
                  {history.map((item) => (
                    <li
                      key={item.id}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={
                            item.status === "completed"
                              ? "success"
                              : item.status === "limited"
                                ? "warning"
                                : item.status === "failed"
                                  ? "danger"
                                  : "info"
                          }
                        >
                          {item.status === "completed"
                            ? "Completed"
                            : item.status === "limited"
                              ? "Partial"
                              : item.status === "failed"
                                ? "Failed"
                                : "Running"}
                        </Badge>
                        <span className="tabular-nums text-slate-600">
                          {formatDate(item.startedAt)}
                        </span>
                        {item.totalPages !== undefined && (
                          <span className="tabular-nums text-slate-500">
                            {item.pagesAnalyzed ?? 0} of {item.totalPages} pages
                          </span>
                        )}
                      </div>
                      {item.limitations.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-[13px] text-slate-600">
                          {item.limitations.map((limitation, index) => (
                            <li key={index}>{limitation}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          <Section
            label="Document details"
            description="File facts and the text layer behind this document."
          >
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-slate-500">Size</dt>
                <dd className="tabular-nums text-slate-900">{formatBytes(doc.value.sizeBytes)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Uploaded</dt>
                <dd className="tabular-nums text-slate-900">{formatDate(doc.value.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Pages</dt>
                <dd className="tabular-nums text-slate-900">{doc.value.pageCount ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Text extraction</dt>
                <dd className="text-slate-900">
                  {EXTRACTION_STATUS_LABELS[doc.value.extractionStatus]}
                </dd>
              </div>
            </dl>
            {doc.value.extractionStatus === "failed" && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {extractionErrorMessage(doc.value.extractionError)}
              </p>
            )}
            <div className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-900">Extracted text</p>
                <Button size="sm" onClick={toggleText} aria-expanded={textOpen}>
                  {textOpen ? "Hide text" : "Show text"}
                </Button>
              </div>
              {textOpen && (
                <div className="mt-2">
                  {(docText === null || docText.status === "loading") && (
                    <LoadingLine>Loading extracted text…</LoadingLine>
                  )}
                  {docText !== null && docText.status === "error" && (
                    <ErrorBlock message={docText.message} />
                  )}
                  {docText !== null &&
                    docText.status === "ready" &&
                    (docText.value.extractedText !== undefined ? (
                      <ExtractedText text={docText.value.extractedText} />
                    ) : (
                      <p className="text-sm text-slate-600">
                        No extracted text available
                        {docText.value.extractionStatus !== "completed"
                          ? ` (extraction ${docText.value.extractionStatus.replace("_", " ")}).`
                          : "."}
                      </p>
                    ))}
                </div>
              )}
            </div>
          </Section>

          {reviewOpen && (
            <ReviewQueue
              findings={visibleFindings}
              initialId={selectedFindingId}
              heading="Review queue"
              subheading={`${visibleFindings.length} findings · ${railFilterSummary}`}
              onUpdate={onReviewChange}
              onClose={() => setReviewOpen(false)}
            />
          )}
        </>
      )}
    </main>
  );
}
