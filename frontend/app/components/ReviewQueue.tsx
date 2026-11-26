"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FINDING_CATEGORY_ORDER,
  REVIEW_STATUS_LABELS,
  SEVERITY_LABELS,
  type Finding,
  type ReviewStatus,
} from "@/lib/analyses";
import {
  isOpenFinding,
  nextEligibleId,
  orderReviewQueue,
  shouldIgnoreShortcut,
} from "@/lib/findingsView";
import { SEVERITY_TONE } from "./findings";
import { Badge, Button } from "./ui";

interface ReviewQueueProps {
  /** Filtered queue; ordering is applied here. */
  findings: Finding[];
  /** Finding to start on, when still present. */
  initialId: string | null;
  heading: string;
  /** Context line under the heading (scope, active filters). */
  subheading: string;
  /** Persist a status change; parent updates its own finding state. */
  onUpdate: (finding: Finding, reviewStatus: ReviewStatus) => Promise<void>;
  onClose: () => void;
  /** Deep link to the finding in its source document, when available. */
  docHref?: (finding: Finding) => string;
}

function categoryLabel(category: Finding["category"]): string {
  return FINDING_CATEGORY_ORDER.find((group) => group.id === category)?.label ?? category;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Couldn't save that change. Please try again.";
}

const SHORTCUTS: Array<{ key: string; action: string }> = [
  { key: "J / ↓", action: "Next finding" },
  { key: "K / ↑", action: "Previous finding" },
  { key: "C", action: "Confirm finding" },
  { key: "D", action: "Dismiss finding" },
  { key: "?", action: "Toggle this help" },
  { key: "Esc", action: "Exit review mode" },
];

