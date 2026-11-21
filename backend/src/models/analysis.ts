import { ObjectId } from "mongodb";
import type { FindingCategory, FindingSeverity } from "../ai/analysis.js";

export const ANALYSIS_RUN_STATUSES = [
  "running",
  "completed",
  "limited",
  "failed",
] as const;
export type AnalysisRunStatus = (typeof ANALYSIS_RUN_STATUSES)[number];

export const REVIEW_STATUSES = ["open", "confirmed", "dismissed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * One analysis attempt over a single document. Findings reference the run;
 * only runs that produced reviewable output (completed/limited) count as
 * current. Failed runs leave previous results untouched.
 */
export interface AnalysisRunRecord {
  _id: ObjectId;
  matterId: ObjectId;
  docId: ObjectId;
  status: AnalysisRunStatus;
  error?: string;
  pagesAnalyzed?: number;
  totalPages?: number;
  /** Live progress, updated after every section while running. */
  sectionsAnalyzed?: number;
  sectionsTotal?: number;
  limitations: string[];
  startedAt: Date;
  finishedAt?: Date;
}

export interface AnalysisRun {
  id: string;
  matterId: string;
  docId: string;
  status: AnalysisRunStatus;
  error?: string;
  pagesAnalyzed?: number;
  totalPages?: number;
  /** Live progress, updated after every section while running. */
  sectionsAnalyzed?: number;
  sectionsTotal?: number;
  limitations: string[];
  startedAt: string;
  finishedAt?: string;
}

export interface FindingRecord {
  _id: ObjectId;
  runId: ObjectId;
  matterId: ObjectId;
  docId: ObjectId;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  excerpt: string;
  page: number | null;
  counterEvidence?: string;
  uncertainty?: string;
  reviewStatus: ReviewStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Finding {
  id: string;
  runId: string;
  matterId: string;
  docId: string;
  filename?: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  excerpt: string;
  page: number | null;
  counterEvidence?: string;
  uncertainty?: string;
  reviewStatus: ReviewStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export type ReviewStatusParseResult =
  | { ok: true; value: { reviewStatus: ReviewStatus } }
  | { ok: false; issues: ValidationIssue[] };

export function parseReviewStatusUpdate(body: unknown): ReviewStatusParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      issues: [{ field: "body", message: "Request body must be a JSON object." }],
    };
  }
  const status = (body as Record<string, unknown>)["reviewStatus"];
  if (
    typeof status !== "string" ||
    !(REVIEW_STATUSES as readonly string[]).includes(status)
  ) {
    return {
      ok: false,
      issues: [
        {
          field: "reviewStatus",
          message: `Review status must be one of: ${REVIEW_STATUSES.join(", ")}.`,
        },
      ],
    };
  }
  return { ok: true, value: { reviewStatus: status as ReviewStatus } };
}

export function toAnalysisRunResponse(run: AnalysisRunRecord): AnalysisRun {
  return {
    id: run._id.toHexString(),
    matterId: run.matterId.toHexString(),
    docId: run.docId.toHexString(),
    status: run.status,
    error: run.error,
    pagesAnalyzed: run.pagesAnalyzed,
    totalPages: run.totalPages,
    sectionsAnalyzed: run.sectionsAnalyzed,
    sectionsTotal: run.sectionsTotal,
    limitations: run.limitations,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
  };
}

export function toFindingResponse(
  finding: FindingRecord,
  filename?: string,
): Finding {
  return {
    id: finding._id.toHexString(),
    runId: finding.runId.toHexString(),
    matterId: finding.matterId.toHexString(),
    docId: finding.docId.toHexString(),
    filename,
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    explanation: finding.explanation,
    excerpt: finding.excerpt,
    page: finding.page,
    counterEvidence: finding.counterEvidence,
    uncertainty: finding.uncertainty,
    reviewStatus: finding.reviewStatus,
    createdAt: finding.createdAt.toISOString(),
    updatedAt: finding.updatedAt.toISOString(),
  };
}
