import { describe, expect, it } from "vitest";
import type { EvalFixture, ExpectedEvidence } from "@/lib/eval/dataset";
import { aggregateScores, pageSpanEquals, scoreFixture } from "@/lib/eval/metrics";
import type { FixtureOutcome } from "@/lib/eval/types";
import type { RiskCategory, StoredFinding } from "@/lib/findings/schema";

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
    id: `123e4567-e89b-12d3-a456-42661419${String(4000 + counter).slice(-4)}`,
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

function expectedEvidence(overrides: Partial<ExpectedEvidence> = {}): ExpectedEvidence {
  return {
    category: "change_of_control",
    quote: "quoted passage",
    pages: [1],
    severity: "high",
    ...overrides,
  };
}

function fixture(overrides: Partial<EvalFixture> = {}): EvalFixture {
  return {
    id: "sx-01",
    label: "positive",
    title: "t",
    pages: [{ pageNumber: 1, text: "quoted passage" }],
    expected: { categories: ["change_of_control"], ambiguous: false, evidence: [], rationale: "r" },
    ...overrides,
  };
}

function outcome(overrides: Partial<FixtureOutcome> = {}): FixtureOutcome {
  return {
    fixtureId: "sx-01",
    status: "completed",
    latencyMs: 5,
    findings: [],
    droppedInvalid: 0,
    droppedUnverified: 0,
    sectionErrors: [],
    ...overrides,
  };
}

function scored(exp: ExpectedEvidence[], findings: StoredFinding[]) {
  const fx = fixture({
    expected: {
      categories: [...new Set(exp.map((e) => e.category))] as RiskCategory[],
      ambiguous: false,
      evidence: exp,
      rationale: "r",
    },
  });
  return scoreFixture(fx, outcome({ findings }));
}

describe("pageSpanEquals", () => {
  it("requires both ends to match the expected min/max exactly", () => {
    expect(pageSpanEquals(2, 4, [2, 3, 4])).toBe(true);
    expect(pageSpanEquals(2, 4, [4, 2])).toBe(true);
    expect(pageSpanEquals(2, 3, [2, 3, 4])).toBe(false);
    expect(pageSpanEquals(1, 4, [2, 3, 4])).toBe(false);
    expect(pageSpanEquals(1, 1, [1])).toBe(true);
    expect(pageSpanEquals(null, null, [1])).toBe(false);
    expect(pageSpanEquals(1, null, [1])).toBe(false);
    expect(pageSpanEquals(null, 1, [1])).toBe(false);
    expect(pageSpanEquals(1, 1, [])).toBe(false);
  });
});

