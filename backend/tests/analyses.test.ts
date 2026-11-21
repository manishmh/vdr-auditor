import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, chatCompletionMock, gridfsMocks } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  chatCompletionMock: vi.fn(),
  gridfsMocks: {
    storePdf: vi.fn(),
    openPdfDownload: vi.fn(),
    readPdfBytes: vi.fn(),
    deletePdf: vi.fn(),
  },
}));

vi.mock("../src/db/mongodb.js", () => ({
  pingDatabase: vi.fn(),
  getDb: getDbMock,
  closeDatabase: vi.fn(),
}));

vi.mock("../src/storage/gridfs.js", () => ({
  PDF_BUCKET_NAME: "pdfs",
  storePdf: gridfsMocks.storePdf,
  openPdfDownload: gridfsMocks.openPdfDownload,
  readPdfBytes: gridfsMocks.readPdfBytes,
  deletePdf: gridfsMocks.deletePdf,
}));

vi.mock("../src/ai/metaClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/ai/metaClient.js")>();
  return { ...original, chatCompletion: chatCompletionMock };
});

import { MetaError } from "../src/ai/metaClient.js";
import type { DocumentExtractionStatus } from "../src/models/document.js";
import { startApp, type RunningApp } from "./matters-fake.js";
import { createAnalysesFake, type AnalysesFake } from "./analyses-fake.js";

const URI = "mongodb://localhost:27017/testdb";
const MATTER_ID = "64f1a2b3c4d5e6f7890abc01";
const OTHER_MATTER_ID = "64f1a2b3c4d5e6f7890abc02";
const DOC_ID = "64f1a2b3c4d5e6f7890abc03";
const FINDING_ID = "64f1a2b3c4d5e6f7890abc04";
const TEXT = "Neither party may assign this agreement without consent.";

let fake: AnalysesFake;
let app: RunningApp | undefined;
let errorSpy: { mockRestore: () => void } | undefined;

function silenceErrors(): void {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
}

