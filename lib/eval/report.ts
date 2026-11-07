import { createHash } from "node:crypto";
import { z } from "zod";
import type { RiskCategory } from "../findings/schema";
import { RISK_CATEGORY_IDS } from "../risks";
import type { EvalFixture } from "./dataset";
import { aggregateScores, scoreFixture, type AggregateMetrics, type FixtureScore } from "./metrics";
import type { FixtureOutcome } from "./types";

/**
 * Evaluation methodology version stamped on every new report. `1.0.0` reports
 * carry legacy metrics only (containment evidence, overlap pages); `2.0.0`
 * adds strict evidence/page metrics without changing any legacy field.
 */
export const METHODOLOGY_VERSION = "2.0.0";

export interface FixtureReportRow {
  id: string;
  label: EvalFixture["label"];
  ambiguous: boolean;
  status: FixtureOutcome["status"];
  latencyMs: number;
  expected: RiskCategory[];
  detected: RiskCategory[];
  tp: RiskCategory[];
  fp: RiskCategory[];
  fn: RiskCategory[];
  evidenceMatched: number;
  evidenceTotal: number;
  evidenceExactMatched: number;
  evidenceNormalizedMatched: number;
  pageCorrect: number;
  pageChecked: number;
  pageStrictCorrect: number;
  pageStrictChecked: number;
  severityAgreed: number;
  severityChecked: number;
  duplicates: number;
  unsupported: number;
  error?: string;
  sectionErrors: { sectionId: string; code?: string; message: string }[];
}

export interface AmbiguousReportRow {
  id: string;
  title: string;
  status: FixtureOutcome["status"];
  /** Reference labels only — not scored. */
  expectedReference: RiskCategory[];
  detected: RiskCategory[];
  rationale: string;
}

export interface EvalReport {
  runId: string;
  datasetVersion: string;
  methodologyVersion: string;
  mode: "mock" | "live";
  modelId: string | null;
  timestamp: string;
  metrics: AggregateMetrics;
  fixtures: FixtureReportRow[];
  ambiguous: AmbiguousReportRow[];
  notes: string[];
}

/**
 * Deterministic run identifier: same dataset version, executed fixtures, mode,
 * model, and methodology version always yields the same id. The timestamp is
 * informational only. Methodology is part of the hash so v1 and v2 reports for
 * the same run never collide.
 */
