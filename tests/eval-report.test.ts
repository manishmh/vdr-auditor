import { describe, expect, it } from "vitest";
import type { EvalFixture } from "@/lib/eval/dataset";
import {
  buildReport,
  computeRunId,
  METHODOLOGY_VERSION,
  parseEvalReportFile,
  renderMarkdown,
} from "@/lib/eval/report";
import type { FixtureOutcome } from "@/lib/eval/types";

const SECRET = "CONFIDENTIAL-MARKER-XYZZY";

function fixture(): EvalFixture {
  return {
    id: "fx-01",
    label: "positive",
    title: "t",
    pages: [{ pageNumber: 1, text: `contract text ${SECRET} quoted passage` }],
    expected: {
      categories: ["change_of_control"],
      ambiguous: false,
      evidence: [{ category: "change_of_control", quote: "quoted passage", pages: [1], severity: "high" }],
      rationale: "human-authored rationale",
    },
  };
}

function outcome(): FixtureOutcome {
  const now = new Date().toISOString();
  return {
    fixtureId: "fx-01",
    status: "completed",
    latencyMs: 7,
    findings: [
      {
        category: "change_of_control",
        severity: "high",
        title: "t",
        explanation: "e",
        evidence: "quoted passage",
        recommendedAction: "a",
        id: "123e4567-e89b-12d3-a456-426614174000",
        documentId: "123e4567-e89b-12d3-a456-426614174001",
        pageStart: 1,
        pageEnd: 1,
        status: "open",
        reviewerNote: null,
        modelId: "mock-v1",
        createdAt: now,
        updatedAt: now,
      },
    ],
    droppedInvalid: 0,
    droppedUnverified: 1,
    sectionErrors: [],
  };
}

describe("computeRunId", () => {
  it("is deterministic for identical inputs and sensitive to config", () => {
    const base = { datasetVersion: "1.0.0", fixtureIds: ["b", "a"], mode: "mock" as const, modelId: "mock-v1" };
    expect(computeRunId(base)).toBe(computeRunId({ ...base, fixtureIds: ["a", "b"] }));
    expect(computeRunId(base)).not.toBe(computeRunId({ ...base, mode: "live", modelId: "x/y" }));
    expect(computeRunId(base)).not.toBe(computeRunId({ ...base, fixtureIds: ["a"] }));
    expect(computeRunId(base)).toMatch(/^eval-[0-9a-f]{12}$/);
  });

  it("defaults an omitted methodology version to 1.0.0 and hashes it when given", () => {
    const base = { datasetVersion: "1.0.0", fixtureIds: ["a"], mode: "mock" as const, modelId: "mock-v1" };
    expect(computeRunId(base)).toBe(computeRunId({ ...base, methodologyVersion: "1.0.0" }));
    expect(computeRunId(base)).not.toBe(computeRunId({ ...base, methodologyVersion: "2.0.0" }));
  });
});

describe("buildReport", () => {
  it("builds aggregates and never embeds contract text", () => {
    const report = buildReport({
      datasetVersion: "1.0.0",
      mode: "mock",
      modelId: "mock-v1",
      fixtures: [fixture()],
      outcomes: [outcome()],
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(report.runId).toMatch(/^eval-/);
    expect(report.metrics.micro).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(report.metrics.verificationRejectionRate).toBeCloseTo(1 / 2, 6);
    expect(report.fixtures).toHaveLength(1);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("quoted passage");
    const markdown = renderMarkdown(report);
    expect(markdown).not.toContain(SECRET);
    expect(markdown).toContain("## Aggregate metrics");
    expect(markdown).toContain("## Per-category detection");
    expect(markdown).toContain("## Ambiguous fixtures (not scored)");
    expect(markdown).toContain("## Per-fixture outcomes");
    expect(markdown).toContain("## Methodology notes");
  });

  it("exposes section errors in rows and the markdown failures section", () => {
    const failed = outcome();
    failed.status = "failed";
    failed.findings = [];
    failed.error = "Analysis failed for all 1 section(s)";
    failed.sectionErrors = [{ sectionId: "s1", code: "incomplete", message: "cut off after 10 chars" }];
    const report = buildReport({
      datasetVersion: "1.0.0",
      mode: "live",
      modelId: "x/y",
      fixtures: [fixture()],
      outcomes: [failed],
    });
    expect(report.fixtures[0].sectionErrors).toEqual([
      { sectionId: "s1", code: "incomplete", message: "cut off after 10 chars" },
    ]);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("## Failed and partial fixture errors");
    expect(markdown).toContain("**fx-01** (failed)");
    expect(markdown).toContain("section s1 [incomplete]");
  });

  it("lists ambiguous fixtures separately with their rationale", () => {
    const amb = fixture();
    amb.id = "amb-01";
    amb.label = "challenging";
    amb.expected.ambiguous = true;
    const out = outcome();
    out.fixtureId = "amb-01";
    const report = buildReport({
      datasetVersion: "1.0.0",
      mode: "mock",
      modelId: "mock-v1",
      fixtures: [amb],
      outcomes: [out],
    });
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0]).toMatchObject({ id: "amb-01", detected: ["change_of_control"] });
    expect(report.metrics.micro).toMatchObject({ tp: 0, fp: 0, fn: 0 });
    expect(report.metrics.counts.ambiguous).toBe(1);
  });
});

