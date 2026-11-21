"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isActiveProcessingStage,
  latestRunPerDoc,
  listProcessingRuns,
  PROCESSING_CHANGED_EVENT,
  PROCESSING_STAGE_LABELS,
  type ProcessingRunSummary,
  type ProcessingStage,
} from "@/lib/processing";
import { Badge, type BadgeTone } from "./ui";

const API_URL = process.env["NEXT_PUBLIC_API_URL"];
const ACTIVE_POLL_MS = 5000;
/** Completed runs stay visible briefly; failures stay until dismissed. */
const RECENT_TERMINAL_MS = 15 * 60 * 1000;
const DISMISS_KEY = "vdr-dismissed-runs";

const STAGE_TONE: Record<ProcessingStage, BadgeTone> = {
  queued: "neutral",
  extracting: "warning",
  analyzing: "warning",
  validating: "warning",
  completed: "success",
  completed_with_limits: "warning",
  failed: "danger",
};

function loadDismissed(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.sessionStorage.getItem(DISMISS_KEY);
    if (raw === null) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function storeDismissed(dismissed: Set<string>): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed]));
  } catch {
    // Private mode or quota: dismissal just won't survive a refresh.
  }
}

function isVisible(run: ProcessingRunSummary, dismissed: Set<string>, now: number): boolean {
  if (dismissed.has(run.id)) {
    return false;
  }
  if (isActiveProcessingStage(run.stage)) {
    return true;
  }
  if (run.stage === "failed") {
    return true;
  }
  const updated = Date.parse(run.updatedAt);
  return !Number.isNaN(updated) && now - updated < RECENT_TERMINAL_MS;
}

/**
 * Global view of server-persisted processing runs. It only reads backend
 * state: it never starts, drives, or cancels any work.
 */
export default function ProcessingIndicator() {
  const pathname = usePathname();
  const [snapshot, setSnapshot] = useState<{
    at: number;
    runs: ProcessingRunSummary[];
  } | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  // One refresh in flight at most: a refresh requested while one is running
  // (slow responses, overlapping poll ticks) runs once right after instead
  // of stacking concurrent requests.
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);

  const storeRuns = useCallback((all: ProcessingRunSummary[]) => {
    setSnapshot({ at: Date.now(), runs: latestRunPerDoc(all) });
  }, []);

  const refresh = useCallback(() => {
    if (API_URL === undefined || API_URL === "") {
      return;
    }
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    refreshInFlight.current = true;
    const runOnce = (): void => {
      refreshQueued.current = false;
      listProcessingRuns(API_URL).then(storeRuns, () => {
        // Keep the last known state; the matter page surfaces fetch errors.
      }).finally(() => {
        if (refreshQueued.current) {
          runOnce();
          return;
        }
        refreshInFlight.current = false;
      });
    };
    runOnce();
  }, [storeRuns]);

  // Refetch on mount and after every navigation (layout stays mounted).
  useEffect(() => {
    if (API_URL === undefined || API_URL === "") {
      return;
    }
    listProcessingRuns(API_URL).then(
      (all) => {
        setSnapshot({ at: Date.now(), runs: latestRunPerDoc(all) });
      },
      () => {
        // Keep the last known state; the matter page surfaces fetch errors.
      },
    );
  }, [pathname]);

  // The matter page signals upload/retry/delete so idle polling is unneeded.
  useEffect(() => {
    const onChanged = () => {
      refresh();
    };
    window.addEventListener(PROCESSING_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(PROCESSING_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);

  const hasActive =
    snapshot !== null && snapshot.runs.some((run) => isActiveProcessingStage(run.stage));

  // Poll only while something is actually running, and never for a
  // hidden tab.
  useEffect(() => {
    if (!hasActive) {
      return;
    }
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      refresh();
    }, ACTIVE_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [hasActive, refresh]);

  const dismiss = (runId: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(runId);
      storeDismissed(next);
      return next;
    });
  };

  if (API_URL === undefined || API_URL === "" || snapshot === null) {
    return null;
  }
  const visible = snapshot.runs.filter((run) => isVisible(run, dismissed, snapshot.at));
  if (visible.length === 0) {
    return null;
  }

  return (
    <aside
      aria-label="Document processing status"
      className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white shadow-lg"
    >
      <p className="border-b border-slate-200 px-4 py-2 text-sm font-semibold text-slate-900">
        Processing
      </p>
      <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto">
        {visible.map((run) => (
          <li key={run.id} className="flex items-start gap-2 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm font-medium text-slate-900"
                title={run.filename ?? "Deleted document"}
              >
                <Link
                  href={`/matters/${run.matterId}/docs/${run.docId}`}
                  className="rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                >
                  {run.filename ?? "Deleted document"}
                </Link>
              </p>
              <p
                className="mt-0.5 truncate text-xs text-slate-500"
                title={run.matterTitle ?? "Unknown matter"}
              >
                {run.matterTitle ?? "Unknown matter"}
              </p>
              <p className="mt-1">
                <Badge tone={STAGE_TONE[run.stage]}>
                  {PROCESSING_STAGE_LABELS[run.stage]}
                </Badge>
              </p>
            </div>
            {!isActiveProcessingStage(run.stage) && (
              <button
                type="button"
                onClick={() => dismiss(run.id)}
                aria-label={`Dismiss ${run.filename ?? "deleted document"}`}
                className="rounded px-1 text-base leading-none text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