export function computeRunId(input: {
  datasetVersion: string;
  fixtureIds: string[];
  mode: "mock" | "live";
  modelId: string | null;
  methodologyVersion?: string;
}): string {
  const canonical = JSON.stringify({
    datasetVersion: input.datasetVersion,
    fixtureIds: [...input.fixtureIds].sort(),
    mode: input.mode,
    modelId: input.modelId,
    methodologyVersion: input.methodologyVersion ?? "1.0.0",
  });
  return `eval-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

/**
 * Tolerant report reader: old reports without `methodologyVersion` or newer
 * metric/row fields still parse, defaulting to methodology `1.0.0`. Unknown
 * fields are preserved, never rejected.
 */
const EvalReportFileSchema = z
  .object({
    runId: z.string(),
    datasetVersion: z.string(),
    methodologyVersion: z.string().default("1.0.0"),
    mode: z.enum(["mock", "live"]),
    modelId: z.string().nullable(),
    timestamp: z.string(),
    metrics: z.record(z.string(), z.unknown()),
    fixtures: z.array(z.record(z.string(), z.unknown())).default([]),
    ambiguous: z.array(z.record(z.string(), z.unknown())).default([]),
    notes: z.array(z.string()).default([]),
  })
  .passthrough();

export type ParsedEvalReport = z.infer<typeof EvalReportFileSchema>;

export function parseEvalReportFile(json: unknown): ParsedEvalReport {
  return EvalReportFileSchema.parse(json);
}

export function buildReport(args: {
  datasetVersion: string;
  mode: "mock" | "live";
  modelId: string | null;
  fixtures: EvalFixture[];
  outcomes: FixtureOutcome[];
  timestamp?: string;
}): EvalReport {
  const byFixture = new Map(args.fixtures.map((f) => [f.id, f]));
  const scores: FixtureScore[] = [];
  const executedIds: string[] = [];
  for (const outcome of args.outcomes) {
    const fixture = byFixture.get(outcome.fixtureId);
    if (!fixture) continue;
    if (outcome.status !== "skipped") executedIds.push(fixture.id);
    scores.push(scoreFixture(fixture, outcome));
  }
  const metrics = aggregateScores(args.fixtures, scores, args.outcomes);
  const fixtures: FixtureReportRow[] = scores.map((score) => {
    const fixture = byFixture.get(score.fixtureId);
    const outcome = args.outcomes.find((o) => o.fixtureId === score.fixtureId);
    return {
      id: score.fixtureId,
      label: fixture?.label ?? "positive",
      ambiguous: fixture?.expected.ambiguous ?? false,
      status: score.status,
      latencyMs: score.latencyMs,
      expected: score.expectedCategories,
      detected: score.detectedCategories,
      tp: score.truePositives,
      fp: score.falsePositives,
      fn: score.falseNegatives,
      evidenceMatched: score.slots.filter((s) => s.evidenceMatched).length,
      evidenceTotal: score.slots.length,
      evidenceExactMatched: score.slots.filter((s) => s.evidenceExact).length,
      evidenceNormalizedMatched: score.slots.filter((s) => s.evidenceNormalized).length,
      pageCorrect: score.slots.filter((s) => s.pageCorrect === true).length,
      pageChecked: score.slots.filter((s) => s.pageCorrect !== null).length,
      pageStrictCorrect: score.slots.filter((s) => s.pageStrict === true).length,
      pageStrictChecked: score.slots.filter((s) => s.pageStrict !== null).length,
      severityAgreed: score.slots.filter((s) => s.severityAgreed === true).length,
      severityChecked: score.slots.filter((s) => s.severityAgreed !== null).length,
      duplicates: score.duplicates,
      unsupported: score.unsupported,
      error: outcome?.error,
      sectionErrors: (outcome?.sectionErrors ?? []).map((e) => ({
        sectionId: e.sectionId,
        code: e.code,
        message: e.message,
      })),
    };
  });
  const ambiguous: AmbiguousReportRow[] = args.fixtures
    .filter((f) => f.expected.ambiguous)
    .map((f) => {
      const score = scores.find((s) => s.fixtureId === f.id);
      return {
        id: f.id,
        title: f.title,
        status: score?.status ?? "skipped",
        expectedReference: [...f.expected.categories],
        detected: score?.detectedCategories ?? [],
        rationale: f.expected.rationale,
      };
    });
  return {
    runId: computeRunId({
      datasetVersion: args.datasetVersion,
      fixtureIds: executedIds,
      mode: args.mode,
      modelId: args.modelId,
      methodologyVersion: METHODOLOGY_VERSION,
    }),
    datasetVersion: args.datasetVersion,
    methodologyVersion: METHODOLOGY_VERSION,
    mode: args.mode,
    modelId: args.modelId,
    timestamp: args.timestamp ?? new Date().toISOString(),
    metrics,
    fixtures,
    ambiguous,
    notes: [
      "Detection metrics cover completed, non-ambiguous fixtures only. Partial/failed runs are counted, never scored as clean.",
      "Ambiguous fixtures are executed but reported separately; their labels are reference only.",
      `Severity agreement tolerance: ranks within ${metrics.severityTolerance} agree (low < medium < high < critical).`,
      "Evidence match (legacy containment) = expected passage contained verbatim (whitespace-normalized) in verified finding evidence, or vice versa.",
      "Evidence exact/normalized = byte-for-byte / whitespace-normalized equality via one-to-one slot assignment.",
      "Page check (legacy overlap) passes when the cited range covers an expected page; strict pages require the exact span.",
      "Rates with zero denominators are null (n/a), never 0% or 100%.",
      "Cost estimate is unavailable: the harness has no pricing data.",
      "Synthetic-fixture performance does not predict real-world legal accuracy.",
    ],
  };
}

function fmt(value: number | null, digits = 3): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

export function renderMarkdown(report: EvalReport): string {
  const m = report.metrics;
  const lines: string[] = [
    `# Evaluation report: ${report.runId}`,
    "",
    `- Dataset version: ${report.datasetVersion}`,
    `- Methodology version: ${report.methodologyVersion}`,
    `- Mode: ${report.mode}`,
    `- Model: ${report.modelId ?? "n/a"}`,
    `- Timestamp: ${report.timestamp}`,
    "",
    "## Aggregate metrics",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Micro precision / recall / F1 | ${fmt(m.micro.precision)} / ${fmt(m.micro.recall)} / ${fmt(m.micro.f1)} |`,
    `| Macro precision / recall / F1 | ${fmt(m.macro.precision)} / ${fmt(m.macro.recall)} / ${fmt(m.macro.f1)} |`,
    `| False positives per negative fixture | ${fmt(m.falsePositivesPerNegative)} (n=${m.negativeFixtureCount}) |`,
    `| Evidence match rate (legacy containment) | ${fmt(m.evidenceMatchRate)} (${m.evidenceMatched}/${m.evidenceSlots}) |`,
    `| Evidence exact match rate | ${fmt(m.evidenceExactMatchRate)} (${m.evidenceExactMatched}/${m.evidenceSlots}) |`,
    `| Evidence normalized match rate | ${fmt(m.evidenceNormalizedMatchRate)} (${m.evidenceNormalizedMatched}/${m.evidenceSlots}) |`,
    `| Page accuracy (legacy overlap) | ${fmt(m.pageAccuracy)} (${m.pageCorrect}/${m.pageChecked}) |`,
    `| Page strict agreement | ${fmt(m.pageStrictAgreement)} (${m.pageStrictCorrect}/${m.pageStrictChecked}) |`,
    `| Severity agreement (tol. ${m.severityTolerance}) | ${fmt(m.severityAgreement)} (${m.severityAgreed}/${m.severityChecked}) |`,
    `| Verification rejection rate | ${fmt(m.verificationRejectionRate)} (${m.unsupportedCandidates} rejected / ${m.verifiedFindings} verified) |`,
    `| Latency median / p95 | ${m.latency.median ?? "n/a"} / ${m.latency.p95 ?? "n/a"} ms (n=${m.latency.n}) |`,
    `| Token usage | ${m.usage.fixturesWithUsage} fixture(s), ${m.usage.promptTokens} prompt / ${m.usage.completionTokens} completion |`,
    `| Cost estimate | ${m.costEstimate} |`,
    `| Completed / partial / failed / skipped | ${m.counts.completed} / ${m.counts.partial} / ${m.counts.failed} / ${m.counts.skipped} |`,
    "",
    "## Per-category detection",
    "",
    "| Category | Precision | Recall | F1 | TP | FP | FN |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...RISK_CATEGORY_IDS.map((c) => {
      const p = m.perCategory[c];
      return `| ${c} | ${fmt(p.precision)} | ${fmt(p.recall)} | ${fmt(p.f1)} | ${p.tp} | ${p.fp} | ${p.fn} |`;
    }),
    "",
    "## Ambiguous fixtures (not scored)",
    "",
  ];
  if (report.ambiguous.length === 0) {
    lines.push("None.", "");
  } else {
    for (const row of report.ambiguous) {
      lines.push(
        `- **${row.id}** (${row.status}): expected reference [${row.expectedReference.join(", ") || "none"}], detected [${row.detected.join(", ") || "none"}] — ${row.rationale}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Per-fixture outcomes",
    "",
    "| Fixture | Label | Status | Expected | Detected | TP/FP/FN | Ev | Ex | Nx | Pg | Ps | Sev | ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.fixtures.map(
      (f) =>
        `| ${f.id} | ${f.label}${f.ambiguous ? "*" : ""} | ${f.status} | ${f.expected.join(",") || "—"} | ${f.detected.join(",") || "—"} | ${f.tp.length}/${f.fp.length}/${f.fn.length} | ${f.evidenceMatched}/${f.evidenceTotal} | ${f.evidenceExactMatched}/${f.evidenceTotal} | ${f.evidenceNormalizedMatched}/${f.evidenceTotal} | ${f.pageCorrect}/${f.pageChecked} | ${f.pageStrictCorrect}/${f.pageStrictChecked} | ${f.severityAgreed}/${f.severityChecked} | ${f.latencyMs} |`,
    ),
    "",
    "Asterisk (*) marks ambiguous fixtures, excluded from aggregates.",
    "Ev = legacy containment matches; Ex = exact matches; Nx = normalized matches;",
    "Pg = legacy overlap pages; Ps = strict pages (exact span).",
    "",
    "## Failed and partial fixture errors",
    "",
    ...(report.fixtures.some((f) => f.status === "failed" || f.status === "partial")
      ? report.fixtures
          .filter((f) => f.status === "failed" || f.status === "partial")
          .flatMap((f) => [
            `- **${f.id}** (${f.status}): ${f.error ?? "no detail"}`,
            ...f.sectionErrors.map((e) => `  - section ${e.sectionId}${e.code ? ` [${e.code}]` : ""}: ${e.message}`),
          ])
      : ["None — every executed fixture completed."]),
    "",
    "## Methodology notes",
    "",
    ...report.notes.map((n) => `- ${n}`),
    "",
  );
  return lines.join("\n");
}
