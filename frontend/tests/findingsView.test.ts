import { describe, expect, it } from "vitest";
import type { Finding } from "../lib/analyses";
import {
  EMPTY_FINDING_FILTERS,
  applyFindingFilters,
  countOpenBySeverity,
  describeFindingFilters,
  isFiltered,
  nextEligibleId,
  orderReviewQueue,
  reviewCompletion,
  selectCoveredDocIds,
  shouldIgnoreShortcut,
} from "../lib/findingsView";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    runId: "r1",
    matterId: "m1",
    docId: "d1",
    category: "change_of_control",
    severity: "high",
    title: "Title",
    explanation: "Explanation.",
    excerpt: "Some excerpt text here.",
    page: 1,
    reviewStatus: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyFindingFilters", () => {
  const items = [
    finding({ id: "a", severity: "high", category: "change_of_control", reviewStatus: "open", docId: "d1" }),
    finding({ id: "b", severity: "low", category: "change_of_control", reviewStatus: "open", docId: "d1" }),
    finding({ id: "c", severity: "high", category: "missing_signatures", reviewStatus: "confirmed", docId: "d2" }),
    finding({ id: "d", severity: "medium", category: "uncapped_liabilities", reviewStatus: "dismissed", docId: "d2" }),
  ];

  it("returns everything when no filter is active", () => {
    expect(applyFindingFilters(items, EMPTY_FINDING_FILTERS)).toHaveLength(4);
    expect(isFiltered(EMPTY_FINDING_FILTERS)).toBe(false);
  });

  it("combines dimensions instead of overwriting", () => {
    const narrowed = applyFindingFilters(items, {
      ...EMPTY_FINDING_FILTERS,
      severity: "high",
      reviewStatus: "open",
    });
    expect(narrowed.map((f) => f.id)).toEqual(["a"]);
    expect(isFiltered({ ...EMPTY_FINDING_FILTERS, severity: "high" })).toBe(true);
  });

  it("filters by category and document", () => {
    expect(
      applyFindingFilters(items, { ...EMPTY_FINDING_FILTERS, category: "missing_signatures" }).map(
        (f) => f.id,
      ),
    ).toEqual(["c"]);
    expect(
      applyFindingFilters(items, { ...EMPTY_FINDING_FILTERS, docId: "d2" }).map((f) => f.id),
    ).toEqual(["c", "d"]);
  });

  it("yields an empty list when nothing matches", () => {
    expect(
      applyFindingFilters(items, {
        ...EMPTY_FINDING_FILTERS,
        severity: "low",
        category: "missing_signatures",
      }),
    ).toEqual([]);
  });
});

describe("describeFindingFilters", () => {
  const labels = {
    severityLabel: (s: string) => s[0]?.toUpperCase() + s.slice(1),
    categoryLabel: (c: string) => c,
    statusLabel: (s: string) => s,
    docName: (id: string) => (id === "d1" ? "a.pdf" : undefined),
  };
  it("summarizes every active dimension", () => {
    expect(
      describeFindingFilters(
        { severity: "high", category: "change_of_control", reviewStatus: "open", docId: "d1" },
        labels,
      ),
    ).toBe("High severity · change_of_control · open · Document: a.pdf");
  });
  it("reports unfiltered and unknown documents honestly", () => {
    expect(describeFindingFilters(EMPTY_FINDING_FILTERS, labels)).toBe("All findings");
    expect(
      describeFindingFilters({ ...EMPTY_FINDING_FILTERS, docId: "gone" }, labels),
    ).toBe("Document: a document");
  });
});

describe("countOpenBySeverity", () => {
  it("counts only unreviewed findings per severity", () => {
    const counts = countOpenBySeverity([
      finding({ severity: "high", reviewStatus: "open" }),
      finding({ severity: "high", reviewStatus: "confirmed" }),
      finding({ severity: "medium", reviewStatus: "dismissed" }),
      finding({ severity: "low", reviewStatus: "open" }),
    ]);
    expect(counts).toEqual({ high: 1, medium: 0, low: 1 });
  });

  it("counts zero findings as zero, not an error", () => {
    expect(countOpenBySeverity([])).toEqual({ high: 0, medium: 0, low: 0 });
  });
});

