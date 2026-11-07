import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalFixture } from "@/lib/eval/dataset";
import { runFixtures } from "@/lib/eval/runner";
import { MockInferenceProvider } from "@/lib/inference/mock";
import type { AnalyzeResult, InferenceProvider } from "@/lib/inference/types";

function fixture(id: string, text: string): EvalFixture {
  return {
    id,
    label: "positive",
    title: "t",
    pages: [{ pageNumber: 1, text }],
    expected: { categories: ["change_of_control"], ambiguous: false, evidence: [], rationale: "r" },
  };
}

const TEXT = "In the event of a change of control, consent is required. Signature: Tester.";

/** Outcome shape minus volatile ids, timestamps, and latency. */
function stableShape(outcomes: { status: string; findings: { category: string; severity: string; evidence: string; pageStart: number | null; pageEnd: number | null }[]; droppedInvalid: number; droppedUnverified: number; sectionErrors: { sectionId: string; message: string }[] }[]) {
  return outcomes.map((o) => ({
    status: o.status,
    findings: o.findings.map((f) => ({
      category: f.category,
      severity: f.severity,
      evidence: f.evidence,
      pageStart: f.pageStart,
      pageEnd: f.pageEnd,
    })),
    droppedInvalid: o.droppedInvalid,
    droppedUnverified: o.droppedUnverified,
    sectionErrors: o.sectionErrors,
  }));
}

describe("runFixtures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the production pipeline per fixture with mock determinism", async () => {
    const fixtures = [fixture("b", TEXT), fixture("a", TEXT)];
    const first = await runFixtures({ fixtures, mode: "mock", makeProvider: () => new MockInferenceProvider() });
    const second = await runFixtures({ fixtures, mode: "mock", makeProvider: () => new MockInferenceProvider() });
    expect(first.modelId).toBe("mock-v1");
    expect(first.outcomes.map((o) => o.status)).toEqual(["completed", "completed"]);
    expect(first.outcomes[0].findings).toHaveLength(1);
    expect(stableShape(second.outcomes)).toEqual(stableShape(first.outcomes));
  });

  it("never touches the network in mock mode", async () => {
    vi.stubGlobal(
      "fetch",
      (() => {
        throw new Error("network access attempted");
      }) as unknown as typeof fetch,
    );
    const run = await runFixtures({
      fixtures: [fixture("a", TEXT)],
      mode: "mock",
      makeProvider: () => new MockInferenceProvider(),
    });
    expect(run.outcomes[0].status).toBe("completed");
  });

  it("marks skipped fixtures without running them", async () => {
    const run = await runFixtures({
      fixtures: [fixture("a", TEXT)],
      mode: "mock",
      makeProvider: () => new MockInferenceProvider(),
      only: ["something-else"],
    });
    expect(run.outcomes).toHaveLength(1);
    expect(run.outcomes[0]).toMatchObject({ fixtureId: "a", status: "skipped", latencyMs: 0 });
  });

  it("captures provider throws and section errors as failed or partial", async () => {
    const throwing: InferenceProvider = {
      modelId: "throwing",
      analyze: async (): Promise<AnalyzeResult> => {
        throw new Error("model exploded");
      },
    };
    const failed = await runFixtures({
      fixtures: [fixture("a", TEXT)],
      mode: "mock",
      makeProvider: () => throwing,
    });
    expect(failed.outcomes[0].status).toBe("failed");
    expect(failed.outcomes[0].error).toMatch(/model exploded/);

    const flaky: InferenceProvider = {
      modelId: "flaky",
      analyze: async (): Promise<AnalyzeResult> => ({ findings: [], sectionErrors: [{ sectionId: "s1", message: "boom" }] }),
    };
    const partial = await runFixtures({
      fixtures: [fixture("a", `${TEXT} ${"Extra sentence to force a second section. ".repeat(200)}`)],
      mode: "mock",
      makeProvider: () => flaky,
    });
    expect(partial.outcomes[0].status).toBe("partial");
    expect(partial.outcomes[0].sectionErrors).toHaveLength(1);
  });

  it("records empty findings as completed, not failed", async () => {
    const quiet: InferenceProvider = {
      modelId: "quiet",
      analyze: async (): Promise<AnalyzeResult> => ({ findings: [], sectionErrors: [] }),
    };
    const run = await runFixtures({
      fixtures: [fixture("a", TEXT)],
      mode: "mock",
      makeProvider: () => quiet,
    });
    expect(run.outcomes[0].status).toBe("completed");
    expect(run.outcomes[0].findings).toHaveLength(0);
  });
});
