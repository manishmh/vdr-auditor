"use client";

import Link from "next/link";
import { useState } from "react";
import {
  FINDING_CATEGORY_ORDER,
  REVIEW_STATUS_LABELS,
  SEVERITY_LABELS,
  type Finding,
  type FindingSeverity,
  type ReviewStatus,
} from "@/lib/analyses";
import { Badge, Button, EmptyState, type BadgeTone } from "./ui";

export const SEVERITY_TONE: Record<FindingSeverity, BadgeTone> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function FindingCard({
  finding,
  showFilename,
  open,
  onToggle,
  onReviewChange,
  selected = false,
}: {
  finding: Finding;
  showFilename: boolean;
  open: boolean;
  onToggle: () => void;
  onReviewChange: (finding: Finding, reviewStatus: ReviewStatus) => void;
  selected?: boolean;
}) {
  const bodyId = `finding-body-${finding.id}`;
  return (
    <li
      id={`finding-card-${finding.id}`}
      className={`scroll-mt-24 rounded-lg border bg-white px-4 py-3 ${
        selected ? "border-blue-800 ring-2 ring-blue-800/30" : "border-slate-200"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
        >
          <span aria-hidden="true" className="w-4 shrink-0 text-slate-400">
            {open ? "▾" : "▸"}
          </span>
          <Badge tone={SEVERITY_TONE[finding.severity]}>
            {SEVERITY_LABELS[finding.severity]}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
            {finding.title}
          </span>
          <span className="shrink-0 text-[13px] text-slate-500">
            {finding.page !== null ? `Page ${finding.page}` : "Page n/a"}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <label htmlFor={`review-${finding.id}`} className="text-[13px] text-slate-600">
            Review
          </label>
          <select
            id={`review-${finding.id}`}
            value={finding.reviewStatus}
            onChange={(event) => onReviewChange(finding, event.target.value as ReviewStatus)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
          >
            {(Object.keys(REVIEW_STATUS_LABELS) as ReviewStatus[]).map((status) => (
              <option key={status} value={status}>
                {REVIEW_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {open && (
        <div id={bodyId}>
          <p className="mt-2 text-sm text-slate-700">{finding.explanation}</p>
          <blockquote className="mt-2 border-l-2 border-slate-300 pl-3 text-sm text-slate-600">
            <p className="whitespace-pre-wrap break-words">{finding.excerpt}</p>
            <p className="mt-1 text-[13px] text-slate-500">
              {showFilename ? (
                <Link
                  href={`/matters/${finding.matterId}/docs/${finding.docId}?finding=${finding.id}`}
                  className="rounded font-medium text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                >
                  {finding.filename ?? "Document"}
                </Link>
              ) : (
                "Source excerpt"
              )}
              {finding.page !== null ? ` · Page ${finding.page}` : " · page unavailable"}
            </p>
          </blockquote>
          {finding.counterEvidence !== undefined && (
            <p className="mt-2 text-sm text-slate-600">
              <span className="font-medium">Counter-evidence: </span>
              {finding.counterEvidence}
            </p>
          )}
          {finding.uncertainty !== undefined && (
            <p className="mt-1 text-sm text-slate-600">
              <span className="font-medium">Uncertainty: </span>
              {finding.uncertainty}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function FindingGroups({
  findings,
  showFilename,
  onReviewChange,
  selectedId = null,
  onSelect,
}: {
  findings: Finding[];
  showFilename: boolean;
  onReviewChange: (finding: Finding, reviewStatus: ReviewStatus) => void;
  /** Ringed as the viewer-synced finding; does not force expansion. */
  selectedId?: string | null;
  onSelect?: (finding: Finding) => void;
}) {
  // Independently collapsible cards: any number may stay open at once.
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (id: string): void => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  const allOpen = findings.length > 0 && findings.every((finding) => openIds.has(finding.id));
  return (
    <>
      {findings.length > 1 && (
        <div className="mb-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setOpenIds(allOpen ? new Set() : new Set(findings.map((finding) => finding.id)))
            }
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </Button>
        </div>
      )}
      {FINDING_CATEGORY_ORDER.map((group) => {
        const items = findings
          .filter((finding) => finding.category === group.id)
          .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
        if (items.length === 0) {
          return null;
        }
        return (
          <div key={group.id}>
            <h3 className="text-base font-semibold text-slate-900">
              {group.label}{" "}
              <span className="font-normal text-slate-500">({items.length})</span>
            </h3>
            <p className="mt-0.5 text-sm text-slate-600">{group.description}</p>
            <ul className="mt-3 space-y-3">
              {items.map((finding) => (
                <FindingCard
                  key={finding.id}
                  finding={finding}
                  showFilename={showFilename}
                  open={openIds.has(finding.id)}
                  onToggle={() => {
                    toggle(finding.id);
                    onSelect?.(finding);
                  }}
                  onReviewChange={onReviewChange}
                  selected={selectedId === finding.id}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

export interface FindingsViewInput {
  analysisInProgress: boolean;
  failedCount: number;
  limitedCount: number;
  completedCount: number;
}

/**
 * Empty-state copy for a findings list. "No issues found" is only valid for
 * genuinely complete, fully covered, zero-finding work — every other state
 * says exactly what it is instead.
 */
export function findingsEmptyState(input: FindingsViewInput): {
  title: string;
  body: string;
} {
  if (input.analysisInProgress) {
    return {
      title: "Analysis in progress",
      body: "No verified findings yet. They will appear here as analysis completes.",
    };
  }
  if (input.failedCount > 0) {
    return {
      title: "No verified findings",
      body: "Analysis did not complete successfully. Retry to try again.",
    };
  }
  if (input.limitedCount > 0) {
    return {
      title: "No verified findings",
      body: "Partial analysis reported no findings in the sections it covered. This is not a full clearance.",
    };
  }
  if (input.completedCount > 0) {
    return {
      title: "No issues found",
      body: "Analysis ran and reported no findings in the covered risk categories.",
    };
  }
  return {
    title: "No findings yet",
    body: "Findings will appear here after analysis runs over the extracted documents.",
  };
}

export function FindingsEmpty({ input }: { input: FindingsViewInput }) {
  const { title, body } = findingsEmptyState(input);
  return <EmptyState title={title} body={body} />;
}
