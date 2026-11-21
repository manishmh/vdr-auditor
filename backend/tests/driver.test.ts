import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, gridfsMocks, chatCompletionMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  gridfsMocks: {
    storePdf: vi.fn(),
    openPdfDownload: vi.fn(),
    readPdfBytes: vi.fn(),
    deletePdf: vi.fn(),
  },
  chatCompletionMock: vi.fn(),
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
import type { ProcessingStage } from "../src/models/processing.js";
import {
  PROCESSING_STALE_MS,
  driveProcessingRun,
  type RunLogEvent,
} from "../src/processing/driver.js";
import { buildPdf } from "./pdf-fixtures.js";
import { createProcessingFake, type ProcessingFake } from "./processing-fake.js";

const URI = "mongodb://localhost:27017/testdb";
const MATTER_ID = "64f1a2b3c4d5e6f7890abc01";
const DOC_ID = "64f1a2b3c4d5e6f7890abc03";
const RUN_ID = "64f1a2b3c4d5e6f7890abc04";
const META = {
  apiKey: "test-key-not-real",
  modelId: "test-model",
  baseUrl: "https://api.example.test/v1",
  timeoutMs: 5000,
  maxRetries: 0,
};
const SENTENCE = "Neither party may assign without consent here.";

let fake: ProcessingFake;
let logs: RunLogEvent[];
let errorSpy: { mockRestore: () => void } | undefined;

function silenceErrors(): void {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
}