describe("exact and normalized evidence matching", () => {
  it("exact match requires byte-for-byte equality", () => {
    const s = scored([expectedEvidence({ quote: "quoted passage" })], [
      finding({ evidence: "quoted passage" }),
    ]);
    expect(s.slots[0].evidenceExact).toBe(true);
    expect(s.slots[0].evidenceNormalized).toBe(true);
  });

  it("whitespace-only difference: normalized matches, exact does not", () => {
    const s = scored([expectedEvidence({ quote: "quoted passage" })], [
      finding({ evidence: "  quoted\t  passage\n" }),
    ]);
    expect(s.slots[0].evidenceExact).toBe(false);
    expect(s.slots[0].evidenceNormalized).toBe(true);
  });

  it("meaningful wording differences and negation never match", () => {
    const base = "The agreement may be assigned without consent";
    const neg = scored([expectedEvidence({ quote: base })], [
      finding({ evidence: "The agreement may not be assigned without consent" }),
    ]);
    expect(neg.slots[0].evidenceExact).toBe(false);
    expect(neg.slots[0].evidenceNormalized).toBe(false);
    const caseChange = scored([expectedEvidence({ quote: base })], [
      finding({ evidence: "the agreement may be assigned without consent" }),
    ]);
    expect(caseChange.slots[0].evidenceExact).toBe(false);
    expect(caseChange.slots[0].evidenceNormalized).toBe(false);
  });

  it("empty predicted evidence never matches strict metrics (legacy quirk pinned)", () => {
    const s = scored([expectedEvidence({ quote: "quoted passage" })], [
      finding({ evidence: "" }),
    ]);
    // Legacy containment: "" is a substring of every string, so the legacy
    // metric matches. This long-standing behavior is pinned, not changed.
    expect(s.slots[0].evidenceMatched).toBe(true);
    expect(s.slots[0].evidenceExact).toBe(false);
    expect(s.slots[0].evidenceNormalized).toBe(false);
  });

  it("no findings leaves every slot unmatched", () => {
    const s = scored([expectedEvidence({ quote: "quoted passage" })], []);
    expect(s.slots[0].evidenceMatched).toBe(false);
    expect(s.slots[0].evidenceExact).toBe(false);
    expect(s.slots[0].evidenceNormalized).toBe(false);
    expect(s.slots[0].pageCorrect).toBe(null);
    expect(s.slots[0].pageStrict).toBe(null);
    expect(s.slots[0].severityAgreed).toBe(null);
  });

  it("legacy containment still matches a sub-passage", () => {
    const s = scored([expectedEvidence({ quote: "short clause" })], [
      finding({ evidence: "the full contract text with a short clause embedded" }),
    ]);
    expect(s.slots[0].evidenceMatched).toBe(true);
    expect(s.slots[0].evidenceExact).toBe(false);
    expect(s.slots[0].evidenceNormalized).toBe(false);
  });
});

describe("duplicate and multi-slot assignment", () => {
  it("duplicate predictions collapse: one prediction cannot satisfy two slots", () => {
    const exp = [
      expectedEvidence({ quote: "first clause" }),
      expectedEvidence({ quote: "second clause" }),
    ];
    // One unique finding text matching only the first slot, duplicated.
    const dup1 = finding({ evidence: "first clause" });
    const dup2 = finding({ ...dup1, id: "123e4567-e89b-12d3-a456-426614199999" });
    const s = scored(exp, [dup1, dup2]);
    expect(s.duplicates).toBe(1);
    expect(s.slots.filter((x) => x.evidenceNormalized)).toHaveLength(1);
    expect(s.slots.filter((x) => x.evidenceExact)).toHaveLength(1);
  });

  it("multiple expected findings each need their own prediction", () => {
    const exp = [
      expectedEvidence({ quote: "first clause" }),
      expectedEvidence({ quote: "first clause plus more" }),
    ];
    const s = scored(exp, [finding({ evidence: "first clause" })]);
    const normalized = s.slots.filter((x) => x.evidenceNormalized);
    expect(normalized).toHaveLength(1);
    // Legacy containment may match either slot, but strict assignment consumes once.
    expect(s.slots[0].evidenceNormalized).toBe(true);
    expect(s.slots[1].evidenceNormalized).toBe(false);
  });

  it("category gating: cross-category quotes do not match", () => {
    const exp = [expectedEvidence({ category: "uncapped_liability", quote: "quoted passage" })];
    const s = scored(exp, [finding({ category: "change_of_control" })]);
    expect(s.slots[0].evidenceNormalized).toBe(false);
    expect(s.slots[0].evidenceExact).toBe(false);
  });
});

