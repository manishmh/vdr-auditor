import { normalizeText } from "../evidence";
import type { RiskCategory, Severity, StoredFinding } from "../findings/schema";
import { RISK_CATEGORY_IDS } from "../risks";
import type { EvalFixture, ExpectedEvidence } from "./dataset";
import type { FixtureOutcome, TokenUsage } from "./types";

/** Severity ranks for agreement checks: adjacent severities agree (tolerance 1). */
export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Documented tolerance: model and expected severity agree when ranks differ by at most this. */
export const SEVERITY_TOLERANCE = 1;

/** p95 is reported only with at least this many latency observations, else null. */
export const P95_MIN_OBSERVATIONS = 10;

export interface EvidenceSlotScore {
  category: RiskCategory;
  /** Legacy containment match (methodology 1.0.0 semantics, unchanged). */
  evidenceMatched: boolean;
  /** Strict byte-for-byte evidence equality, via one-to-one slot assignment. */
  evidenceExact: boolean;
  /** Strict normalized evidence equality, via one-to-one slot assignment. */
  evidenceNormalized: boolean;
  /** Legacy overlap page check. Null when unmatched. */
  pageCorrect: boolean | null;
  /** Strict page-span equality on normalized-matched slots. Null when unmatched. */
  pageStrict: boolean | null;
  /** Severity ranks within SEVERITY_TOLERANCE. Null when unmatched. */
  severityAgreed: boolean | null;
}

export interface FixtureScore {
  fixtureId: string;
  status: FixtureOutcome["status"];
  /** True when excluded from aggregate detection metrics (ambiguous or not completed). */
  excluded: boolean;
  excludeReason: "ambiguous" | "not-completed" | "skipped" | null;
  expectedCategories: RiskCategory[];
  detectedCategories: RiskCategory[];
  truePositives: RiskCategory[];
  falsePositives: RiskCategory[];
  falseNegatives: RiskCategory[];
  slots: EvidenceSlotScore[];
  /** Verified findings removed as exact (category, evidence) duplicates. */
  duplicates: number;
  /** Model candidates rejected by schema validation or evidence verification. */
  unsupported: number;
  latencyMs: number;
}

export interface Prf {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  tp: number;
  fp: number;
  fn: number;
}

export interface AggregateMetrics {
  perCategory: Record<RiskCategory, Prf>;
  macro: { precision: number | null; recall: number | null; f1: number | null };
  micro: Prf;
  /** Deduped false-positive findings per completed, expected-empty, non-ambiguous fixture. */
  falsePositivesPerNegative: number | null;
  negativeFixtureCount: number;
  evidenceMatchRate: number | null;
  evidenceSlots: number;
  evidenceMatched: number;
  evidenceExactMatchRate: number | null;
  evidenceExactMatched: number;
  evidenceNormalizedMatchRate: number | null;
  evidenceNormalizedMatched: number;
  pageAccuracy: number | null;
  pageChecked: number;
  pageCorrect: number;
  pageStrictAgreement: number | null;
  pageStrictChecked: number;
  pageStrictCorrect: number;
  severityAgreement: number | null;
  severityChecked: number;
  severityAgreed: number;
  severityTolerance: number;
  /** Rejected candidates / (verified findings + rejected candidates). */
  verificationRejectionRate: number | null;
  verifiedFindings: number;
  unsupportedCandidates: number;
  counts: { completed: number; partial: number; failed: number; skipped: number; ambiguous: number; total: number };
  latency: { n: number; min: number | null; median: number | null; p95: number | null; max: number | null };
  usage: TokenUsage;
  /** Always "unavailable": no pricing data is available to the harness. */
  costEstimate: "unavailable";
}