function modelFindings(excerpt: string): string {
  return JSON.stringify({
    findings: [
      {
        category: "change_of_control",
        severity: "high",
        title: "Assignment requires consent",
        explanation: "Assignment needs prior consent.",
        excerpt,
        page: 1,
        counterEvidence: null,
        uncertainty: null,
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fake = createAnalysesFake();
  getDbMock.mockResolvedValue(fake.db);
  gridfsMocks.deletePdf.mockResolvedValue(undefined);
  process.env["META_API_KEY"] = "test-key-not-real";
  process.env["META_MODEL_ID"] = "test-model";
  fake.state.matters.push({
    _id: new ObjectId(MATTER_ID),
    title: "Matter",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

afterEach(async () => {
  errorSpy?.mockRestore();
  errorSpy = undefined;
  delete process.env["META_API_KEY"];
  delete process.env["META_MODEL_ID"];
  await app?.close();
  app = undefined;
});

function seedDoc(overrides: {
  id?: string;
  matterId?: string;
  status?: DocumentExtractionStatus;
  text?: string;
}): void {
  fake.state.documents.push({
    _id: new ObjectId(overrides.id ?? DOC_ID),
    matterId: new ObjectId(overrides.matterId ?? MATTER_ID),
    filename: "a.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    extractionStatus: overrides.status ?? "completed",
    ...(overrides.text !== undefined
      ? { extractedText: overrides.text, pageCount: 1 }
      : {}),
  });
}

describe("POST analysis", () => {
  it("analyzes extracted text and persists grounded findings", async () => {
    seedDoc({ text: TEXT });
    chatCompletionMock.mockResolvedValue({
      content: modelFindings("Neither party may assign this agreement without consent."),
      finishReason: "stop",
    });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const run = body["run"] as Record<string, unknown>;
    expect(run["status"]).toBe("completed");
    const findings = body["findings"] as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "change_of_control",
      severity: "high",
      page: 1,
      reviewStatus: "open",
      filename: "a.pdf",
    });
    expect(fake.findingState).toHaveLength(1);
    // Prompt carries the section header with its page range; the request uses
    // the named schema and only verified provider parameters (no sampling or
    // output controls).
    const call = chatCompletionMock.mock.calls[0]?.[1] as {
      messages: Array<{ content: string }>;
      jsonSchema: { name: string };
      meta: { sectionId: string; sectionIndex: number; sectionsTotal: number };
    };
    expect(call.messages[1]?.content).toContain("--- Section s1 (pages 1-1) ---");
    expect(call.jsonSchema.name).toBe("due_diligence_findings");
    expect(call.meta).toMatchObject({ sectionId: "s1", sectionIndex: 0, sectionsTotal: 1 });
    expect("maxTokens" in (call as Record<string, unknown>)).toBe(false);
    expect("temperature" in (call as Record<string, unknown>)).toBe(false);
  });

  it("drops invented excerpts instead of storing them", async () => {
    seedDoc({ text: TEXT });
    chatCompletionMock.mockResolvedValue({
      content: modelFindings("A quotation that appears nowhere."),
      finishReason: "stop",
    });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["findings"]).toEqual([]);
    expect(fake.findingState).toHaveLength(0);
  });

  it("returns 503 without configured credentials", async () => {
    delete process.env["META_API_KEY"];
    seedDoc({ text: TEXT });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "analysis_unconfigured" });
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("rejects documents without usable text", async () => {
    seedDoc({ status: "pending" });
    app = await startApp(URI);
    const pending = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(pending.status).toBe(422);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("rejects concurrent runs with 409", async () => {
    seedDoc({ text: TEXT });
    fake.runState.push({
      _id: new ObjectId(),
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      status: "running",
      limitations: [],
      startedAt: new Date(),
    });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "analysis_in_progress" });
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("preserves previous findings when a retry fails", async () => {
    silenceErrors();
    seedDoc({ text: TEXT });
    const oldRunId = new ObjectId();
    fake.runState.push({
      _id: oldRunId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      status: "completed",
      limitations: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    fake.findingState.push({
      _id: new ObjectId(FINDING_ID),
      runId: oldRunId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
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
    chatCompletionMock.mockRejectedValueOnce(new MetaError("unavailable", "down", 503));
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(res.status).toBe(503);
    expect(fake.findingState).toHaveLength(1);
    expect(fake.findingState[0]?.reviewStatus).toBe("confirmed");
    const failedRuns = fake.runState.filter((r) => r.status === "failed");
    expect(failedRuns).toHaveLength(1);
    // The failed latest attempt hides nothing: the previous verified
    // findings are still served.
    const current = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}/findings`);
    expect(current.status).toBe(200);
    const items = (await current.json()) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Old", reviewStatus: "confirmed" });
  });

  it("reports a timeout as 503 while keeping the specific run error", async () => {
    silenceErrors();
    seedDoc({ text: TEXT });
    chatCompletionMock.mockRejectedValueOnce(new MetaError("timeout", "slow"));
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(res.status).toBe(503);
    const failedRuns = fake.runState.filter((r) => r.status === "failed");
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]?.error).toBe("timeout");
  });

  it("returns 404 for missing and cross-matter documents", async () => {
    seedDoc({ matterId: OTHER_MATTER_ID });
    app = await startApp(URI);
    const cross = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(cross.status).toBe(404);
    const missing = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/64f1a2b3c4d5e6f7890abc99/analysis`,
      { method: "POST" },
    );
    expect(missing.status).toBe(404);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });
});

describe("mid-run document deletion", () => {
  it("persists nothing when the document vanishes during analysis", async () => {
    seedDoc({ text: TEXT });
    chatCompletionMock.mockResolvedValue({
      content: modelFindings("Neither party may assign this agreement without consent."),
      finishReason: "stop",
    });
    const doc = fake.state.documents[0];
    fake.documents.findOne
      .mockResolvedValueOnce(doc ?? null)
      .mockResolvedValue(null);
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(fake.findingState).toHaveLength(0);
    expect(fake.runState).toHaveLength(1);
    expect(fake.runState[0]?.status).toBe("failed");
  });

  it("deleting a document cascades its runs and findings", async () => {
    seedDoc({ text: TEXT });
    const runId = new ObjectId();
    fake.runState.push({
      _id: runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      status: "completed",
      limitations: [],
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    fake.findingState.push({
      _id: new ObjectId(FINDING_ID),
      runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      category: "change_of_control",
      severity: "high",
      title: "T",
      explanation: "E.",
      excerpt: "X.",
      page: 1,
      reviewStatus: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
    expect(fake.runState).toHaveLength(0);
    expect(fake.findingState).toHaveLength(0);
  });
});

describe("GET doc analysis", () => {
  it("returns the latest run with current findings", async () => {
    seedDoc({ text: TEXT });
    const runId = new ObjectId();
    fake.runState.push({
      _id: runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      status: "completed",
      limitations: [],
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    fake.findingState.push({
      _id: new ObjectId(FINDING_ID),
      runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      category: "uncapped_liabilities",
      severity: "medium",
      title: "T",
      explanation: "E.",
      excerpt: "X.",
      page: null,
      reviewStatus: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body["run"] as Record<string, unknown>)["status"]).toBe("completed");
    expect((body["findings"] as Array<unknown>)).toHaveLength(1);
  });

  it("returns null run with no findings when never analyzed", async () => {
    seedDoc({ text: TEXT });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analysis`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: null, findings: [] });
  });

  it("returns the full run history for one document, newest first", async () => {
    seedDoc({ text: TEXT });
    for (const started of ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]) {
      fake.runState.push({
        _id: new ObjectId(),
        matterId: new ObjectId(MATTER_ID),
        docId: new ObjectId(DOC_ID),
        status: "completed",
        limitations: [],
        startedAt: new Date(started),
        finishedAt: new Date(started),
      });
    }
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/${DOC_ID}/analyses`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analyses: Array<Record<string, unknown>> };
    expect(body.analyses).toHaveLength(2);
    expect(body.analyses[0]?.["startedAt"]).toContain("2026-02-01");
    expect(body.analyses[1]?.["startedAt"]).toContain("2026-01-01");
  });

  it("returns 404 history for missing documents", async () => {
    seedDoc({ text: TEXT });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/documents/64f1a2b3c4d5e6f7890abc09/analyses`,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET analyses and findings", () => {
  it("shows only the latest successful run's findings per document", async () => {
    seedDoc({ text: TEXT });
    const oldRunId = new ObjectId();
    const newRunId = new ObjectId();
    fake.runState.push(
      {
        _id: oldRunId,
        matterId: new ObjectId(MATTER_ID),
        docId: new ObjectId(DOC_ID),
        status: "completed",
        limitations: [],
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        finishedAt: new Date("2026-01-01T00:01:00.000Z"),
      },
      {
        _id: newRunId,
        matterId: new ObjectId(MATTER_ID),
        docId: new ObjectId(DOC_ID),
        status: "completed",
        limitations: [],
        startedAt: new Date("2026-02-01T00:00:00.000Z"),
        finishedAt: new Date("2026-02-01T00:01:00.000Z"),
      },
    );
    const finding = (runId: ObjectId, title: string) => ({
      _id: new ObjectId(),
      runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      category: "change_of_control" as const,
      severity: "high" as const,
      title,
      explanation: "E.",
      excerpt: "X.",
      page: 1,
      reviewStatus: "open" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fake.findingState.push(finding(oldRunId, "Stale"), finding(newRunId, "Current"));
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}/findings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((f) => f["title"])).toEqual(["Current"]);
  });

  it("lists latest runs and current findings for the matter", async () => {
    seedDoc({ text: TEXT });
    const runId = new ObjectId();
    fake.runState.push({
      _id: runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      status: "completed",
      limitations: [],
      startedAt: new Date(),
    });
    fake.findingState.push({
      _id: new ObjectId(FINDING_ID),
      runId,
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      category: "missing_signatures",
      severity: "low",
      title: "T",
      explanation: "E.",
      excerpt: "X.",
      page: 2,
      reviewStatus: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    app = await startApp(URI);
    const analyses = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}/analyses`);
    expect(analyses.status).toBe(200);
    const analysesBody = (await analyses.json()) as Record<string, unknown>;
    expect(analysesBody["analyses"] as Array<unknown>).toHaveLength(1);
    const findings = await fetch(`${app.baseUrl}/api/matters/${MATTER_ID}/findings`);
    expect(findings.status).toBe(200);
    const items = (await findings.json()) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: FINDING_ID, filename: "a.pdf" });
  });
});

describe("PATCH finding review status", () => {
  it("updates the review status within the matter", async () => {
    fake.findingState.push({
      _id: new ObjectId(FINDING_ID),
      runId: new ObjectId(),
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      category: "missing_signatures",
      severity: "low",
      title: "T",
      explanation: "E.",
      excerpt: "X.",
      page: null,
      reviewStatus: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/findings/${FINDING_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewStatus: "confirmed" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["reviewStatus"]).toBe("confirmed");
    expect(fake.findingState[0]?.reviewStatus).toBe("confirmed");
  });

  it("rejects invalid statuses and cross-matter ids", async () => {
    app = await startApp(URI);
    const bad = await fetch(
      `${app.baseUrl}/api/matters/${MATTER_ID}/findings/${FINDING_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewStatus: "maybe" }),
      },
    );
    expect(bad.status).toBe(400);
    const cross = await fetch(
      `${app.baseUrl}/api/matters/${OTHER_MATTER_ID}/findings/${FINDING_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewStatus: "confirmed" }),
      },
    );
    expect(cross.status).toBe(404);
  });
});
