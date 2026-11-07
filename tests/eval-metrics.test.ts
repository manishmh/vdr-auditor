import { describe, expect, it } from "vitest";
import type { EvalFixture } from "@/lib/eval/dataset";
import {
  aggregateScores,
  dedupeFindings,
  median,
  percentile,
  prf,
  scoreFixture,
} from "@/lib/eval/metrics";
import type { FixtureOutcome } from "@/lib/eval/types";
import type { RiskCategory, Severity, StoredFinding } from "@/lib/findings/schema";

let counter = 0;

function finding(overrides: Partial<StoredFinding> = {}): StoredFinding {
  counter += 1;
  const now = new Date().toISOString();
  return {
    category: "change_of_control",
    severity: "high",
    title: "t",
    explanation: "e",
    evidence: "quoted passage",
    recommendedAction: "a",
    id: `123e4567-e89b-12d3-a456-42661417${String(4000 + counter).slice(-4)}`,
    documentId: "123e4567-e89b-12d3-a456-426614174001",
    pageStart: 1,
    pageEnd: 1,
    status: "open",
    reviewerNote: null,
    modelId: "mock-v1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fixture(overrides: Partial<EvalFixture> = {}): EvalFixture {
  return {
    id: "fx-01",
    label: "positive",
    title: "t",
    pages: [{ pageNumber: 1, text: "quoted passage" }],
    expected: { categories: ["change_of_control"], ambiguous: false, evidence: [], rationale: "r" },
    ...overrides,
  };
}

function outcome(overrides: Partial<FixtureOutcome> = {}): FixtureOutcome {
  return {
    fixtureId: "fx-01",
    status: "completed",
    latencyMs: 5,
    findings: [],
    droppedInvalid: 0,
    droppedUnverified: 0,
    sectionErrors: [],
    ...overrides,
  };
}

describe("prf", () => {
  it("computes precision, recall, and F1", () => {
    expect(prf(2, 1, 1)).toMatchObject({ precision: 2 / 3, recall: 2 / 3, f1: 2 / 3 });
  });

  it("returns null on zero denominators", () => {
    expect(prf(0, 0, 0)).toMatchObject({ precision: null, recall: null, f1: null });
    expect(prf(0, 0, 2)).toMatchObject({ precision: null, recall: 0, f1: 0 });
    expect(prf(0, 2, 0)).toMatchObject({ precision: 0, recall: null, f1: 0 });
  });
});

describe("median and percentile", () => {
  it("handles odd, even, and empty inputs", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([], 95)).toBeNull();
  });
});

describe("dedupeFindings", () => {
  it("removes exact category-plus-evidence duplicates, ignoring whitespace", () => {
    const { unique, duplicates } = dedupeFindings([
      finding({ evidence: "quoted  passage" }),
      finding({ evidence: "quoted passage" }),
      finding({ evidence: "other passage" }),
      finding({ evidence: "quoted passage", category: "uncapped_liability" }),
    ]);
    expect(unique).toHaveLength(3);
    expect(duplicates).toBe(1);
  });
});

