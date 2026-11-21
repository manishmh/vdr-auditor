"use client";

import Link from "next/link";
import {
  FINDING_CATEGORY_ORDER,
  REVIEW_STATUS_LABELS,
  SEVERITY_LABELS,
  type Finding,
  type FindingSeverity,
  type ReviewStatus,
} from "@/lib/analyses";
import { Badge, EmptyState, type BadgeTone } from "./ui";

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
  onReviewChange,
}: {
  finding: Finding;
  showFilename: boolean;
  onReviewChange: (finding: Finding, reviewStatus: ReviewStatus) => void;
}) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[finding.severity]}>
          {SEVERITY_LABELS[finding.severity]}
        </Badge>
        <p className="font-medium text-slate-900">{finding.title}</p>
      </div>
      <p className="mt-2 text-sm text-slate-700">{finding.explanation}</p>
      <blockquote className="mt-2 border-l-2 border-slate-300 pl-3 text-sm text-slate-600">
        <p className="whitespace-pre-wrap break-words">{finding.excerpt}</p>
        <p className="mt-1 text-[13px] text-slate-500">
          {showFilename ? (
            <Link
              href={`/matters/${finding.matterId}/docs/${finding.docId}`}
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
      <div className="mt-3 flex items-center gap-2">
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
    </li>
  );
}

export function FindingGroups({
  findings,
  showFilename,
  onReviewChange,
}: {
  findings: Finding[];
  showFilename: boolean;
  onReviewChange: (finding: Finding, reviewStatus: ReviewStatus) => void;
}) {
  return (
    <>
      {FINDING_CATEGORY_ORDER.map((group) => {
        const items = findings
          .filter((finding) => finding.category === group.id)
          .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
        if (items.length === 0) {
          return null;
        }
        return (
          <div key={group.id}>
            <h3 className="text-base font-semibold text-slate-900">{group.label}</h3>
            <p className="mt-0.5 text-sm text-slate-600">{group.description}</p>
            <ul className="mt-3 space-y-3">
              {items.map((finding) => (
                <FindingCard
                  key={finding.id}
                  finding={finding}
                  showFilename={showFilename}
                  onReviewChange={onReviewChange}
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
