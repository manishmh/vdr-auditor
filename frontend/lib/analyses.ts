import { expectArray, expectObject, requestJson } from "./matters";

export type FindingCategory =
  | "change_of_control"
  | "missing_signatures"
  | "uncapped_liabilities";

export type FindingSeverity = "high" | "medium" | "low";

export type ReviewStatus = "open" | "confirmed" | "dismissed";

export type AnalysisRunStatus = "running" | "completed" | "limited" | "failed";

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

export interface AnalysisRun {
  id: string;
  matterId: string;
  docId: string;
  status: AnalysisRunStatus;
  error?: string;
  pagesAnalyzed?: number;
  totalPages?: number;
  sectionsAnalyzed?: number;
  sectionsTotal?: number;
  limitations: string[];
  startedAt: string;
  finishedAt?: string;
}

export interface DocAnalysis extends AnalysisRun {
  filename?: string;
}

export const FINDING_CATEGORY_ORDER: Array<{
  id: FindingCategory;
  label: string;
  description: string;
}> = [
  {
    id: "change_of_control",
    label: "Change of control",
    description: "Acquisition, merger, and assignment provisions and their consequences.",
  },
  {
    id: "missing_signatures",
    label: "Missing signatures",
    description: "Apparent gaps in execution. Review the original before concluding.",
  },
  {
    id: "uncapped_liabilities",
    label: "Uncapped liabilities",
    description: "Indemnities and obligations without a clear monetary cap.",
  },
];

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  open: "Open",
  confirmed: "Confirmed",
  dismissed: "Dismissed",
};

export async function listAnalyses(
  apiUrl: string,
  matterId: string,
): Promise<DocAnalysis[]> {
  const body = await requestJson<unknown>(apiUrl, `/api/matters/${matterId}/analyses`);
  const analyses = expectObject<{ analyses: unknown }>(body, "analyses").analyses;
  return expectArray<DocAnalysis>(analyses, "analyses");
}

export async function listDocAnalyses(
  apiUrl: string,
  matterId: string,
  docId: string,
): Promise<AnalysisRun[]> {
  const body = await requestJson<unknown>(
    apiUrl,
    `/api/matters/${matterId}/documents/${docId}/analyses`,
  );
  const analyses = expectObject<{ analyses: unknown }>(body, "analysis history").analyses;
  return expectArray<AnalysisRun>(analyses, "analysis history");
}

export async function listFindings(
  apiUrl: string,
  matterId: string,
): Promise<Finding[]> {
  return expectArray<Finding>(
    await requestJson<unknown>(apiUrl, `/api/matters/${matterId}/findings`),
    "findings",
  );
}

// Analysis runs the model synchronously and can take minutes for long
// documents; everything else keeps the shared 10s client timeout.
const ANALYSIS_TIMEOUT_MS = 300000;

export async function startAnalysis(
  apiUrl: string,
  matterId: string,
  docId: string,
): Promise<{ run: AnalysisRun; findings: Finding[] }> {
  return requestJson<{ run: AnalysisRun; findings: Finding[] }>(
    apiUrl,
    `/api/matters/${matterId}/documents/${docId}/analysis`,
    { method: "POST" },
    ANALYSIS_TIMEOUT_MS,
  );
}

export async function updateFindingReview(
  apiUrl: string,
  matterId: string,
  findingId: string,
  reviewStatus: ReviewStatus,
): Promise<Finding> {
  return expectObject<Finding>(
    await requestJson<unknown>(
      apiUrl,
      `/api/matters/${matterId}/findings/${findingId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewStatus }),
      },
    ),
    "that review update",
  );
}
