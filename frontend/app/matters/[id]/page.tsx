"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FINDING_CATEGORY_ORDER,
  REVIEW_STATUS_LABELS,
  SEVERITY_LABELS,
  listAnalyses,
  listFindings,
  updateFindingReview,
  type DocAnalysis,
  type Finding,
  type FindingSeverity,
  type ReviewStatus,
} from "@/lib/analyses";
import { formatBytes, formatDate } from "@/lib/format";
import {
  EMPTY_FINDING_FILTERS,
  applyFindingFilters,
  countOpenBySeverity,
  describeFindingFilters,
  isFiltered,
  isReviewedFinding,
  reviewCompletion,
  selectCoveredDocIds,
  type FindingFilters,
} from "@/lib/findingsView";
import {
  APP_CONFIG_ERROR_MESSAGE,
  deleteMatter,
  getMatter,
  MATTER_STATUS_LABELS,
  type Matter,
  type MatterStatus,
} from "@/lib/matters";
import {
  EXTRACTION_STATUS_LABELS,
  deleteDocument,
  downloadDocument,
  extractionErrorMessage,
  isAwaitingUpload,
  listDocuments,
  uploadDocument,
  validatePdfFile,
  type DocumentExtractionStatus,
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
  Toast,
  type BadgeTone,
} from "../../components/ui";
import { FindingGroups, FindingsEmpty } from "../../components/findings";
import ReviewQueue from "../../components/ReviewQueue";
import { useNavBusy } from "../../components/useNavBusy";

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
  /** Retained so a failed upload can retry without reselecting the file. */
  file: File;
  phase: "uploading" | "done" | "error";
  progress: number;
  message: string | null;
}

interface CompletionNotice {
  key: number;
  docId: string;
  filename: string;
  ok: boolean;
}

const NOTICE_REDIRECT_MS = 4000;

const MATTER_TONE: Record<MatterStatus, BadgeTone> = {
  active: "success",
  on_hold: "warning",
  completed: "neutral",
};

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

const MATTER_POLL_MS = 4000;
/** Backoff ceiling while runs sit unchanged; analysis takes minutes. */
const MATTER_POLL_MAX_MS = 15000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Cheap fingerprint of the visible processing runs. Every server-side write
 * to documents, analyses, or findings happens inside a driver stage
 * transition, which always bumps a run's stage or updatedAt — so a stable
 * signature means the heavy collections cannot have changed.
 */
function runsSignature(runs: ProcessingRunSummary[]): string {
  return runs
    .map((run) => `${run.id}:${run.stage}:${run.updatedAt}`)
    .sort()
    .join("|");
}

function SummaryCard({
  label,
  value,
  sub,
  tone,
  href,
  onSelect,
}: {
  label: string;
  value: string;
  sub: string;
  tone: BadgeTone;
  href?: string;
  onSelect?: () => void;
}) {
  const toneBar: Record<BadgeTone, string> = {
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-red-500",
    neutral: "bg-slate-300",
    info: "bg-blue-800",
  };
  const body = (
    <>
      <span aria-hidden="true" className={`absolute top-0 left-0 h-full w-1 ${toneBar[tone]}`} />
      <span className="block text-2xl font-semibold tracking-tight tabular-nums text-slate-900">
        {value}
      </span>
      <span className="mt-0.5 block text-sm font-medium text-slate-700">{label}</span>
      <span className="mt-0.5 block text-[13px] text-slate-500">{sub}</span>
    </>
  );
  const className =
    "relative block rounded-lg border border-slate-200 bg-white px-4 py-3 pl-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800";
  if (href === undefined) {
    return <div className={className}>{body}</div>;
  }
  return (
    <a
      href={href}
      onClick={onSelect}
      className={`${className} transition-colors hover:border-slate-300 hover:bg-slate-50`}
    >
      {body}
    </a>
  );
}