describe("strict page agreement", () => {
  it("single page: cited span must equal the expected page", () => {
    const match = scored([expectedEvidence({ pages: [2] })], [
      finding({ pageStart: 2, pageEnd: 2 }),
    ]);
    expect(match.slots[0].pageCorrect).toBe(true);
    expect(match.slots[0].pageStrict).toBe(true);
    const wider = scored([expectedEvidence({ pages: [2] })], [
      finding({ pageStart: 1, pageEnd: 3 }),
    ]);
    expect(wider.slots[0].pageCorrect).toBe(true);
    expect(wider.slots[0].pageStrict).toBe(false);
  });

  it("multi-page: cited span must equal min/max exactly", () => {
    const exact = scored([expectedEvidence({ pages: [2, 4] })], [
      finding({ pageStart: 2, pageEnd: 4 }),
    ]);
    expect(exact.slots[0].pageStrict).toBe(true);
    const narrow = scored([expectedEvidence({ pages: [2, 3, 4] })], [
      finding({ pageStart: 2, pageEnd: 3 }),
    ]);
    expect(narrow.slots[0].pageCorrect).toBe(true);
    expect(narrow.slots[0].pageStrict).toBe(false);
  });

  it("missing page values on a matched slot are strict misses, not exclusions", () => {
    const s = scored([expectedEvidence({ pages: [1] })], [
      finding({ pageStart: null, pageEnd: null }),
    ]);
    expect(s.slots[0].evidenceNormalized).toBe(true);
    expect(s.slots[0].pageCorrect).toBe(false);
    // Null is reserved for slots with no normalized match; a matched slot
    // with unusable pages counts as checked-and-failed.
    expect(s.slots[0].pageStrict).toBe(false);
    const half = scored([expectedEvidence({ pages: [1] })], [
      finding({ pageStart: 1, pageEnd: null }),
    ]);
    expect(half.slots[0].pageCorrect).toBe(false);
    expect(half.slots[0].pageStrict).toBe(false);
  });

  it("strict pages gate on a normalized evidence match", () => {
    const s = scored([expectedEvidence({ quote: "quoted passage", pages: [1] })], [
      finding({ evidence: "totally different wording", pageStart: 1, pageEnd: 1 }),
    ]);
    expect(s.slots[0].evidenceNormalized).toBe(false);
    expect(s.slots[0].pageStrict).toBe(null);
  });
});

describe("strict aggregate metrics", () => {
  function multiFixtureAggregate() {
    const fxA = fixture({
      id: "sx-a",
      expected: {
        categories: ["change_of_control"],
        ambiguous: false,
        evidence: [expectedEvidence({ quote: "clause A", pages: [1] })],
        rationale: "r",
      },
    });
    const fxB = fixture({
      id: "sx-b",
      expected: {
        categories: ["change_of_control"],
        ambiguous: false,
        evidence: [expectedEvidence({ quote: "clause  B", pages: [1] })],
        rationale: "r",
      },
    });
    const outA = outcome({
      fixtureId: "sx-a",
      findings: [finding({ evidence: "clause A", pageStart: 1, pageEnd: 1 })],
    });
    const outB = outcome({
      fixtureId: "sx-b",
      findings: [finding({ evidence: "clause   B", pageStart: 1, pageEnd: 2 })],
    });
    const scores = [scoreFixture(fxA, outA), scoreFixture(fxB, outB)];
    return aggregateScores([fxA, fxB], scores, [outA, outB]);
  }

  it("counts and rates are reported with explicit denominators", () => {
    const m = multiFixtureAggregate();
    expect(m.evidenceSlots).toBe(2);
    expect(m.evidenceExactMatched).toBe(1);
    expect(m.evidenceNormalizedMatched).toBe(2);
    expect(m.evidenceExactMatchRate).toBe(0.5);
    expect(m.evidenceNormalizedMatchRate).toBe(1);
    expect(m.pageStrictCorrect).toBe(1);
    expect(m.pageStrictChecked).toBe(2);
    expect(m.pageStrictAgreement).toBe(0.5);
  });

  it("zero denominators yield null rates", () => {
    const fx = fixture({
      id: "sx-empty",
      expected: { categories: [], ambiguous: false, evidence: [], rationale: "r" },
    });
    const out = outcome({ fixtureId: "sx-empty", findings: [] });
    const m = aggregateScores([fx], [scoreFixture(fx, out)], [out]);
    expect(m.evidenceExactMatchRate).toBeNull();
    expect(m.evidenceNormalizedMatchRate).toBeNull();
    expect(m.pageStrictAgreement).toBeNull();
    expect(m.evidenceMatchRate).toBeNull();
    expect(m.pageAccuracy).toBeNull();
  });
});
