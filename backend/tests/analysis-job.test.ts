import { ObjectId, type Collection } from "mongodb";
import { beforeEach, describe, expect, it } from "vitest";
import { runAnalysisJob } from "../src/ai/job.js";
import { MetaError } from "../src/ai/metaClient.js";
import type { AnalysisRunRecord, FindingRecord } from "../src/models/analysis.js";
import type { DocumentRecord } from "../src/models/document.js";
import { createAnalysesFake, type AnalysesFake } from "./analyses-fake.js";

const MATTER_ID = new ObjectId("64f1a2b3c4d5e6f7890abc01");
const DOC_ID = new ObjectId("64f1a2b3c4d5e6f7890abc03");
const SENTENCE = "Neither party may assign this agreement without consent.";
const META = {
  apiKey: "test-key-not-real",
  modelId: "test-model",
  baseUrl: "https://api.example.test/v1",
  timeoutMs: 5000,
  maxRetries: 0,
};

let fake: AnalysesFake;

function collections() {
  return {
    documents: fake.documents as unknown as Collection<DocumentRecord>,
    analyses: {
      runs: fake.runs as unknown as Collection<AnalysisRunRecord>,
      findings: fake.findings as unknown as Collection<FindingRecord>,
    },
  };
}

function findingJson(excerpt: string, page: number | null = 1): string {
  return JSON.stringify({
    findings: [
      {
        category: "change_of_control",
        severity: "high",
        title: "Assignment requires consent",
        explanation: "Assignment needs prior consent.",
        excerpt,
        page,
        counterEvidence: null,
        uncertainty: null,
      },
    ],
  });
}

function seedDoc(text: string = SENTENCE): void {
  fake.state.documents.push({
    _id: DOC_ID,
    matterId: MATTER_ID,
    filename: "a.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    extractionStatus: "completed",
    extractedText: text,
    pageCount: 1,
  });
}

beforeEach(() => {
  fake = createAnalysesFake();
});

describe("runAnalysisJob", () => {
  it("persists a completed run for fully analyzed text", async () => {
    seedDoc();
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async () => findingJson(SENTENCE),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.run.status).toBe("completed");
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({ excerpt: SENTENCE, page: 1 });
    expect(fake.findingState).toHaveLength(1);
  });

  it("persists live section progress while running", async () => {
    seedDoc(`${"filler ".repeat(300)}\n\nSection 9. Change of control.\n\n${SENTENCE}`);
    const observed: Array<number | undefined> = [];
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async () => {
        observed.push(fake.runState[0]?.sectionsAnalyzed);
        return JSON.stringify({ findings: [] });
      },
    });
    expect(outcome.ok).toBe(true);
    // First call sees the initial 0; the second sees the first section done.
    expect(observed).toEqual([0, 1]);
    expect(fake.runState[0]).toMatchObject({ sectionsAnalyzed: 2, sectionsTotal: 2 });
  });

  it("reports limited (never clean) when a section fails", async () => {
    // Two sections via a heading split: filler pushes past the quarter mark,
    // so the clause heading starts section two.
    seedDoc(`${"filler ".repeat(300)}\n\nSection 9. Change of control.\n\n${SENTENCE}`);
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async (_messages, meta) => {
        if (meta.sectionIndex === 0) {
          throw new MetaError("timeout", "slow");
        }
        return findingJson(SENTENCE);
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.run.status).toBe("limited");
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.run.limitations.join(" ")).toContain("s1");
    expect(outcome.sectionsFailed).toBe(1);
  });

  it("fails the run when every section fails, keeping previous findings", async () => {
    seedDoc();
    const oldRunId = new ObjectId();
    fake.runState.push({
      _id: oldRunId,
      matterId: MATTER_ID,
      docId: DOC_ID,
      status: "completed",
      limitations: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    fake.findingState.push({
      _id: new ObjectId(),
      runId: oldRunId,
      matterId: MATTER_ID,
      docId: DOC_ID,
      category: "change_of_control",
      severity: "high",
      title: "Old",
      explanation: "Old explanation.",
      excerpt: "Old excerpt.",
      page: 1,
      reviewStatus: "confirmed",
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async () => {
        throw new MetaError("unavailable", "down", 503);
      },
    });
    expect(outcome).toEqual({ ok: false, code: "unavailable" });
    expect(fake.runState).toHaveLength(2);
    expect(fake.runState[1]).toMatchObject({ status: "failed", error: "unavailable" });
    expect(fake.findingState).toHaveLength(1);
    expect(fake.findingState[0]?.reviewStatus).toBe("confirmed");
  });

  it("fails fast with the fatal code when nothing succeeded", async () => {
    seedDoc();
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async () => {
        throw new MetaError("auth", "bad key", 401);
      },
    });
    expect(outcome).toEqual({ ok: false, code: "auth" });
    expect(fake.findingState).toHaveLength(0);
  });

  it("reports timeout when the deadline passes before analysis", async () => {
    seedDoc();
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      deadlineMs: Date.now() - 1000,
      complete: async () => findingJson(SENTENCE),
    });
    expect(outcome).toEqual({ ok: false, code: "timeout" });
  });

  it("refuses concurrent runs without adoption", async () => {
    seedDoc();
    fake.runState.push({
      _id: new ObjectId(),
      matterId: MATTER_ID,
      docId: DOC_ID,
      status: "running",
      limitations: [],
      startedAt: new Date(),
    });
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async () => findingJson(SENTENCE),
    });
    expect(outcome).toEqual({ ok: false, code: "in_progress" });
  });

  it("adopts stale running runs as interrupted and cleans their partials", async () => {
    seedDoc();
    const staleRunId = new ObjectId();
    fake.runState.push({
      _id: staleRunId,
      matterId: MATTER_ID,
      docId: DOC_ID,
      status: "running",
      limitations: [],
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    fake.findingState.push({
      _id: new ObjectId(),
      runId: staleRunId,
      matterId: MATTER_ID,
      docId: DOC_ID,
      category: "change_of_control",
      severity: "high",
      title: "Partial",
      explanation: "Partial explanation.",
      excerpt: "Partial excerpt.",
      page: null,
      reviewStatus: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      adoptStale: true,
      complete: async () => findingJson(SENTENCE),
    });
    expect(outcome.ok).toBe(true);
    expect(fake.runState[0]).toMatchObject({ status: "failed", error: "interrupted" });
    // The stale partial is gone; only the new run's verified finding remains.
    expect(fake.findingState).toHaveLength(1);
    expect(fake.findingState[0]?.excerpt).toBe(SENTENCE);
  });

  it("persists nothing when the document vanishes mid-run", async () => {
    seedDoc();
    const outcome = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async () => {
        fake.state.documents.length = 0;
        return findingJson(SENTENCE);
      },
    });
    expect(outcome).toEqual({ ok: false, code: "not_found" });
    expect(fake.findingState).toHaveLength(0);
  });

  it("rejects missing documents and documents without usable text", async () => {
    const missing = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async () => findingJson(SENTENCE),
    });
    expect(missing).toEqual({ ok: false, code: "not_found" });

    fake.state.documents.push({
      _id: DOC_ID,
      matterId: MATTER_ID,
      filename: "a.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
      extractionStatus: "pending",
    });
    const noText = await runAnalysisJob({
      ...collections(),
      meta: META,
      matterId: MATTER_ID,
      docId: DOC_ID,
      complete: async () => findingJson(SENTENCE),
    });
    expect(noText).toEqual({ ok: false, code: "no_usable_text" });
  });
});
