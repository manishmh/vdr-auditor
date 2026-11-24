"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import { formatBytes, formatDate } from "@/lib/format";
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
  listDocuments,
  type DocumentExtractionStatus,
  type MatterDocument,
} from "@/lib/documents";
import {
  isActiveProcessingStage,
  isStaleActiveRun,
  latestRunPerDoc,
  listProcessingRuns,
  notifyProcessingChanged,
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

const API_URL = process.env["NEXT_PUBLIC_API_URL"];
const POLL_MS = 4000;

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
        // First load: everything in parallel for speed.
        const [runsRes, analysesRes, docsRes, findingsRes, historyRes] = await Promise.allSettled([
          listProcessingRuns(apiUrl, id),
          listAnalyses(apiUrl, id),
          listDocuments(apiUrl, id),
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
      }
      if (analysesRes.status === "fulfilled") {
        setAnalyses({ status: "ready", value: analysesRes.value });
      }
      if (!heavy) {
        return;
      }
      const [docsRes, findingsRes, historyRes] = await Promise.allSettled([
        listDocuments(apiUrl, id, { fresh: true }),
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
  const visibleFindings =
    severityFilter === "all"
      ? docFindings
      : docFindings.filter((item) => item.severity === severityFilter);
  const severityCounts: Record<FindingSeverity, number> = {
    high: docFindings.filter((item) => item.severity === "high").length,
    medium: docFindings.filter((item) => item.severity === "medium").length,
    low: docFindings.filter((item) => item.severity === "low").length,
  };

  // Follow this document's run while it is active. Ticks funnel through
  // the sequenced loadAll, which refetches the heavy collections only when
  // the run actually advances. Ticks never overlap and never fire for a
  // hidden tab.
  useEffect(() => {
    if (!idsReady || API_URL === undefined || API_URL === "" || !analysisInProgress) {
      return;
    }
    const apiUrl: string = API_URL;
    const id: string = matterId;
    const targetDocId: string = docId;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      if (pollInFlight.current) {
        return;
      }
      pollInFlight.current = true;
      void loadAll(apiUrl, id, targetDocId, true).finally(() => {
        pollInFlight.current = false;
      });
    };
    const timer = setInterval(tick, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [matterId, docId, idsReady, analysisInProgress, loadAll]);

  const ready = API_URL !== undefined && API_URL !== "" && idsReady;

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
    }
  };

  const failedAnalyses = docAnalyses.filter((item) => item.status === "failed");
  const limitedAnalyses = docAnalyses.filter((item) => item.status === "limited");
  const completedAnalyses = docAnalyses.filter((item) => item.status === "completed");
  const stepIndex = stepIndexFor(run);
  const progressTotal = runningAnalysis?.sectionsTotal ?? 0;
  const progressDone = runningAnalysis?.sectionsAnalyzed ?? 0;
  const showProgressBar =
    runActive && run?.stage !== "queued" && run?.stage !== "extracting" && progressTotal > 0;
  const deleteBlocked = runActive && !runStale;
  const showRetry = run?.stage === "failed" || runStale;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
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
                <Badge tone={EXTRACTION_TONE[doc.value.extractionStatus]}>
                  {EXTRACTION_STATUS_LABELS[doc.value.extractionStatus]}
                </Badge>
              ) : (
                <Badge tone={PROCESSING_TONE[run.stage]}>
                  {PROCESSING_STAGE_LABELS[run.stage]}
                </Badge>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={downloading} onClick={() => void onDownload()}>
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

          <Section
            label="Findings"
            description="Due-diligence issues in this document, each linked to its evidence."
            action={
              docFindings.length > 0 ? (
                <div className="flex items-center gap-1 text-[13px]" role="group" aria-label="Filter by severity">
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
              ) : undefined
            }
          >
            {(analyses.status === "loading" || findings.status === "loading") && (
              <LoadingLine>Loading findings…</LoadingLine>
            )}
            {(analyses.status === "error" || findings.status === "error") && (
              <ErrorBlock
                message={
                  analyses.status === "error" ? analyses.message : "Couldn't load findings. Please try again."
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
                <div className="space-y-8">
                  {analysisInProgress && (
                    <LoadingLine>
                      Analysis in progress… verified findings appear below as sections complete.
                    </LoadingLine>
                  )}
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
                      title="No findings at this severity"
                      body="Try another severity filter to see the rest."
                    />
                  ) : (
                    <FindingGroups
                      findings={visibleFindings}
                      showFilename={false}
                      onReviewChange={(finding, reviewStatus) =>
                        void onReviewChange(finding, reviewStatus)
                      }
                    />
                  )}
                  <p className="text-[13px] text-slate-500">
                    Findings are issue-spotting results for human review, not legal advice.
                  </p>
                </div>
              ))}
            {findingsError !== null && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {findingsError}
              </p>
            )}
          </Section>

          {history.length > 0 && (
            <Section
              label="Analysis history"
              description="Every analysis run for this document, newest first."
            >
              <ul className="space-y-2">
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
            {doc.value.extractedText !== undefined && (
              <details className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
                <summary className="cursor-pointer text-sm font-medium text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800">
                  Extracted text
                </summary>
                <div className="mt-2">
                  <ExtractedText text={doc.value.extractedText} />
                </div>
              </details>
            )}
          </Section>
        </>
      )}
    </main>
  );
}