export default function MatterDetailPage() {
  const params = useParams();
  const router = useRouter();
  const rawId = params?.id;
  const matterId = typeof rawId === "string" ? rawId : "";

  const [matter, setMatter] = useState<LoadState<Matter>>(() =>
    matterId === "" || API_URL === undefined || API_URL === ""
      ? {
          status: "error",
          message:
            matterId === ""
              ? "We couldn't find that matter."
              : APP_CONFIG_ERROR_MESSAGE,
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
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ProcessingRunSummary[]>([]);
  const [analyses, setAnalyses] = useState<LoadState<DocAnalysis[]>>({
    status: "loading",
  });
  const [findings, setFindings] = useState<LoadState<Finding[]>>({
    status: "loading",
  });
  const [confirmDeleteMatter, setConfirmDeleteMatter] = useState(false);
  const [deletingMatter, setDeletingMatter] = useState(false);
  const [matterError, setMatterError] = useState<string | null>(null);
  const [queueFilters, setQueueFilters] = useState<FindingFilters>(EMPTY_FINDING_FILTERS);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  // Guards the background poll: one refresh in flight at most, and the
  // last-seen runs signature so unchanged state never refetches the heavy
  // documents payload (full extracted text, hundreds of kB per fetch).
  const pollInFlight = useRef(false);
  const lastRunsSignature = useRef("");
  const [notice, setNotice] = useState<CompletionNotice | null>(null);
  // Documents uploaded in this session, watched for completion so the page
  // can announce and open their results. Older documents never trigger it.
  const watchIdsRef = useRef(new Map<string, string>());
  // Monotonic read generation: every loadAll stamps its fetches, and only
  // the newest generation may apply state. A slow earlier read can no longer
  // overwrite fresher state (e.g. an empty list landing after an upload).
  const loadSeq = useRef(0);
  const lastAppliedRuns = useRef<ProcessingRunSummary[]>([]);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fresh route, fresh tracking: never compare or notify across matters.
  useEffect(() => {
    watchIdsRef.current.clear();
    lastAppliedRuns.current = [];
    lastRunsSignature.current = "";
  }, [matterId]);

  const clearRedirect = useCallback(() => {
    if (redirectTimer.current !== null) {
      clearTimeout(redirectTimer.current);
      redirectTimer.current = null;
    }
  }, []);

  useEffect(() => () => clearRedirect(), [clearRedirect]);

  const dismissNotice = useCallback(() => {
    clearRedirect();
    setNotice(null);
  }, [clearRedirect]);
  const { navBusy, guardNav } = useNavBusy();
  const navClass = (base: string): string =>
    navBusy ? `${base} pointer-events-none opacity-60` : base;

  /**
   * Refresh runs, analyses, documents, and findings. Reads are sequenced:
   * only the newest loadAll may apply state, so overlapping reads can never
   * regress the page (a slow pre-upload response landing after the upload).
   * Silent refreshes keep the last known state on transient failure so
   * background polling never flickers the page into an error state.
   */
  const loadAll = useCallback(
    async (apiUrl: string, id: string, silent: boolean): Promise<void> => {
      const seq = ++loadSeq.current;
      const live = (): boolean => seq === loadSeq.current;
      if (!silent) {
        setDocs({ status: "loading" });
        setAnalyses({ status: "loading" });
        setFindings({ status: "loading" });
      }
      const applyRuns = (all: ProcessingRunSummary[]): void => {
        const latest = latestRunPerDoc(all);
        for (const [docId, filename] of watchIdsRef.current) {
          const was = lastAppliedRuns.current.find((item) => item.docId === docId);
          const now = latest.find((item) => item.docId === docId);
          // Completion = active before, terminal now. First sight of a
          // terminal run also counts: watched ids are session uploads that
          // necessarily went through active (a fast backend may finish
          // before any poll observes the middle).
          const completed =
            now !== undefined &&
            !isActiveProcessingStage(now.stage) &&
            (was === undefined || isActiveProcessingStage(was.stage));
          if (!completed) {
            if (was !== undefined && now === undefined) {
              watchIdsRef.current.delete(docId);
            }
            continue;
          }
          watchIdsRef.current.delete(docId);
          const ok = now.stage === "completed" || now.stage === "completed_with_limits";
          clearRedirect();
          setNotice({ key: Date.now(), docId, filename, ok });
          if (ok) {
            redirectTimer.current = setTimeout(() => {
              redirectTimer.current = null;
              if (typeof document === "undefined" || !document.hidden) {
                router.push(`/matters/${id}/docs/${docId}`);
              }
            }, NOTICE_REDIRECT_MS);
          }
        }
        lastAppliedRuns.current = latest;
        lastRunsSignature.current = runsSignature(latest);
        setRuns(latest);
        // Let the global indicator reuse this fetch instead of polling the
        // same runs itself a moment later.
        notifyProcessingRuns(latest);
      };
      const applyDocs = (
        result: PromiseSettledResult<MatterDocument[]>,
      ): void => {
        if (result.status === "fulfilled") {
          setDocs({ status: "ready", value: result.value });
        } else if (!silent) {
          setDocs({
            status: "error",
            message: errorMessage(result.reason, "Couldn't load documents. Please try again."),
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
        // without extracted text; text loads on demand on the document page.
        const [runsRes, analysesRes, docsRes, findingsRes] = await Promise.allSettled([
          listProcessingRuns(apiUrl, id),
          listAnalyses(apiUrl, id),
          listDocuments(apiUrl, id, { includeText: false }),
          listFindings(apiUrl, id),
        ]);
        if (!live()) {
          return;
        }
        if (runsRes.status === "fulfilled") {
          applyRuns(runsRes.value);
        } else {
          setRuns([]);
        }
        applyAnalyses(analysesRes);
        applyDocs(docsRes);
        applyFindings(findingsRes);
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
        heavy =
          runsSignature(latestRunPerDoc(runsRes.value)) !== lastRunsSignature.current;
        applyRuns(runsRes.value);
      }
      if (analysesRes.status === "fulfilled") {
        setAnalyses({ status: "ready", value: analysesRes.value });
      }
      if (!heavy) {
        return;
      }
      const [docsRes, findingsRes] = await Promise.allSettled([
        listDocuments(apiUrl, id, { fresh: true, includeText: false }),
        listFindings(apiUrl, id),
      ]);
      if (!live()) {
        return;
      }
      if (docsRes.status === "fulfilled") {
        setDocs({ status: "ready", value: docsRes.value });
      }
      if (findingsRes.status === "fulfilled") {
        setFindings({ status: "ready", value: findingsRes.value });
      }
    },
    [clearRedirect, router],
  );

  useEffect(() => {
    if (matterId === "" || API_URL === undefined || API_URL === "") {
      return;
    }
    const apiUrl: string = API_URL;
    const id: string = matterId;
    getMatter(apiUrl, id).then(
      (value) => {
        setMatter({ status: "ready", value });
        void loadAll(apiUrl, id, false);
      },
      (err: unknown) => {
        const message = errorMessage(err, "Couldn't load this matter. Please try again.");
        setMatter({ status: "error", message });
        setDocs({ status: "error", message });
        setAnalyses({ status: "error", message });
        setFindings({ status: "error", message });
      },
    );
  }, [matterId, loadAll]);

  const hasActiveRuns = runs.some((run) => isActiveProcessingStage(run.stage));
  // Uploads acknowledge before their bytes land; keep polling until the
  // bytes arrive (a processing run then appears) or the upload fails.
  const awaitingUpload =
    docs.status === "ready" ? docs.value.some(isAwaitingUpload) : false;

  // Follow persisted processing state while anything runs here; the runs
  // themselves live on the server, so refresh and navigation are safe. Ticks
  // funnel through the sequenced loadAll, which refetches the heavy
  // collections only when a run actually changed. Ticks never overlap, never
  // fire for a hidden tab, and back off while nothing changes: analysis runs
  // for minutes per document, so a fixed 4s cadence would fire hundreds of
  // requests per document for no new information.
  useEffect(() => {
    if (
      matterId === "" ||
      API_URL === undefined ||
      API_URL === "" ||
      (!hasActiveRuns && !awaitingUpload)
    ) {
      return;
    }
    const apiUrl: string = API_URL;
    const id: string = matterId;
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
        schedule(MATTER_POLL_MS);
        return;
      }
      if (pollInFlight.current) {
        schedule(MATTER_POLL_MS);
        return;
      }
      const before = lastRunsSignature.current;
      pollInFlight.current = true;
      void loadAll(apiUrl, id, true).finally(() => {
        pollInFlight.current = false;
        if (stopped) {
          return;
        }
        quietTicks = lastRunsSignature.current === before ? quietTicks + 1 : 0;
        schedule(Math.min(MATTER_POLL_MS * 2 ** quietTicks, MATTER_POLL_MAX_MS));
      });
    };
    schedule(MATTER_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [matterId, hasActiveRuns, awaitingUpload, loadAll]);

  const reloadDocs = (apiUrl: string, id: string) => {
    void loadAll(apiUrl, id, false);
  };

  const patchUpload = (key: number, patch: Partial<UploadState>) => {
    setUploads((prev) =>
      prev.map((upload) =>
        upload.key === key ? { ...upload, ...patch } : upload,
      ),
    );
  };

  const seedDocs = (seeded: MatterDocument[]): void => {
    setDocs((prev) => {
      if (prev.status !== "ready") {
        return prev;
      }
      const ids = new Set(seeded.map((doc) => doc.id));
      return {
        status: "ready",
        value: [...seeded, ...prev.value.filter((doc) => !ids.has(doc.id))],
      };
    });
  };

  const seedRuns = (seeded: ProcessingRunSummary[]): void => {
    const merged = latestRunPerDoc([...seeded, ...lastAppliedRuns.current]);
    lastAppliedRuns.current = merged;
    lastRunsSignature.current = runsSignature(merged);
    setRuns(merged);
  };

  const runUpload = async (
    apiUrl: string,
    id: string,
    file: File,
    key: number,
  ): Promise<void> => {
    const precheck = validatePdfFile(file, MAX_PDF_BYTES);
    if (precheck !== undefined) {
      patchUpload(key, { phase: "error", message: precheck });
      return;
    }
    try {
      patchUpload(key, { phase: "uploading", progress: 0, message: null });
      const uploaded = await uploadDocument(apiUrl, id, file, (progress) => {
        patchUpload(key, { progress });
      });
      patchUpload(key, { phase: "done", progress: 100 });
      // Upload schedules extraction + analysis on the server. Seed state
      // from the response itself so the row and polling start correctly
      // even before the follow-up fetch lands; then confirm from the server
      // and wake the global indicator. Watch for the completion notice.
      watchIdsRef.current.set(uploaded.document.id, uploaded.document.filename);
      seedDocs([uploaded.document]);
      if (uploaded.processing !== null) {
        seedRuns([uploaded.processing]);
      }
      void loadAll(apiUrl, id, true);
      notifyProcessingChanged();
    } catch (err: unknown) {
      patchUpload(key, {
        phase: "error",
        message: errorMessage(err, "The upload failed. Please try again."),
      });
    }
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
      file,
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
      // Uploads stay on the matter page with live row progress; when each
      // analysis finishes, a notification offers its results.
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
      setActionError(errorMessage(err, "Couldn't download this file. Please try again."));
    } finally {
      setDownloadingId(null);
    }
  };

  const onRetry = async (doc: MatterDocument) => {
    if (API_URL === undefined || API_URL === "" || matterId === "") {
      return;
    }
    setRetryingId(doc.id);
    setActionError(null);
    try {
      const run = await retryProcessing(API_URL, matterId, doc.id);
      if (run !== null) {
        seedRuns([run]);
        watchIdsRef.current.set(doc.id, doc.filename);
      }
      void loadAll(API_URL, matterId, true);
      notifyProcessingChanged();
    } catch (err: unknown) {
      setActionError(errorMessage(err, "Couldn't restart processing. Please try again."));
      void loadAll(API_URL, matterId, true);
    } finally {
      setRetryingId(null);
    }
  };

  const runForDoc = (docId: string): ProcessingRunSummary | undefined =>
    runs.find((run) => run.docId === docId);

  const analysisForDoc = (docId: string): DocAnalysis | undefined =>
    analyses.status === "ready"
      ? analyses.value.find((item) => item.docId === docId)
      : undefined;

  const findingsForDoc = (docId: string): Finding[] =>
    findings.status === "ready"
      ? findings.value.filter((item) => item.docId === docId)
      : [];

  const findingsSummary = (items: Finding[]): string | null => {
    if (items.length === 0) {
      return null;
    }
    const high = items.filter((item) => item.severity === "high").length;
    const noun = items.length === 1 ? "finding" : "findings";
    return high > 0 ? `${items.length} ${noun} · ${high} high` : `${items.length} ${noun}`;
  };

  const reviewProgressSummary = (items: Finding[]): string | null => {
    if (items.length === 0) {
      return null;
    }
    const reviewed = items.filter(isReviewedFinding).length;
    return `${reviewed} of ${items.length} reviewed`;
  };

  const onReviewChange = async (finding: Finding, reviewStatus: ReviewStatus) => {
    if (API_URL === undefined || API_URL === "" || matterId === "") {
      return;
    }
    setQueueError(null);
    try {
      const updated = await updateFindingReview(API_URL, matterId, finding.id, reviewStatus);
      // Single copy: every card, row, and count below derives from this
      // state, so all of them refresh together.
      setFindings((prev) =>
        prev.status === "ready"
          ? {
              status: "ready",
              value: prev.value.map((item) => (item.id === updated.id ? updated : item)),
            }
          : prev,
      );
    } catch (err: unknown) {
      setQueueError(errorMessage(err, "Couldn't save that change. Please try again."));
      throw err instanceof Error ? err : new Error("Couldn't save that change.");
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
      watchIdsRef.current.delete(doc.id);
      // The server already confirmed the cascade, so drop the document
      // from every local collection at once: the silent refresh below
      // skips refetching when the runs signature is unchanged, which used
      // to leave the deleted row (and its findings) lingering on screen.
      const remaining = <T extends { docId?: string; id: string }>(items: T[]): T[] =>
        items.filter((item) => item.id !== doc.id && item.docId !== doc.id);
      setDocs((prev) =>
        prev.status === "ready"
          ? { status: "ready", value: prev.value.filter((item) => item.id !== doc.id) }
          : prev,
      );
      setFindings((prev) =>
        prev.status === "ready" ? { status: "ready", value: remaining(prev.value) } : prev,
      );
      setAnalyses((prev) =>
        prev.status === "ready" ? { status: "ready", value: remaining(prev.value) } : prev,
      );
      setRuns((prev) => prev.filter((run) => run.docId !== doc.id));
      void loadAll(API_URL, matterId, true);
      notifyProcessingChanged();
    } catch (err: unknown) {
      setActionError(errorMessage(err, "Couldn't delete this document. Please try again."));
      void loadAll(API_URL, matterId, true);
    } finally {
      setDeletingId(null);
    }
  };

  const onDeleteMatter = async () => {
    if (API_URL === undefined || API_URL === "" || matterId === "") {
      return;
    }
    setDeletingMatter(true);
    setMatterError(null);
    try {
      await deleteMatter(API_URL, matterId);
      notifyProcessingChanged();
      router.push("/");
    } catch (err: unknown) {
      setMatterError(errorMessage(err, "Couldn't delete this matter. Please try again."));
    } finally {
      setDeletingMatter(false);
      setConfirmDeleteMatter(false);
    }
  };

  const uploadReady = API_URL !== undefined && API_URL !== "" && matterId !== "";

  const readyFindings = findings.status === "ready" ? findings.value : [];
  const readyDocs = docs.status === "ready" ? docs.value : [];
  const readyAnalyses = analyses.status === "ready" ? analyses.value : [];
  const openCounts = countOpenBySeverity(readyFindings);
  const completion = reviewCompletion(readyFindings);
  const queueFindings = applyFindingFilters(readyFindings, queueFilters);
  const docNameById = new Map(readyDocs.map((doc) => [doc.id, doc.filename]));
  const filterSummary = describeFindingFilters(queueFilters, {
    severityLabel: (severity) => SEVERITY_LABELS[severity],
    categoryLabel: (category) =>
      FINDING_CATEGORY_ORDER.find((group) => group.id === category)?.label ?? category,
    statusLabel: (status) => REVIEW_STATUS_LABELS[status],
    docName: (docId) => docNameById.get(docId),
  });
  // Covered = a run with reviewable output exists. Failed, running, and
  // never-analyzed documents never count as clean — but a newer failed
  // attempt does not uncover a document whose earlier results are current.
  const coveredDocIds = selectCoveredDocIds(
    readyAnalyses,
    readyDocs.map((doc) => doc.id),
  );
  const analyzedDocs = readyDocs.filter((doc) => coveredDocIds.has(doc.id)).length;
  const failedDocs = readyDocs.filter((doc) => {
    const run = runForDoc(doc.id);
    return run?.stage === "failed";
  }).length;
  const processingDocs = runs.filter((run) => isActiveProcessingStage(run.stage)).length;
  const presetQueueFilter = (preset: Partial<FindingFilters>): void => {
    setQueueFilters({ ...EMPTY_FINDING_FILTERS, ...preset });
  };

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
          <li aria-current="page" className="truncate text-slate-600">
            {matter.status === "ready" ? matter.value.title : "…"}
          </li>
        </ol>
      </nav>

      {matter.status === "loading" && (
        <div className="mt-4">
          <LoadingLine>Loading matter…</LoadingLine>
        </div>
      )}
      {matter.status === "error" && (
        <div className="mt-4">
          <ErrorBlock message={matter.message} />
        </div>
      )}
      {matter.status === "ready" && (
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {matter.value.title}
            </h1>
            {matter.value.description !== undefined && matter.value.description !== "" ? (
              <p className="mt-1 max-w-3xl text-sm text-slate-600">{matter.value.description}</p>
            ) : (
              <p className="mt-1 text-sm text-slate-500">No description</p>
            )}
            <p className="mt-2 text-[13px] tabular-nums text-slate-500">
              Created {formatDate(matter.value.createdAt)} · Updated{" "}
              {formatDate(matter.value.updatedAt)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge tone={MATTER_TONE[matter.value.status]}>
              {MATTER_STATUS_LABELS[matter.value.status]}
            </Badge>
            {confirmDeleteMatter ? (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={deletingMatter}
                  onClick={() => void onDeleteMatter()}
                >
                  {deletingMatter ? "Deleting…" : "Confirm delete"}
                </Button>
                <Button size="sm" onClick={() => setConfirmDeleteMatter(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                disabled={hasActiveRuns}
                title={
                  hasActiveRuns
                    ? "Deletion is paused while documents are processing."
                    : "Delete this matter and all of its documents and findings."
                }
                onClick={() => {
                  setMatterError(null);
                  setConfirmDeleteMatter(true);
                }}
              >
                Delete matter
              </Button>
            )}
          </div>
        </div>
      )}
      {matterError !== null && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {matterError}
        </p>
      )}

      {(docs.status === "loading" || findings.status === "loading" || analyses.status === "loading") && (
        <div className="mt-6">
          <LoadingLine>Loading overview…</LoadingLine>
        </div>
      )}
      {docs.status === "ready" &&
        findings.status === "ready" &&
        analyses.status === "ready" && (
          <section aria-label="Matter overview" className="mt-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <SummaryCard
                label="High severity"
                value={String(openCounts.high)}
                sub={openCounts.high === 1 ? "open finding" : "open findings"}
                tone="danger"
                href="#findings-queue"
                onSelect={() => presetQueueFilter({ severity: "high" })}
              />
              <SummaryCard
                label="Medium severity"
                value={String(openCounts.medium)}
                sub={openCounts.medium === 1 ? "open finding" : "open findings"}
                tone="warning"
                href="#findings-queue"
                onSelect={() => presetQueueFilter({ severity: "medium" })}
              />
              <SummaryCard
                label="Low severity"
                value={String(openCounts.low)}
                sub={openCounts.low === 1 ? "open finding" : "open findings"}
                tone="neutral"
                href="#findings-queue"
                onSelect={() => presetQueueFilter({ severity: "low" })}
              />
              <SummaryCard
                label="Reviewed"
                value={completion.percent === null ? "—" : `${completion.percent}%`}
                sub={
                  completion.total === 0
                    ? "No findings yet"
                    : `${completion.reviewed} of ${completion.total} reviewed`
                }
                tone={completion.percent === 100 ? "success" : "info"}
                href={completion.total === 0 ? undefined : "#findings-queue"}
                onSelect={() => presetQueueFilter({ reviewStatus: "open" })}
              />
              <SummaryCard
                label="Documents analyzed"
                value={`${analyzedDocs}/${readyDocs.length}`}
                sub={
                  processingDocs > 0
                    ? `${processingDocs} processing`
                    : failedDocs > 0
                      ? `${failedDocs} failed`
                      : readyDocs.length === 0
                        ? "No documents yet"
                        : "All covered"
                }
                tone={
                  readyDocs.length > 0 && analyzedDocs === readyDocs.length
                    ? "success"
                    : "neutral"
                }
                href="#documents"
              />
            </div>
            {completion.total === 0 && readyDocs.length > 0 && analyzedDocs < readyDocs.length && (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
                No findings yet — {analyzedDocs} of {readyDocs.length} documents analyzed so
                far. Zero findings is not a clearance until every document is covered.
              </p>
            )}
            {completion.total === 0 &&
              readyDocs.length > 0 &&
              analyzedDocs === readyDocs.length && (
                <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
                  No issues found across {readyDocs.length}{" "}
                  {readyDocs.length === 1 ? "analyzed document" : "analyzed documents"}.
                </p>
              )}
          </section>
        )}

      <div id="documents" className="scroll-mt-20">
      <Section
        label="Documents"
        description={`PDF files only, up to ${MAX_PDF_MB} MB each. Text extraction and analysis start automatically after upload. Open a document to follow its progress and review its findings.`}
        action={
          uploadReady ? (
            <label className="inline-block cursor-pointer rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-800">
              Upload PDFs
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                onChange={onFilesSelected}
                aria-label="Choose PDF files to upload"
                className="sr-only"
              />
            </label>
          ) : undefined
        }
      >
        {uploads.length > 0 && (
          <ul className="mb-4 space-y-2" aria-label="Upload progress">
            {uploads.map((upload) => (
              <li
                key={upload.key}
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                <p className="truncate font-medium text-slate-900">{upload.filename}</p>
                <p className="mt-0.5 text-slate-600">
                  {upload.phase === "uploading"
                    ? `Uploading… ${upload.progress}%`
                    : upload.phase === "done"
                      ? "Done"
                      : "Failed"}
                </p>
                {upload.phase === "uploading" && (
                  <div
                    className="mt-1 h-1.5 w-full rounded bg-slate-200"
                    role="progressbar"
                    aria-valuenow={upload.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-1.5 rounded bg-slate-900"
                      style={{ width: `${upload.progress}%` }}
                    />
                  </div>
                )}
                {upload.phase === "error" && upload.message !== null && (
                  <p className="mt-0.5 text-red-700" role="alert">
                    {upload.message}
                  </p>
                )}
                {upload.phase === "error" && uploadReady && (
                  <button
                    type="button"
                    onClick={() => void runUpload(API_URL, matterId, upload.file, upload.key)}
                    className="mt-1 rounded text-[13px] font-medium text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                  >
                    Retry upload
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {docs.status === "loading" && <LoadingLine>Loading documents…</LoadingLine>}
        {docs.status === "error" && (
          <ErrorBlock
            message={docs.message}
            onRetry={uploadReady ? () => reloadDocs(API_URL, matterId) : undefined}
          />
        )}
        {docs.status === "ready" &&
          (docs.value.length === 0 ? (
            <EmptyState
              title="No documents yet"
              body="Upload the deal PDFs under review. Text is extracted per document so findings can cite exact evidence."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Document
                    </th>
                    <th scope="col" className="w-24 px-4 py-2.5 text-right font-medium">
                      Size
                    </th>
                    <th scope="col" className="w-32 px-4 py-2.5 font-medium">
                      Uploaded
                    </th>
                    <th scope="col" className="w-44 px-4 py-2.5 font-medium">
                      Status
                    </th>
                    <th scope="col" className="w-56 px-4 py-2.5 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {docs.value.map((doc) => {
                    const run = runForDoc(doc.id);
                    const active = run !== undefined && isActiveProcessingStage(run.stage);
                    // A stale active run is abandoned: the backend resumes it
                    // on retry (or the recovery sweep picks it up), and allows
                    // deletion since no live driver owns it anymore.
                    const stale = run !== undefined && isStaleActiveRun(run);
                    const deleteBlocked = active && !stale;
                    const analysis = analysisForDoc(doc.id);
                    const summary = findingsSummary(findingsForDoc(doc.id));
                    const showRowProgress =
                      active &&
                      (run?.stage === "analyzing" || run?.stage === "validating") &&
                      analysis?.status === "running" &&
                      (analysis.sectionsTotal ?? 0) > 0;
                    return (
                      <tr
                        key={doc.id}
                        id={`doc-${doc.id}`}
                        aria-busy={deletingId === doc.id}
                        className={`scroll-mt-20 align-top hover:bg-slate-50 ${
                          deletingId === doc.id
                            ? "pointer-events-none opacity-60 blur-[2px]"
                            : ""
                        }`}
                      >
                        <td className="max-w-0 px-4 py-3">
                          <p className="truncate font-medium text-slate-900" title={doc.filename}>
                            <Link
                              href={`/matters/${matterId}/docs/${doc.id}`}
                              onClick={guardNav}
                              aria-disabled={navBusy}
                              className={navClass(
                                "rounded text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800",
                              )}
                            >
                              {doc.filename}
                            </Link>
                          </p>
                          {summary !== null ? (
                            <p className="mt-0.5 text-[13px]">
                              <Link
                                href={`/matters/${matterId}/docs/${doc.id}`}
                                onClick={guardNav}
                                aria-disabled={navBusy}
                                className={navClass(
                                  "rounded text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800",
                                )}
                              >
                                {summary}
                              </Link>
                              {reviewProgressSummary(findingsForDoc(doc.id)) !== null && (
                                <span className="text-slate-500">
                                  {" · "}
                                  {reviewProgressSummary(findingsForDoc(doc.id))}
                                </span>
                              )}
                            </p>
                          ) : (
                            run === undefined &&
                            (isAwaitingUpload(doc) ? (
                              <p className="mt-0.5 text-[13px] text-slate-500" role="status">
                                Uploading…
                              </p>
                            ) : (
                              <p className="mt-0.5 text-[13px] text-slate-500">Not analyzed yet</p>
                            ))
                          )}
                          {run?.stage === "failed" ? (
                            <p className="mt-0.5 truncate text-[13px] text-red-700" role="alert">
                              {processingErrorMessage(run.error)}
                            </p>
                          ) : (
                            <>
                              {doc.extractionStatus === "failed" && (
                                <p
                                  className="mt-0.5 truncate text-[13px] text-red-700"
                                  role="alert"
                                >
                                  {extractionErrorMessage(doc.extractionError)}
                                </p>
                              )}
                              {doc.extractionStatus === "no_text" && (
                                <p className="mt-0.5 text-[13px] text-slate-600">
                                  No text layer
                                  {doc.pageCount !== undefined ? ` · ${doc.pageCount} pages` : ""}
                                </p>
                              )}
                            </>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-[13px] tabular-nums text-slate-600">
                          {formatBytes(doc.sizeBytes)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-slate-600">
                          {formatDate(doc.createdAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {run === undefined ? (
                            isAwaitingUpload(doc) ? (
                              <>
                                <Badge tone="info">Uploading</Badge>
                                <p className="mt-1 text-xs tabular-nums text-slate-500">
                                  Saving file…
                                </p>
                              </>
                            ) : (
                              <>
                                <Badge tone={EXTRACTION_TONE[doc.extractionStatus]}>
                                  {EXTRACTION_STATUS_LABELS[doc.extractionStatus]}
                                </Badge>
                              {doc.extractionStatus === "completed" &&
                                doc.pageCount !== undefined && (
                                  <p className="mt-1 text-xs tabular-nums text-slate-500">
                                    {doc.pageCount} {doc.pageCount === 1 ? "page" : "pages"}
                                  </p>
                                )}
                              </>
                            )
                          ) : (
                            <>
                              <Badge tone={PROCESSING_TONE[run.stage]}>
                                {PROCESSING_STAGE_LABELS[run.stage]}
                              </Badge>
                              {(run.stage === "completed" ||
                                run.stage === "completed_with_limits") &&
                                doc.pageCount !== undefined && (
                                  <p className="mt-1 text-xs tabular-nums text-slate-500">
                                    {doc.pageCount} {doc.pageCount === 1 ? "page" : "pages"}
                                  </p>
                                )}
                              {showRowProgress && analysis?.sectionsTotal !== undefined && (
                                <div className="mt-1.5 w-36">
                                  <ProgressBar
                                    value={analysis.sectionsAnalyzed ?? 0}
                                    max={analysis.sectionsTotal}
                                    label={`Analyzed ${analysis.sectionsAnalyzed ?? 0} of ${analysis.sectionsTotal} sections`}
                                  />
                                  <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                                    Section {analysis.sectionsAnalyzed ?? 0} of{" "}
                                    {analysis.sectionsTotal}
                                  </p>
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right">
                          <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[13px] font-medium">
                            <Link
                              href={`/matters/${matterId}/docs/${doc.id}`}
                              onClick={guardNav}
                              aria-disabled={navBusy}
                              className={navClass(
                                "rounded text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800",
                              )}
                            >
                              Open
                            </Link>
                            <button
                              type="button"
                              disabled={downloadingId === doc.id || isAwaitingUpload(doc)}
                              title={
                                isAwaitingUpload(doc)
                                  ? "Available once the file finishes uploading."
                                  : undefined
                              }
                              onClick={() => void onDownload(doc)}
                              className="rounded text-blue-800 hover:text-blue-900 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                            >
                              {downloadingId === doc.id ? "Preparing…" : "Download"}
                            </button>
                            {(run?.stage === "failed" || stale) && (
                              <button
                                type="button"
                                disabled={retryingId === doc.id}
                                onClick={() => void onRetry(doc)}
                                className="rounded text-blue-800 hover:text-blue-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                              >
                                {retryingId === doc.id ? "Retrying…" : "Retry"}
                              </button>
                            )}
                            {confirmDeleteId === doc.id ? (
                              <>
                                <button
                                  type="button"
                                  disabled={deletingId === doc.id}
                                  onClick={() => void onDelete(doc)}
                                  className="rounded font-semibold text-red-700 hover:text-red-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                                >
                                  {deletingId === doc.id ? "Deleting…" : "Confirm"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="rounded text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={deleteBlocked}
                                title={
                                  deleteBlocked
                                    ? "Deletion is paused while this document is processing."
                                    : undefined
                                }
                                onClick={() => {
                                  setActionError(null);
                                  setConfirmDeleteId(doc.id);
                                }}
                                className="rounded text-slate-600 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                          {deleteBlocked && (
                            <p className="mt-1 text-xs text-slate-500">
                              Deletion is paused while processing.
                            </p>
                          )}
                          {stale && (
                            <p className="mt-1 text-xs text-amber-700">
                              Taking longer than usual — retry resumes it.
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        {actionError !== null && (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {actionError}
          </p>
        )}
      </Section>
      </div>

      <div id="findings-queue" className="scroll-mt-20">
        <Section
          label="Findings queue"
          description="Every current finding across this matter's documents. Filters combine; select a finding's document to open it at the cited evidence."
          action={
            queueFindings.length > 0 ? (
              <Button size="sm" variant="primary" onClick={() => setReviewOpen(true)}>
                Start review
              </Button>
            ) : undefined
          }
        >
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div>
              <label
                htmlFor="queue-severity"
                className="block text-[13px] font-medium text-slate-700"
              >
                Severity
              </label>
              <select
                id="queue-severity"
                value={queueFilters.severity}
                onChange={(event) =>
                  setQueueFilters((prev) => ({
                    ...prev,
                    severity: event.target.value as FindingFilters["severity"],
                  }))
                }
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
              >
                <option value="all">All severities</option>
                {(Object.keys(SEVERITY_LABELS) as FindingSeverity[]).map((severity) => (
                  <option key={severity} value={severity}>
                    {SEVERITY_LABELS[severity]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="queue-category"
                className="block text-[13px] font-medium text-slate-700"
              >
                Category
              </label>
              <select
                id="queue-category"
                value={queueFilters.category}
                onChange={(event) =>
                  setQueueFilters((prev) => ({
                    ...prev,
                    category: event.target.value as FindingFilters["category"],
                  }))
                }
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
              >
                <option value="all">All categories</option>
                {FINDING_CATEGORY_ORDER.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="queue-status"
                className="block text-[13px] font-medium text-slate-700"
              >
                Review status
              </label>
              <select
                id="queue-status"
                value={queueFilters.reviewStatus}
                onChange={(event) =>
                  setQueueFilters((prev) => ({
                    ...prev,
                    reviewStatus: event.target.value as FindingFilters["reviewStatus"],
                  }))
                }
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
              >
                <option value="all">All statuses</option>
                {(Object.keys(REVIEW_STATUS_LABELS) as ReviewStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {REVIEW_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="queue-doc" className="block text-[13px] font-medium text-slate-700">
                Document
              </label>
              <select
                id="queue-doc"
                value={queueFilters.docId}
                onChange={(event) =>
                  setQueueFilters((prev) => ({ ...prev, docId: event.target.value }))
                }
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
              >
                <option value="all">All documents</option>
                {readyDocs.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.filename}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <p className="text-sm text-slate-600" role="status">
              {queueFindings.length} of {readyFindings.length}{" "}
              {readyFindings.length === 1 ? "finding" : "findings"} · {filterSummary}
            </p>
            {isFiltered(queueFilters) && (
              <Button size="sm" onClick={() => setQueueFilters(EMPTY_FINDING_FILTERS)}>
                Clear filters
              </Button>
            )}
          </div>
          {findings.status === "loading" && <LoadingLine>Loading findings…</LoadingLine>}
          {findings.status === "error" && <ErrorBlock message={findings.message} />}
          {findings.status === "ready" &&
            (readyFindings.length === 0 ? (
              <FindingsEmpty
                input={{
                  analysisInProgress: hasActiveRuns,
                  failedCount: readyAnalyses.filter((item) => item.status === "failed").length,
                  limitedCount: readyAnalyses.filter((item) => item.status === "limited").length,
                  completedCount: readyAnalyses.filter((item) => item.status === "completed")
                    .length,
                }}
              />
            ) : queueFindings.length === 0 ? (
              <EmptyState
                title="No findings match these filters"
                body="Loosen or clear the filters to see the rest of the queue."
              />
            ) : (
              <FindingGroups
                findings={queueFindings}
                showFilename={true}
                onReviewChange={(finding, reviewStatus) => {
                  void onReviewChange(finding, reviewStatus).catch(() => undefined);
                }}
              />
            ))}
          {queueError !== null && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {queueError}
            </p>
          )}
        </Section>
      </div>

      {reviewOpen && (
        <ReviewQueue
          findings={queueFindings}
          initialId={null}
          heading="Review queue"
          subheading={`${queueFindings.length} findings · ${filterSummary}`}
          onUpdate={onReviewChange}
          onClose={() => setReviewOpen(false)}
          docHref={(finding) =>
            `/matters/${matterId}/docs/${finding.docId}?finding=${finding.id}`
          }
        />
      )}

      {notice !== null && (
        <Toast
          key={notice.key}
          tone={notice.ok ? "success" : "danger"}
          title={notice.ok ? "Analysis complete" : "Analysis couldn't finish"}
          body={
            notice.ok
              ? `${notice.filename} is ready to review.`
              : `${notice.filename} needs attention — retry from its page.`
          }
          actionLabel={notice.ok ? "View results" : "Open document"}
          onAction={() => {
            const target = notice.docId;
            dismissNotice();
            router.push(`/matters/${matterId}/docs/${target}`);
          }}
          onDismiss={dismissNotice}
        />
      )}
    </main>
  );
}