describe("scoreFixture", () => {
  it("scores multi-label detection at category level", () => {
    const score = scoreFixture(
      fixture({
        expected: {
          categories: ["change_of_control", "uncapped_liability"],
          ambiguous: false,
          evidence: [],
          rationale: "r",
        },
      }),
      outcome({
        findings: [
          finding({ category: "change_of_control" }),
          finding({ category: "missing_signature", evidence: "other" }),
        ],
      }),
    );
    expect(score.truePositives).toEqual(["change_of_control"]);
    expect(score.falsePositives).toEqual(["missing_signature"]);
    expect(score.falseNegatives).toEqual(["uncapped_liability"]);
    expect(score.excluded).toBe(false);
  });

  it("matches evidence by verbatim containment and checks pages and severity", () => {
    const score = scoreFixture(
      fixture({
        expected: {
          categories: ["change_of_control"],
          ambiguous: false,
          evidence: [
            { category: "change_of_control", quote: "quoted passage", pages: [1], severity: "high" },
          ],
          rationale: "r",
        },
      }),
      outcome({ findings: [finding({ evidence: "Before. quoted passage. After." })] }),
    );
    expect(score.slots).toHaveLength(1);
    expect(score.slots[0]).toMatchObject({ evidenceMatched: true, pageCorrect: true, severityAgreed: true });
  });

  it("fails evidence slots when the passage is absent or pages and severity miss", () => {
    const score = scoreFixture(
      fixture({
        expected: {
          categories: ["change_of_control", "uncapped_liability"],
          ambiguous: false,
          evidence: [
            { category: "change_of_control", quote: "never quoted", pages: [1], severity: "high" },
            { category: "uncapped_liability", quote: "quoted passage", pages: [2], severity: "low" },
          ],
          rationale: "r",
        },
      }),
      outcome({
        findings: [
          finding({ category: "change_of_control", evidence: "something else entirely" }),
          finding({ category: "uncapped_liability", evidence: "quoted passage", pageStart: 1, pageEnd: 1, severity: "critical" }),
        ],
      }),
    );
    expect(score.slots[0]).toMatchObject({ evidenceMatched: false, pageCorrect: null, severityAgreed: null });
    expect(score.slots[1]).toMatchObject({ evidenceMatched: true, pageCorrect: false, severityAgreed: false });
  });

  it("accepts page overlap and adjacent severities", () => {
    const score = scoreFixture(
      fixture({
        expected: {
          categories: ["change_of_control"],
          ambiguous: false,
          evidence: [{ category: "change_of_control", quote: "quoted passage", pages: [2], severity: "medium" }],
          rationale: "r",
        },
      }),
      outcome({
        findings: [finding({ evidence: "quoted passage", pageStart: 1, pageEnd: 2, severity: "high" })],
      }),
    );
    expect(score.slots[0]).toMatchObject({ evidenceMatched: true, pageCorrect: true, severityAgreed: true });
  });

  it("counts duplicates and unsupported candidates without scoring them as hits", () => {
    const score = scoreFixture(
      fixture(),
      outcome({
        findings: [finding(), finding()],
        droppedInvalid: 1,
        droppedUnverified: 2,
      }),
    );
    expect(score.duplicates).toBe(1);
    expect(score.unsupported).toBe(3);
    expect(score.truePositives).toEqual(["change_of_control"]);
  });

  it("excludes ambiguous, failed, partial, and skipped fixtures", () => {
    expect(scoreFixture(fixture({ expected: { categories: [], ambiguous: true, evidence: [], rationale: "r" } }), outcome()).excludeReason).toBe("ambiguous");
    expect(scoreFixture(fixture(), outcome({ status: "failed" })).excludeReason).toBe("not-completed");
    expect(scoreFixture(fixture(), outcome({ status: "partial" })).excludeReason).toBe("not-completed");
    expect(scoreFixture(fixture(), outcome({ status: "skipped" })).excludeReason).toBe("skipped");
  });
});

