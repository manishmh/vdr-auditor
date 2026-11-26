import type {
  Finding,
  FindingCategory,
  FindingSeverity,
  ReviewStatus,
} from "./analyses";

/** Combined queue filters; "all" means that dimension does not narrow. */
export interface FindingFilters {
  severity: FindingSeverity | "all";
  category: FindingCategory | "all";
  reviewStatus: ReviewStatus | "all";
  docId: string | "all";
}

export const EMPTY_FINDING_FILTERS: FindingFilters = {
  severity: "all",
  category: "all",
  reviewStatus: "all",
  docId: "all",
};

export function isFiltered(filters: FindingFilters): boolean {
  return (
    filters.severity !== "all" ||
    filters.category !== "all" ||
    filters.reviewStatus !== "all" ||
    filters.docId !== "all"
  );
}

/**
 * One-line summary of the active filter dimensions ("High severity ·
 * Document: a.pdf"), or "All findings" when unfiltered. The caller resolves
 * document names; an unresolvable doc id falls back to "a document".
 */
export function describeFindingFilters(
  filters: FindingFilters,
  options: {
    severityLabel: (severity: FindingSeverity) => string;
    categoryLabel: (category: FindingCategory) => string;
    statusLabel: (status: ReviewStatus) => string;
    docName: (docId: string) => string | undefined;
  },
): string {
  const parts: string[] = [];
  if (filters.severity !== "all") {
    parts.push(`${options.severityLabel(filters.severity)} severity`);
  }
  if (filters.category !== "all") {
    parts.push(options.categoryLabel(filters.category));
  }
  if (filters.reviewStatus !== "all") {
    parts.push(options.statusLabel(filters.reviewStatus));
  }
  if (filters.docId !== "all") {
    parts.push(`Document: ${options.docName(filters.docId) ?? "a document"}`);
  }
  return parts.length === 0 ? "All findings" : parts.join(" · ");
}

/**
 * Narrow findings by every active filter dimension at once. Dimensions
 * combine (logical AND); each "all" dimension is ignored, never exclusive.
 */
export function applyFindingFilters(
  findings: Finding[],
  filters: FindingFilters,
): Finding[] {
  return findings.filter(
    (finding) =>
      (filters.severity === "all" || finding.severity === filters.severity) &&
      (filters.category === "all" || finding.category === filters.category) &&
      (filters.reviewStatus === "all" || finding.reviewStatus === filters.reviewStatus) &&
      (filters.docId === "all" || finding.docId === filters.docId),
  );
}

export function isOpenFinding(finding: Finding): boolean {
  return finding.reviewStatus === "open";
}

export function isReviewedFinding(finding: Finding): boolean {
  return finding.reviewStatus === "confirmed" || finding.reviewStatus === "dismissed";
}

/**
 * Document ids with current (completed/limited) analysis results. Only
 * existing documents count, and only a successful run covers one: failed,
 * running, and never-analyzed documents stay uncovered even when a newer
 * failed attempt is their latest run.
 */
export function selectCoveredDocIds(
  analyses: Array<{ docId: string; current: unknown }>,
  docIds: string[],
): Set<string> {
  const existing = new Set(docIds);
  const covered = new Set<string>();
  for (const analysis of analyses) {
    if (analysis.current !== null && existing.has(analysis.docId)) {
      covered.add(analysis.docId);
    }
  }
  return covered;
}

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
}

/** Open (unreviewed) findings per severity; reviewed ones never count here. */
export function countOpenBySeverity(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    if (isOpenFinding(finding)) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

export interface ReviewCompletion {
  total: number;
  reviewed: number;
  /** Whole percent reviewed, or null when there is nothing to review. */
  percent: number | null;
}

/**
 * Review completion over a finding scope. Zero findings is not 0%: it is
 * null (nothing to complete), so dashboards can distinguish "all clear"
 * from "nothing analyzed yet" instead of dividing by zero.
 */
export function reviewCompletion(findings: Finding[]): ReviewCompletion {
  const total = findings.length;
  const reviewed = findings.filter(isReviewedFinding).length;
  return {
    total,
    reviewed,
    percent: total === 0 ? null : Math.round((reviewed / total) * 100),
  };
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Review-queue order: highest severity first, then oldest finding, then id
 * for a stable tiebreak. Pure: never mutates its input.
 */
export function orderReviewQueue(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) {
      return severity;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Next eligible (still open) finding after `currentId` in queue order,
 * wrapping to the first open finding when the tail is exhausted. Returns
 * null when nothing in the queue is still open (completion), including for
 * an empty queue or an unknown current id with no open findings.
 */
export function nextEligibleId(
  queue: Finding[],
  currentId: string | null,
): string | null {
  const ordered = orderReviewQueue(queue);
  const currentIndex = currentId === null ? -1 : ordered.findIndex((f) => f.id === currentId);
  for (let index = currentIndex + 1; index < ordered.length; index += 1) {
    const candidate = ordered[index] as Finding;
    if (isOpenFinding(candidate)) {
      return candidate.id;
    }
  }
  const wrapEnd = currentIndex === -1 ? ordered.length : currentIndex;
  for (let index = 0; index < wrapEnd; index += 1) {
    const candidate = ordered[index] as Finding;
    if (isOpenFinding(candidate)) {
      return candidate.id;
    }
  }
  return null;
}

/** Minimal keyboard-event target shape; keeps the guard DOM-free for tests. */
export interface ShortcutTarget {
  tagName: string;
  isContentEditable: boolean;
}

export interface ShortcutModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * True when a single-key review shortcut must NOT fire: focus is in an
 * editable control (typing, picking an option, editing content) or a
 * modifier is held (browser/OS shortcuts win). A null target (body-level
 * focus) never blocks.
 */
export function shouldIgnoreShortcut(
  target: ShortcutTarget | null,
  modifiers: ShortcutModifiers,
): boolean {
  if (modifiers.metaKey || modifiers.ctrlKey || modifiers.altKey) {
    return true;
  }
  if (target === null) {
    return false;
  }
  return target.isContentEditable || EDITABLE_TAGS.has(target.tagName.toUpperCase());
}