/** Dedupe verified findings by (category, normalized evidence). First occurrence wins. */
export function dedupeFindings(findings: StoredFinding[]): { unique: StoredFinding[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: StoredFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.category}||${normalizeText(finding.evidence).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return { unique, duplicates: findings.length - unique.length };
}

/** Score one fixture. Detection uses category sets; evidence uses passage containment. */
export function scoreFixture(fixture: EvalFixture, outcome: FixtureOutcome): FixtureScore {
  const { unique } = dedupeFindings(outcome.findings);
  const detected = [...new Set(unique.map((f) => f.category))].sort() as RiskCategory[];
  const expected = [...fixture.expected.categories].sort() as RiskCategory[];
  const detectedSet = new Set(detected);
  const expectedSet = new Set(expected);

  const exactAssignment = assignSlots(
    fixture.expected.evidence,
    unique,
    (quote, evidence) => quote.length > 0 && quote === evidence,
  );
  const normalizedAssignment = assignSlots(
    fixture.expected.evidence,
    unique,
    (quote, evidence) => {
      const a = normalizeText(quote);
      const b = normalizeText(evidence);
      return a.length > 0 && a === b;
    },
  );
  const slots = fixture.expected.evidence.map((slot, index) =>
    scoreSlot(slot, unique, exactAssignment.get(index) ?? null, normalizedAssignment.get(index) ?? null),
  );
  const excluded = fixture.expected.ambiguous || outcome.status !== "completed";
  return {
    fixtureId: fixture.id,
    status: outcome.status,
    excluded,
    excludeReason: outcome.status === "skipped" ? "skipped" : fixture.expected.ambiguous ? "ambiguous" : outcome.status !== "completed" ? "not-completed" : null,
    expectedCategories: expected,
    detectedCategories: detected,
    truePositives: expected.filter((c) => detectedSet.has(c)),
    falsePositives: detected.filter((c) => !expectedSet.has(c)),
    falseNegatives: expected.filter((c) => !detectedSet.has(c)),
    slots,
    duplicates: outcome.findings.length - unique.length,
    unsupported: outcome.droppedInvalid + outcome.droppedUnverified,
    latencyMs: outcome.latencyMs,
  };
}

function scoreSlot(
  slot: ExpectedEvidence,
  findings: StoredFinding[],
  exactMatch: StoredFinding | null,
  normalizedMatch: StoredFinding | null,
): EvidenceSlotScore {
  const wanted = normalizeText(slot.quote).toLowerCase();
  const match = findings.find(
    (f) =>
      f.category === slot.category &&
      (normalizeText(f.evidence).toLowerCase().includes(wanted) ||
        wanted.includes(normalizeText(f.evidence).toLowerCase())),
  );
  const base = {
    category: slot.category,
    evidenceExact: exactMatch !== null,
    evidenceNormalized: normalizedMatch !== null,
    pageStrict:
      normalizedMatch === null ? null : pageSpanEquals(normalizedMatch.pageStart, normalizedMatch.pageEnd, slot.pages),
  };
  if (!match) {
    return { ...base, evidenceMatched: false, pageCorrect: null, severityAgreed: null };
  }
  return {
    ...base,
    evidenceMatched: true,
    pageCorrect: pageOverlaps(match.pageStart, match.pageEnd, slot.pages),
    severityAgreed: Math.abs(SEVERITY_RANK[match.severity] - SEVERITY_RANK[slot.severity]) <= SEVERITY_TOLERANCE,
  };
}

/**
 * Greedy one-to-one slot assignment: slots in fixture order consume the first
 * still-unused deduped finding of the same category satisfying the predicate.
 * Findings or quotes empty after normalization never match.
 */
function assignSlots(
  slots: ExpectedEvidence[],
  findings: StoredFinding[],
  predicate: (quote: string, evidence: string) => boolean,
): Map<number, StoredFinding> {
  const assigned = new Map<number, StoredFinding>();
  const used = new Set<StoredFinding>();
  slots.forEach((slot, index) => {
    const match = findings.find(
      (f) => f.category === slot.category && !used.has(f) && predicate(slot.quote, f.evidence),
    );
    if (match) {
      used.add(match);
      assigned.set(index, match);
    }
  });
  return assigned;
}

/**
 * Strict page agreement: the predicted range must equal the expected span
 * exactly (min and max of the expected pages). Null values never match.
 */
export function pageSpanEquals(
  pageStart: number | null,
  pageEnd: number | null,
  expected: number[],
): boolean {
  if (pageStart === null || pageEnd === null || expected.length === 0) return false;
  return pageStart === Math.min(...expected) && pageEnd === Math.max(...expected);
}

/**
 * Page check passes when the finding's cited page range covers at least one
 * expected page. Context-expanded evidence may legitimately start on an
 * earlier page; the question is whether the reviewer is pointed at the
 * right page, not whether the range starts there.
 */
function pageOverlaps(
  pageStart: number | null,
  pageEnd: number | null,
  expected: number[],
): boolean {
  if (pageStart === null || pageEnd === null) return false;
  for (let page = pageStart; page <= pageEnd; page++) {
    if (expected.includes(page)) return true;
  }
  return false;
}

/** Aggregate fixture scores. Only completed, non-ambiguous, non-skipped fixtures feed detection metrics. */
export function aggregateScores(
  fixtures: EvalFixture[],
  scores: FixtureScore[],
  outcomes: FixtureOutcome[],
): AggregateMetrics {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const scored = scores.filter((s) => !s.excluded);
  const counts = {
    completed: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    ambiguous: 0,
    total: scores.length,
  };
  for (const score of scores) {
    counts[score.status] += 1;
    if (byId.get(score.fixtureId)?.expected.ambiguous) counts.ambiguous += 1;
  }

  const perCategory = Object.fromEntries(
    RISK_CATEGORY_IDS.map((category) => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const score of scored) {
        if (score.truePositives.includes(category)) tp += 1;
        if (score.falsePositives.includes(category)) fp += 1;
        if (score.falseNegatives.includes(category)) fn += 1;
      }
      return [category, prf(tp, fp, fn)];
    }),
  ) as Record<RiskCategory, Prf>;

  const micro = prf(
    Object.values(perCategory).reduce((sum, m) => sum + m.tp, 0),
    Object.values(perCategory).reduce((sum, m) => sum + m.fp, 0),
    Object.values(perCategory).reduce((sum, m) => sum + m.fn, 0),
  );
  const macro = {
    precision: mean(Object.values(perCategory).map((m) => m.precision)),
    recall: mean(Object.values(perCategory).map((m) => m.recall)),
    f1: mean(Object.values(perCategory).map((m) => m.f1)),
  };

  const negativeScores = scored.filter((s) => s.expectedCategories.length === 0);
  const negativeFp = negativeScores.reduce((sum, s) => sum + s.falsePositives.length, 0);
  const falsePositivesPerNegative =
    negativeScores.length > 0 ? negativeFp / negativeScores.length : null;

  let evidenceMatched = 0;
  let evidenceSlots = 0;
  let evidenceExactMatched = 0;
  let evidenceNormalizedMatched = 0;
  let pageCorrect = 0;
  let pageChecked = 0;
  let pageStrictCorrect = 0;
  let pageStrictChecked = 0;
  let severityAgreed = 0;
  let severityChecked = 0;
  for (const score of scored) {
    for (const slot of score.slots) {
      evidenceSlots += 1;
      if (slot.evidenceExact) evidenceExactMatched += 1;
      if (slot.evidenceNormalized) evidenceNormalizedMatched += 1;
      if (slot.pageStrict !== null) {
        pageStrictChecked += 1;
        if (slot.pageStrict) pageStrictCorrect += 1;
      }
      if (!slot.evidenceMatched) continue;
      evidenceMatched += 1;
      if (slot.pageCorrect !== null) {
        pageChecked += 1;
        if (slot.pageCorrect) pageCorrect += 1;
      }
      if (slot.severityAgreed !== null) {
        severityChecked += 1;
        if (slot.severityAgreed) severityAgreed += 1;
      }
    }
  }

  const outcomeById = new Map(outcomes.map((o) => [o.fixtureId, o]));
  const verifiedFindings = scored.reduce(
    (sum, s) => sum + (outcomeById.get(s.fixtureId)?.findings.length ?? 0),
    0,
  );
  const unsupportedCandidates = scored.reduce((sum, s) => sum + s.unsupported, 0);
  const verificationDenominator = verifiedFindings + unsupportedCandidates;

  const latencies = scores
    .filter((s) => s.status !== "skipped")
    .map((s) => s.latencyMs)
    .sort((a, b) => a - b);

  const usage: TokenUsage = { fixturesWithUsage: 0, promptTokens: 0, completionTokens: 0 };
  for (const outcome of outcomes) {
    if (!outcome.usage) continue;
    usage.fixturesWithUsage += 1;
    usage.promptTokens += outcome.usage.promptTokens ?? 0;
    usage.completionTokens += outcome.usage.completionTokens ?? 0;
  }

  return {
    perCategory,
    macro,
    micro,
    falsePositivesPerNegative,
    negativeFixtureCount: negativeScores.length,
    evidenceMatchRate: evidenceSlots > 0 ? evidenceMatched / evidenceSlots : null,
    evidenceSlots,
    evidenceMatched,
    evidenceExactMatchRate: evidenceSlots > 0 ? evidenceExactMatched / evidenceSlots : null,
    evidenceExactMatched,
    evidenceNormalizedMatchRate: evidenceSlots > 0 ? evidenceNormalizedMatched / evidenceSlots : null,
    evidenceNormalizedMatched,
    pageAccuracy: pageChecked > 0 ? pageCorrect / pageChecked : null,
    pageChecked,
    pageCorrect,
    pageStrictAgreement: pageStrictChecked > 0 ? pageStrictCorrect / pageStrictChecked : null,
    pageStrictChecked,
    pageStrictCorrect,
    severityAgreement: severityChecked > 0 ? severityAgreed / severityChecked : null,
    severityChecked,
    severityAgreed,
    severityTolerance: SEVERITY_TOLERANCE,
    verificationRejectionRate:
      verificationDenominator > 0 ? unsupportedCandidates / verificationDenominator : null,
    verifiedFindings,
    unsupportedCandidates,
    counts,
    latency: {
      n: latencies.length,
      min: latencies.length > 0 ? latencies[0] : null,
      median: median(latencies),
      p95: latencies.length >= P95_MIN_OBSERVATIONS ? percentile(latencies, 95) : null,
      max: latencies.length > 0 ? latencies[latencies.length - 1] : null,
    },
    usage,
    costEstimate: "unavailable",
  };
}

export function prf(tp: number, fp: number, fn: number): Prf {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : precision === 0 || recall === 0
      ? 0
      : null;
  return { precision, recall, f1, tp, fp, fn };
}

export function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile over ascending-sorted values. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

function mean(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, v) => sum + v, 0) / present.length;
}