describe("methodology versioning", () => {
  function built() {
    return buildReport({
      datasetVersion: "1.0.0",
      mode: "mock",
      modelId: "mock-v1",
      fixtures: [fixture()],
      outcomes: [outcome()],
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  }

  it("stamps new reports with the current methodology version", () => {
    const report = built();
    expect(report.methodologyVersion).toBe(METHODOLOGY_VERSION);
    expect(report.methodologyVersion).toBe("2.0.0");
  });

  it("exposes strict evidence and page counts on rows and aggregates", () => {
    const report = built();
    expect(report.fixtures[0]).toMatchObject({
      evidenceMatched: 1,
      evidenceTotal: 1,
      evidenceExactMatched: 1,
      evidenceNormalizedMatched: 1,
      pageCorrect: 1,
      pageChecked: 1,
      pageStrictCorrect: 1,
      pageStrictChecked: 1,
    });
    expect(report.metrics).toMatchObject({
      evidenceExactMatched: 1,
      evidenceNormalizedMatched: 1,
      evidenceExactMatchRate: 1,
      evidenceNormalizedMatchRate: 1,
      pageStrictCorrect: 1,
      pageStrictChecked: 1,
      pageStrictAgreement: 1,
    });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("- Methodology version: 2.0.0");
    expect(markdown).toContain("Evidence exact match rate");
    expect(markdown).toContain("Evidence normalized match rate");
    expect(markdown).toContain("Page strict agreement");
    expect(markdown).toContain("legacy containment");
    expect(markdown).toContain("legacy overlap");
  });

  it("produces byte-identical reports for identical inputs", () => {
    expect(JSON.stringify(built())).toBe(JSON.stringify(built()));
  });
});

describe("parseEvalReportFile", () => {
  it("reads old reports without a methodology version as 1.0.0", () => {
    const legacy = {
      runId: "eval-abcdef123456",
      datasetVersion: "1.0.0",
      mode: "mock",
      modelId: "mock-v1",
      timestamp: "2025-01-01T00:00:00.000Z",
      metrics: { evidenceMatchRate: 0.5 },
      fixtures: [{ id: "fx-01", evidenceMatched: 1, evidenceTotal: 2 }],
      ambiguous: [],
      notes: [],
    };
    const parsed = parseEvalReportFile(legacy);
    expect(parsed.methodologyVersion).toBe("1.0.0");
    expect(parsed.runId).toBe("eval-abcdef123456");
    expect(parsed.metrics).toMatchObject({ evidenceMatchRate: 0.5 });
    expect(parsed.fixtures[0]).toMatchObject({ id: "fx-01" });
  });

  it("round-trips current reports including strict fields", () => {
    const report = buildReport({
      datasetVersion: "1.0.0",
      mode: "mock",
      modelId: "mock-v1",
      fixtures: [fixture()],
      outcomes: [outcome()],
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const parsed = parseEvalReportFile(JSON.parse(JSON.stringify(report)));
    expect(parsed.methodologyVersion).toBe("2.0.0");
    expect(parsed.metrics).toMatchObject({ evidenceExactMatched: 1, pageStrictChecked: 1 });
    expect(parsed.fixtures[0]).toMatchObject({ evidenceExactMatched: 1, pageStrictCorrect: 1 });
  });
});