describe("aggregateScores", () => {
  const cat = (c: RiskCategory) => c;
  const sev = (s: Severity) => s;

  function scoredPair(): { fixtures: EvalFixture[]; outcomes: FixtureOutcome[] } {
    const fixtures = [
      fixture({ id: "a", expected: { categories: [cat("change_of_control")], ambiguous: false, evidence: [], rationale: "r" } }),
      fixture({
        id: "b",
        label: "negative",
        expected: { categories: [], ambiguous: false, evidence: [], rationale: "r" },
      }),
    ];
    const outcomes = [
      outcome({ fixtureId: "a", findings: [finding({ category: cat("change_of_control") })], latencyMs: 10 }),
      outcome({ fixtureId: "b", findings: [finding({ category: cat("uncapped_liability"), evidence: "other" })], latencyMs: 30 }),
    ];
    return { fixtures, outcomes };
  }

  it("computes micro, macro, and per-category metrics", () => {
    const { fixtures, outcomes } = scoredPair();
    const scores = fixtures.map((f, i) => scoreFixture(f, outcomes[i]));
    const agg = aggregateScores(fixtures, scores, outcomes);
    expect(agg.micro).toMatchObject({ tp: 1, fp: 1, fn: 0 });
    expect(agg.perCategory.change_of_control).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(agg.perCategory.uncapped_liability).toMatchObject({ precision: 0, recall: null, f1: 0 });
    expect(agg.perCategory.missing_signature).toMatchObject({ precision: null, recall: null, f1: null });
    expect(agg.macro.precision).toBeCloseTo(0.5, 6);
    expect(agg.falsePositivesPerNegative).toBe(1);
    expect(agg.negativeFixtureCount).toBe(1);
  });

  it("returns null false-positive rate with no negative fixtures", () => {
    const fixtures = [fixture({ id: "a" })];
    const outcomes = [outcome({ fixtureId: "a" })];
    const agg = aggregateScores(fixtures, [scoreFixture(fixtures[0], outcomes[0])], outcomes);
    expect(agg.falsePositivesPerNegative).toBeNull();
    expect(agg.negativeFixtureCount).toBe(0);
  });

  it("aggregates evidence, page, severity, and rejection metrics", () => {
    const fixtures = [
      fixture({
        id: "a",
        expected: {
          categories: [cat("change_of_control")],
          ambiguous: false,
          evidence: [{ category: cat("change_of_control"), quote: "quoted passage", pages: [1], severity: sev("high") }],
          rationale: "r",
        },
      }),
    ];
    const outcomes = [
      outcome({
        fixtureId: "a",
        findings: [finding({ evidence: "quoted passage here" })],
        droppedInvalid: 1,
        droppedUnverified: 1,
      }),
    ];
    const agg = aggregateScores(fixtures, [scoreFixture(fixtures[0], outcomes[0])], outcomes);
    expect(agg.evidenceMatchRate).toBe(1);
    expect(agg.pageAccuracy).toBe(1);
    expect(agg.severityAgreement).toBe(1);
    expect(agg.verificationRejectionRate).toBeCloseTo(2 / 3, 6);
    expect(agg.verifiedFindings).toBe(1);
    expect(agg.unsupportedCandidates).toBe(2);
  });

  it("excludes ambiguous and failed fixtures from detection but counts them", () => {
    const fixtures = [
      fixture({ id: "a" }),
      fixture({ id: "b", label: "challenging", expected: { categories: [cat("change_of_control")], ambiguous: true, evidence: [], rationale: "r" } }),
      fixture({ id: "c" }),
    ];
    const outcomes = [
      outcome({ fixtureId: "a", findings: [finding()] }),
      outcome({ fixtureId: "b" }),
      outcome({ fixtureId: "c", status: "failed", error: "boom" }),
    ];
    const agg = aggregateScores(
      fixtures,
      fixtures.map((f, i) => scoreFixture(f, outcomes[i])),
      outcomes,
    );
    expect(agg.micro).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(agg.counts).toMatchObject({ completed: 2, failed: 1, ambiguous: 1, total: 3 });
  });

  it("reports latency distribution with p95 gated on observation count", () => {
    const fixtures = Array.from({ length: 12 }, (_, i) => fixture({ id: `f${i}` }));
    const outcomes = fixtures.map((f, i) => outcome({ fixtureId: f.id, latencyMs: (i + 1) * 10 }));
    const agg = aggregateScores(
      fixtures,
      fixtures.map((f, i) => scoreFixture(f, outcomes[i])),
      outcomes,
    );
    expect(agg.latency).toMatchObject({ n: 12, min: 10, median: 65, max: 120 });
    expect(agg.latency.p95).toBe(120);

    const small = aggregateScores(
      [fixtures[0]],
      [scoreFixture(fixtures[0], outcomes[0])],
      [outcomes[0]],
    );
    expect(small.latency.p95).toBeNull();
  });

  it("sums token usage and reports cost as unavailable", () => {
    const fixtures = [fixture({ id: "a" }), fixture({ id: "b" })];
    const outcomes = [
      outcome({ fixtureId: "a", usage: { promptTokens: 100, completionTokens: 20 } }),
      outcome({ fixtureId: "b" }),
    ];
    const agg = aggregateScores(
      fixtures,
      fixtures.map((f, i) => scoreFixture(f, outcomes[i])),
      outcomes,
    );
    expect(agg.usage).toEqual({ fixturesWithUsage: 1, promptTokens: 100, completionTokens: 20 });
    expect(agg.costEstimate).toBe("unavailable");
  });
});