function baseOptions() {
  return {
    mongodbUri: URI,
    mongodbDbName: "testdb",
    meta: META,
    sleep: async () => undefined,
    log: (event: RunLogEvent) => {
      logs.push(event);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake = createProcessingFake();
  getDbMock.mockResolvedValue(fake.db);
  logs = [];
  fake.state.matters.push({
    _id: new ObjectId(MATTER_ID),
    title: "Matter",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

afterEach(() => {
  errorSpy?.mockRestore();
  errorSpy = undefined;
});

function seedDoc(overrides: {
  status?: DocumentExtractionStatus;
  text?: string;
}): void {
  fake.state.documents.push({
    _id: new ObjectId(DOC_ID),
    matterId: new ObjectId(MATTER_ID),
    filename: "a.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    extractionStatus: overrides.status ?? "pending",
    ...(overrides.text !== undefined
      ? { extractedText: overrides.text, pageCount: 1 }
      : {}),
  });
}

function seedRun(overrides: {
  id?: string;
  stage?: ProcessingStage;
  active?: boolean;
  attempts?: number;
  heartbeatAt?: Date;
}): ObjectId {
  const id = new ObjectId(overrides.id ?? RUN_ID);
  fake.processingState.push({
    _id: id,
    matterId: new ObjectId(MATTER_ID),
    docId: new ObjectId(DOC_ID),
    stage: overrides.stage ?? "queued",
    active: overrides.active ?? true,
    attempts: overrides.attempts ?? 0,
    heartbeatAt: overrides.heartbeatAt ?? new Date(),
    // Fresh by default: the max-age backstop must not age out test runs.
    startedAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
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

describe("driveProcessingRun", () => {
  it("drives queued extraction then analysis to completed", async () => {
    seedDoc({});
    const runId = seedRun({});
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const final = await driveProcessingRun(runId, baseOptions());
    expect(final?.stage).toBe("completed");
    expect(final?.active).toBe(false);
    expect(fake.findingState).toHaveLength(1);
    expect(fake.state.documents[0]?.extractionStatus).toBe("completed");
    const events = logs.map((entry) => entry.event);
    expect(events).toContain("drive-started");
    expect(events.filter((event) => event === "stage-finished").length).toBeGreaterThanOrEqual(2);
    expect(events).toContain("drive-finished");
  });

  it("completes with limits when no text is extracted", async () => {
    seedDoc({});
    const runId = seedRun({});
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[], []]));
    const final = await driveProcessingRun(runId, baseOptions());
    expect(final?.stage).toBe("completed_with_limits");
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("fails corrupt PDFs without calling the model", async () => {
    silenceErrors();
    seedDoc({});
    const runId = seedRun({});
    gridfsMocks.readPdfBytes.mockResolvedValue(Buffer.from("%PDF-1.4\ngarbage\n"));
    const final = await driveProcessingRun(runId, baseOptions());
    expect(final?.stage).toBe("failed");
    expect(final?.error).toBe("unparseable");
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("exhausts attempts on provider failure and preserves old findings", async () => {
    silenceErrors();
    seedDoc({ status: "completed", text: SENTENCE });
    const runId = seedRun({ stage: "analyzing" });
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
      _id: new ObjectId(),
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
    chatCompletionMock.mockRejectedValue(new MetaError("unavailable", "down", 503));
    const final = await driveProcessingRun(runId, { ...baseOptions(), maxAttempts: 2 });
    expect(final?.stage).toBe("failed");
    expect(chatCompletionMock).toHaveBeenCalledTimes(3);
    expect(fake.findingState).toHaveLength(1);
    expect(fake.findingState[0]?.reviewStatus).toBe("confirmed");
  });

  it("surfaces the specific provider error instead of collapsing it", async () => {
    silenceErrors();
    seedDoc({ status: "completed", text: SENTENCE });
    const runId = seedRun({ stage: "analyzing" });
    chatCompletionMock.mockRejectedValue(new MetaError("timeout", "slow"));
    const final = await driveProcessingRun(runId, { ...baseOptions(), maxAttempts: 1 });
    expect(final?.stage).toBe("failed");
    expect(final?.error).toBe("timeout");
  });

  it("fails fast on deterministic auth errors without retrying", async () => {
    silenceErrors();
    seedDoc({ status: "completed", text: SENTENCE });
    const runId = seedRun({ stage: "analyzing" });
    chatCompletionMock.mockRejectedValue(new MetaError("auth", "bad key", 401));
    const final = await driveProcessingRun(runId, baseOptions());
    expect(final?.stage).toBe("failed");
    expect(final?.error).toBe("auth");
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
  });

  it("fails fast on missing-model and truncated-output errors", async () => {
    silenceErrors();
    for (const category of ["model_not_found", "truncated"] as const) {
      vi.clearAllMocks();
      fake = createProcessingFake();
      getDbMock.mockResolvedValue(fake.db);
      logs = [];
      fake.state.matters.push({
        _id: new ObjectId(MATTER_ID),
        title: "Matter",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      seedDoc({ status: "completed", text: SENTENCE });
      const runId = seedRun({ stage: "analyzing" });
      chatCompletionMock.mockRejectedValue(new MetaError(category, category));
      const final = await driveProcessingRun(runId, baseOptions());
      expect(final?.stage).toBe("failed");
      expect(final?.error).toBe(category);
      expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    }
  });

  it("lets only one concurrent driver do the model call", async () => {
    seedDoc({ status: "completed", text: SENTENCE });
    const runId = seedRun({});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    chatCompletionMock.mockImplementationOnce(async () => {
      await gate;
      return { content: modelFindings(SENTENCE), finishReason: "stop" };
    });
    const first = driveProcessingRun(runId, baseOptions());
    const second = driveProcessingRun(runId, baseOptions());
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([first, second]);
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    const stored = fake.processingState.find((r) => r._id.toHexString() === RUN_ID);
    expect(stored?.stage).toBe("completed");
    expect(fake.findingState).toHaveLength(1);
  });

  it("resumes a stale run", async () => {
    seedDoc({});
    const runId = seedRun({
      stage: "extracting",
      heartbeatAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const final = await driveProcessingRun(runId, baseOptions());
    expect(final?.stage).toBe("completed");
  });

  it("leaves a freshly claimed run alone", async () => {
    seedDoc({});
    const runId = seedRun({ stage: "analyzing", heartbeatAt: new Date() });
    // Simulate another live driver by pre-setting a fresh claim the check rejects.
    fake.processingRuns.findOneAndUpdate.mockResolvedValueOnce(null);
    const final = await driveProcessingRun(runId, baseOptions());
    expect(final?.stage).toBe("analyzing");
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(gridfsMocks.readPdfBytes).not.toHaveBeenCalled();
  });

  it("stops immediately when the budget is exhausted", async () => {
    seedDoc({});
    const runId = seedRun({});
    const final = await driveProcessingRun(runId, { ...baseOptions(), budgetMs: 0 });
    expect(final?.stage).toBe("queued");
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("marks paused runs stale so the next retry resumes immediately", async () => {
    seedDoc({});
    const runId = seedRun({ heartbeatAt: new Date() });
    const returned = await driveProcessingRun(runId, { ...baseOptions(), budgetMs: 0 });
    expect(returned?.stage).toBe("queued");
    expect(returned?.active).toBe(true);
    const stored = fake.processingState.find((r) => r._id.toHexString() === RUN_ID);
    expect(stored?.active).toBe(true);
    expect(stored?.heartbeatAt.getTime()).toBeLessThan(Date.now() - PROCESSING_STALE_MS);
  });

  it("fails when the document is gone", async () => {
    const runId = seedRun({});
    const final = await driveProcessingRun(runId, baseOptions());
    expect(final?.stage).toBe("failed");
    expect(final?.error).toBe("document_deleted");
  });

  it("fails analysis without configuration but keeps extraction", async () => {
    seedDoc({});
    const runId = seedRun({});
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    const final = await driveProcessingRun(runId, { ...baseOptions(), meta: undefined });
    expect(final?.stage).toBe("failed");
    expect(final?.error).toBe("unconfigured");
    expect(fake.state.documents[0]?.extractionStatus).toBe("completed");
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("logs stages and durations without content or secrets", async () => {
    seedDoc({});
    const runId = seedRun({});
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    await driveProcessingRun(runId, baseOptions());
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SENTENCE);
    expect(serialized).not.toContain("test-key-not-real");
    const finished = logs.find((entry) => entry.event === "drive-finished");
    expect(finished).toMatchObject({ stage: "completed" });
    expect(typeof finished?.durationMs).toBe("number");
    expect(logs.every((entry) => entry.runId === RUN_ID)).toBe(true);
  });
});
