import type { ReviewStatus, Severity } from "@/lib/findings/schema";
import { getRiskCategory } from "@/lib/risks";
import type { DocSource, DocStatus } from "@/lib/store/types";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";

const SEVERITY_TONE: Record<Severity, "red" | "orange" | "amber" | "slate"> = {
  critical: "red",
  high: "orange",
  medium: "amber",
  low: "slate",
};

/** Severity keeps the solid ink chips: the one strong color on the screen. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{severity}</Badge>;
}

const REVIEW_DOT: Record<ReviewStatus, string> = {
  open: "bg-stone-400",
  confirmed: "bg-teal-700",
  dismissed: "bg-stone-300",
  needs_legal_review: "bg-blue-700",
};

const REVIEW_LABEL: Record<ReviewStatus, string> = {
  open: "Open",
  confirmed: "Confirmed",
  dismissed: "Dismissed",
  needs_legal_review: "Needs legal review",
};

/** Review state is quiet dot + text so severity keeps the color. */
export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-stone-600">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", REVIEW_DOT[status])} aria-hidden />
      {REVIEW_LABEL[status]}
    </span>
  );
}

export const REVIEW_STATUS_OPTIONS: { value: ReviewStatus; label: string }[] = (
  Object.keys(REVIEW_LABEL) as ReviewStatus[]
).map((value) => ({ value, label: REVIEW_LABEL[value] }));

const DOC_STATUS_DOT: Record<DocStatus, string> = {
  queued: "bg-stone-400",
  processing: "bg-stone-400",
  completed: "bg-teal-700",
  partial: "bg-amber-500",
  failed: "bg-red-600",
  needs_ocr: "bg-blue-700",
};

const DOC_STATUS_LABEL: Record<DocStatus, string> = {
  queued: "Queued",
  processing: "Processing",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  needs_ocr: "Needs OCR",
};

export function DocStatusBadge({ status }: { status: DocStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-stone-600">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOC_STATUS_DOT[status])} aria-hidden />
      {DOC_STATUS_LABEL[status]}
    </span>
  );
}

export function SourceBadge({ source }: { source: DocSource }) {
  if (source !== "demo") return null;
  return (
    <Badge tone="amber" title="Synthetic demo data — not from a real legal review">
      Demo
    </Badge>
  );
}

export function CategoryLabel({ categoryId }: { categoryId: string }) {
  return <>{getRiskCategory(categoryId)?.label ?? categoryId}</>;
}

/**
 * Folio tab: the signature detail. Every page citation in the app renders as
 * one small binder tab in mono, so evidence always points at the same place.
 */
export function Folio({ pageStart, pageEnd }: { pageStart: number | null; pageEnd: number | null }) {
  if (pageStart == null) return <span className="text-stone-500">—</span>;
  const label =
    pageEnd != null && pageEnd !== pageStart ? `pp. ${pageStart}–${pageEnd}` : `p. ${pageStart}`;
  return (
    <span className="inline-flex items-center rounded border border-stone-300 bg-stone-50 px-1.5 py-px font-mono text-[11px] leading-4 whitespace-nowrap text-stone-700">
      {label}
    </span>
  );
}