describe("selectCoveredDocIds", () => {
  it("covers documents with current results, including past a failed latest", () => {
    const covered = selectCoveredDocIds(
      [
        { docId: "a", current: { status: "completed" } },
        { docId: "b", current: null },
        { docId: "deleted", current: { status: "completed" } },
      ],
      ["a", "b", "c"],
    );
    expect([...covered].sort()).toEqual(["a"]);
  });

  it("covers nothing when no run succeeded", () => {
    expect(selectCoveredDocIds([{ docId: "a", current: null }], ["a"]).size).toBe(0);
    expect(selectCoveredDocIds([], ["a"]).size).toBe(0);
  });
});

describe("reviewCompletion", () => {
  it("measures reviewed over total", () => {
    expect(
      reviewCompletion([
        finding({ reviewStatus: "open" }),
        finding({ reviewStatus: "confirmed" }),
        finding({ reviewStatus: "dismissed" }),
        finding({ reviewStatus: "open" }),
      ]),
    ).toEqual({ total: 4, reviewed: 2, percent: 50 });
  });

  it("reports null percent for zero findings instead of dividing by zero", () => {
    expect(reviewCompletion([])).toEqual({ total: 0, reviewed: 0, percent: null });
  });
});

describe("orderReviewQueue", () => {
  it("orders by severity, then age, then id", () => {
    const ordered = orderReviewQueue([
      finding({ id: "low-old", severity: "low", createdAt: "2026-01-01T00:00:00.000Z" }),
      finding({ id: "high-new", severity: "high", createdAt: "2026-03-01T00:00:00.000Z" }),
      finding({ id: "high-old", severity: "high", createdAt: "2026-01-01T00:00:00.000Z" }),
      finding({ id: "med", severity: "medium", createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(ordered.map((f) => f.id)).toEqual(["high-old", "high-new", "med", "low-old"]);
  });

  it("never mutates its input", () => {
    const items = [finding({ id: "b", severity: "low" }), finding({ id: "a", severity: "high" })];
    orderReviewQueue(items);
    expect(items.map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("nextEligibleId", () => {
  const queue = [
    finding({ id: "a", severity: "high", reviewStatus: "confirmed" }),
    finding({ id: "b", severity: "high", reviewStatus: "open" }),
    finding({ id: "c", severity: "medium", reviewStatus: "open" }),
  ];

  it("advances to the next open finding in queue order", () => {
    expect(nextEligibleId(queue, "b")).toBe("c");
    expect(nextEligibleId(queue, null)).toBe("b");
  });

  it("wraps to an earlier open finding when the tail is exhausted", () => {
    const wrapped = [
      finding({ id: "a", severity: "high", reviewStatus: "open" }),
      finding({ id: "b", severity: "low", reviewStatus: "confirmed" }),
    ];
    expect(nextEligibleId(wrapped, "b")).toBe("a");
  });

  it("returns null when nothing remains open", () => {
    const done = queue.map((f) => ({ ...f, reviewStatus: "confirmed" as const }));
    expect(nextEligibleId(done, "b")).toBeNull();
    expect(nextEligibleId([], null)).toBeNull();
  });
});

describe("shouldIgnoreShortcut", () => {
  const noModifiers = { metaKey: false, ctrlKey: false, altKey: false };

  it("fires for body-level focus without modifiers", () => {
    expect(shouldIgnoreShortcut(null, noModifiers)).toBe(false);
    expect(
      shouldIgnoreShortcut({ tagName: "DIV", isContentEditable: false }, noModifiers),
    ).toBe(false);
    expect(
      shouldIgnoreShortcut({ tagName: "BUTTON", isContentEditable: false }, noModifiers),
    ).toBe(false);
  });

  it("ignores keys typed in editable controls", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
      expect(
        shouldIgnoreShortcut({ tagName, isContentEditable: false }, noModifiers),
      ).toBe(true);
    }
    expect(
      shouldIgnoreShortcut({ tagName: "DIV", isContentEditable: true }, noModifiers),
    ).toBe(true);
  });

  it("ignores modified keys so browser shortcuts win", () => {
    for (const modifiers of [
      { metaKey: true, ctrlKey: false, altKey: false },
      { metaKey: false, ctrlKey: true, altKey: false },
      { metaKey: false, ctrlKey: false, altKey: true },
    ]) {
      expect(shouldIgnoreShortcut(null, modifiers)).toBe(true);
    }
  });
});