export default function ReviewQueue({
  findings,
  initialId,
  heading,
  subheading,
  onUpdate,
  onClose,
  docHref,
}: ReviewQueueProps) {
  const queue = useMemo(() => orderReviewQueue(findings), [findings]);
  const [currentId, setCurrentId] = useState<string | null>(() => {
    const ordered = orderReviewQueue(findings);
    if (initialId !== null && ordered.some((finding) => finding.id === initialId)) {
      return initialId;
    }
    return nextEligibleId(ordered, null);
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Guards overlapping mutations (fast keys, double clicks); render state
  // mirrors it for disabled buttons.
  const actionInFlight = useRef(false);
  const [acting, setActing] = useState(false);

  // Resolve without effects: the id wins when still present, otherwise the
  // first eligible finding takes over (or completion when none remains).
  const resolvedId =
    currentId !== null && queue.some((finding) => finding.id === currentId)
      ? currentId
      : nextEligibleId(queue, null);
  const current = resolvedId === null ? undefined : queue.find((f) => f.id === resolvedId);
  const position = current === undefined ? 0 : queue.findIndex((f) => f.id === current.id) + 1;
  const openRemaining = queue.filter(isOpenFinding).length;

  const step = (direction: 1 | -1): void => {
    if (current === undefined || queue.length === 0) {
      return;
    }
    const nextIndex = (position - 1 + direction + queue.length) % queue.length;
    const next = queue[nextIndex] as Finding;
    setActionError(null);
    setCurrentId(next.id);
  };

  const act = (finding: Finding, reviewStatus: ReviewStatus): void => {
    if (actionInFlight.current) {
      return;
    }
    actionInFlight.current = true;
    setActing(true);
    setActionError(null);
    void onUpdate(finding, reviewStatus).then(
      () => {
        actionInFlight.current = false;
        setActing(false);
        // Advance within the locally patched queue: the parent's state
        // update lands in the same render batch, so positions never jump.
        const patched = queue.map((item) =>
          item.id === finding.id ? { ...item, reviewStatus } : item,
        );
        setCurrentId(nextEligibleId(patched, finding.id));
      },
      (err: unknown) => {
        actionInFlight.current = false;
        setActing(false);
        setActionError(errorMessage(err));
      },
    );
  };

  // Single-key shortcuts. Never fire while typing, picking options, editing
  // content, or holding modifiers; action keys also ignore held-key repeat
  // so one press is exactly one mutation.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      const described =
        target instanceof HTMLElement
          ? { tagName: target.tagName, isContentEditable: target.isContentEditable }
          : null;
      if (
        shouldIgnoreShortcut(described, {
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
        })
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (key === "?") {
        event.preventDefault();
        setShowHelp((open) => !open);
        return;
      }
      if (current === undefined) {
        return;
      }
      if (key === "j" || key === "arrowdown") {
        event.preventDefault();
        step(1);
      } else if (key === "k" || key === "arrowup") {
        event.preventDefault();
        step(-1);
      } else if (key === "c") {
        if (!event.repeat) {
          event.preventDefault();
          act(current, "confirmed");
        }
      } else if (key === "d") {
        if (!event.repeat) {
          event.preventDefault();
          act(current, "dismissed");
        }
      }
    };
    // No dependency array: resubscribing each render keeps the step/act
    // closures fresh without stale-queue bugs.
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  useEffect(() => {
    panelRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900">{heading}</h2>
            <p className="mt-0.5 truncate text-sm text-slate-600" title={subheading}>
              {subheading}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={() => setShowHelp((open) => !open)} aria-expanded={showHelp}>
              Shortcuts
            </Button>
            <Button size="sm" onClick={onClose} aria-label="Exit review mode">
              ×
            </Button>
          </div>
        </div>

        {showHelp && (
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-3">
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
              {SHORTCUTS.map((shortcut) => (
                <li key={shortcut.action} className="flex items-center gap-2 text-[13px]">
                  <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">
                    {shortcut.key}
                  </kbd>
                  <span className="text-slate-600">{shortcut.action}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-500">
              Shortcuts pause while typing in inputs or editing text.
            </p>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {queue.length === 0 ? (
            <div className="py-10 text-center">
              <p className="font-medium text-slate-900">No findings in this queue</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
                Nothing matches the current filters. Clear them or pick another scope to
                review more findings.
              </p>
              <Button onClick={onClose} className="mt-4">
                Back to findings
              </Button>
            </div>
          ) : current === undefined ? (
            <div className="py-10 text-center" role="status">
              <p className="text-3xl" aria-hidden="true">
                ✓
              </p>
              <p className="mt-2 font-medium text-slate-900">Queue complete</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
                Every finding in this queue has been confirmed or dismissed. New
                findings will appear here automatically.
              </p>
              <Button onClick={onClose} className="mt-4">
                Back to findings
              </Button>
            </div>
          ) : (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONE[current.severity]}>
                  {SEVERITY_LABELS[current.severity]}
                </Badge>
                <Badge tone="info">{categoryLabel(current.category)}</Badge>
                <span className="text-[13px] text-slate-500">
                  {current.page !== null ? `Page ${current.page}` : "Page unavailable"}
                </span>
              </div>
              <p className="mt-2 font-medium text-slate-900">{current.title}</p>
              <p className="mt-1 text-sm text-slate-700">{current.explanation}</p>
              <blockquote className="mt-3 border-l-2 border-slate-300 pl-3 text-sm text-slate-600">
                <p className="whitespace-pre-wrap break-words">{current.excerpt}</p>
                <p className="mt-1 text-[13px] text-slate-500">
                  {current.filename ?? "Source excerpt"}
                </p>
              </blockquote>
              {current.counterEvidence !== undefined && (
                <p className="mt-2 text-sm text-slate-600">
                  <span className="font-medium">Counter-evidence: </span>
                  {current.counterEvidence}
                </p>
              )}
              {current.uncertainty !== undefined && (
                <p className="mt-1 text-sm text-slate-600">
                  <span className="font-medium">Uncertainty: </span>
                  {current.uncertainty}
                </p>
              )}
              <p className="mt-3 text-[13px] text-slate-500">
                Currently: {REVIEW_STATUS_LABELS[current.reviewStatus]}
              </p>
              {actionError !== null && (
                <p className="mt-2 text-sm text-red-700" role="alert">
                  {actionError}
                </p>
              )}
            </div>
          )}
        </div>

        {current !== undefined && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-3">
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => step(-1)} disabled={queue.length < 2}>
                ← Prev
              </Button>
              <Button size="sm" onClick={() => step(1)} disabled={queue.length < 2}>
                Next →
              </Button>
              <span className="ml-1 text-[13px] tabular-nums text-slate-600">
                Finding {position} of {queue.length} · {openRemaining} open
              </span>
            </div>
            <div className="flex items-center gap-2">
              {docHref !== undefined && (
                <Link
                  href={docHref(current)}
                  className="rounded px-2 py-1 text-[13px] font-medium text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                >
                  Open in document
                </Link>
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={acting}
                onClick={() => act(current, "confirmed")}
              >
                {acting ? "Saving…" : "Confirm (C)"}
              </Button>
              <Button size="sm" disabled={acting} onClick={() => act(current, "dismissed")}>
                Dismiss (D)
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
