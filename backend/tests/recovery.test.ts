import { ObjectId, type Filter } from "mongodb";
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
import type { ProcessingRunRecord, ProcessingStage } from "../src/models/processing.js";
import { recoverProcessingRuns, startRecoveryLoop } from "../src/processing/recovery.js";
import type { RunLogEvent } from "../src/processing/driver.js";
import { buildPdf } from "./pdf-fixtures.js";
import { startApp, type RunningApp } from "./matters-fake.js";
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
let app: RunningApp | undefined;
let errorSpy: { mockRestore: () => void } | undefined;

function silenceErrors(): void {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

afterEach(async () => {
  errorSpy?.mockRestore();
  errorSpy = undefined;
  delete process.env["META_API_KEY"];
  delete process.env["META_MODEL_ID"];
  await app?.close();
  app = undefined;
});

function seedDoc(overrides: {
  status?: DocumentExtractionStatus;
  text?: string;
  updatedAt?: Date;
}): void {
  fake.state.documents.push({
    _id: new ObjectId(DOC_ID),
    matterId: new ObjectId(MATTER_ID),
    filename: "a.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-02-01T00:00:00.000Z"),
    extractionStatus: overrides.status ?? "pending",
    ...(overrides.text !== undefined
      ? { extractedText: overrides.text, pageCount: 1 }
      : {}),
  });
}

function seedRun(overrides: {
  id?: string;
  stage?: ProcessingStage;
  heartbeatAt?: Date;
  startedAt?: Date;
  claimedAt?: Date;
}): ObjectId {
  const id = new ObjectId(overrides.id ?? RUN_ID);
  fake.processingState.push({
    _id: id,
    matterId: new ObjectId(MATTER_ID),
    docId: new ObjectId(DOC_ID),
    stage: overrides.stage ?? "queued",
    active: true,
    attempts: 0,
    heartbeatAt: overrides.heartbeatAt ?? new Date(),
    startedAt: overrides.startedAt ?? new Date(),
    updatedAt: new Date(),
    ...(overrides.claimedAt !== undefined ? { claimedAt: overrides.claimedAt } : {}),
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

function staleDate(): Date {
  return new Date(Date.now() - 20 * 60 * 1000);
}

function baseRecovery() {
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

describe("recoverProcessingRuns", () => {
  it("picks up fresh active runs on startup sweeps", async () => {
    seedDoc({});
    // Claimed with a fresh heartbeat by the dead process: without claim
    // release, the sweep would skip this run for the full staleness window.
    seedRun({ claimedAt: new Date(), heartbeatAt: new Date() });
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const result = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: true });
    expect(result).toMatchObject({ checked: 1, finished: 1, stillActive: 0, errors: 0 });
    expect(fake.processingState[0]).toMatchObject({ stage: "completed", active: false });
    expect(fake.findingState).toHaveLength(1);
  });

  it("periodic sweeps skip fresh runs and resume stale ones", async () => {
    seedDoc({});
    // A live driver's claim: fresh heartbeat plus claimedAt. The periodic
    // sweep must not disturb it.
    seedRun({
      id: "64f1a2b3c4d5e6f7890abc05",
      heartbeatAt: new Date(),
      claimedAt: new Date(),
    });
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const freshOnly = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: false });
    expect(freshOnly.checked).toBe(0);
    expect(fake.processingState[0]?.stage).toBe("queued");

    seedRun({ id: "64f1a2b3c4d5e6f7890abc06", heartbeatAt: staleDate() });
    const result = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: false });
    expect(result.checked).toBe(1);
    const stale = fake.processingState.find((r) => r._id.toHexString() === "64f1a2b3c4d5e6f7890abc06");
    expect(stale).toMatchObject({ stage: "completed", active: false });
  });

  it("heals documents stuck in extraction by a dead process", async () => {
    seedDoc({ status: "processing", updatedAt: staleDate() });
    seedRun({ stage: "extracting", heartbeatAt: staleDate() });
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const result = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: true });
    expect(result.finished).toBe(1);
    expect(fake.processingState[0]).toMatchObject({ stage: "completed", active: false });
    expect(fake.state.documents[0]?.extractionStatus).toBe("completed");
    expect(logs.map((entry) => entry.event)).toContain("extraction-healed");
  });

  it("ages out ancient runs as interrupted instead of leaving them stuck", async () => {
    silenceErrors();
    seedDoc({ status: "completed", text: SENTENCE });
    seedRun({
      stage: "analyzing",
      heartbeatAt: staleDate(),
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const result = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: true });
    expect(result).toMatchObject({ checked: 1, finished: 1, errors: 0 });
    expect(fake.processingState[0]).toMatchObject({
      stage: "failed",
      active: false,
      error: "interrupted",
    });
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("releases the claim when a drive throws unexpectedly, then retries", async () => {
    silenceErrors();
    seedDoc({ status: "completed", text: SENTENCE });
    seedRun({ stage: "analyzing", heartbeatAt: staleDate() });
    chatCompletionMock.mockRejectedValue(new MetaError("unavailable", "down", 503));
    // The startup claim-release write succeeds, the retry bookkeeping write
    // blows up, and the emergency release write right after succeeds.
    const inner = fake.processingRuns.updateOne.getMockImplementation();
    let updateCalls = 0;
    fake.processingRuns.updateOne.mockImplementation(
      async (
        filter: Filter<ProcessingRunRecord>,
        update: { $set?: Partial<ProcessingRunRecord> },
      ) => {
        updateCalls += 1;
        if (updateCalls === 2) {
          throw new Error("connection reset");
        }
        return inner?.(filter, update);
      },
    );
    const first = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: true });
    expect(first).toMatchObject({ checked: 1, stillActive: 1 });
    expect(logs.map((entry) => entry.event)).toContain("drive-error");
    const stored = fake.processingState[0];
    expect(stored?.active).toBe(true);
    expect(stored?.heartbeatAt.getTime()).toBeLessThan(Date.now());

    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const second = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: true });
    expect(second.finished).toBe(1);
    expect(fake.processingState[0]).toMatchObject({ stage: "completed", active: false });
  });

  it("fails terminally (never stuck) when attempts are exhausted", async () => {
    silenceErrors();
    seedDoc({ status: "completed", text: SENTENCE });
    seedRun({ stage: "analyzing", heartbeatAt: staleDate() });
    chatCompletionMock.mockRejectedValue(new MetaError("unavailable", "down", 503));
    const result = await recoverProcessingRuns({
      ...baseRecovery(),
      includeFresh: true,
      maxAttempts: 0,
    });
    expect(result).toMatchObject({ checked: 1, finished: 1 });
    expect(fake.processingState[0]).toMatchObject({
      stage: "failed",
      active: false,
      error: "unavailable",
    });
  });

  it("adopts stale running analysis runs during recovery", async () => {
    seedDoc({ status: "completed", text: SENTENCE });
    seedRun({ stage: "analyzing", heartbeatAt: staleDate() });
    fake.runState.push({
      _id: new ObjectId(),
      matterId: new ObjectId(MATTER_ID),
      docId: new ObjectId(DOC_ID),
      status: "running",
      limitations: [],
      startedAt: staleDate(),
    });
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const result = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: true });
    expect(result.finished).toBe(1);
    expect(fake.runState[0]).toMatchObject({ status: "failed", error: "interrupted" });
    expect(fake.runState[1]).toMatchObject({ status: "completed" });
    expect(fake.findingState).toHaveLength(1);
  });

  it("fails orphaned analysis runs but leaves fresh ones alone", async () => {
    seedDoc({ status: "completed", text: SENTENCE });
    fake.runState.push(
      {
        _id: new ObjectId(),
        matterId: new ObjectId(MATTER_ID),
        docId: new ObjectId(DOC_ID),
        status: "running",
        limitations: [],
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
      {
        _id: new ObjectId(),
        matterId: new ObjectId(MATTER_ID),
        docId: new ObjectId(DOC_ID),
        status: "running",
        limitations: [],
        startedAt: new Date(),
      },
    );
    const result = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: true });
    expect(result.staleAnalysesFailed).toBe(1);
    expect(fake.runState[0]).toMatchObject({ status: "failed", error: "interrupted" });
    expect(fake.runState[1]?.status).toBe("running");
  });

  it("bounds each sweep to one batch", async () => {
    seedDoc({});
    seedRun({ id: "64f1a2b3c4d5e6f7890abc05", heartbeatAt: staleDate() });
    seedRun({ id: "64f1a2b3c4d5e6f7890abc06", heartbeatAt: staleDate() });
    seedRun({ id: "64f1a2b3c4d5e6f7890abc07", heartbeatAt: staleDate() });
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const result = await recoverProcessingRuns({
      ...baseRecovery(),
      includeFresh: true,
      batchSize: 2,
    });
    expect(result.checked).toBe(2);
  });

  it("fails uploads whose bytes never arrived, sparing fresh and stored docs", async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fake.state.documents.push(
      {
        _id: new ObjectId("64f1a2b3c4d5e6f7890abc10"),
        matterId: new ObjectId(MATTER_ID),
        filename: "stuck.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        createdAt: old,
        updatedAt: old,
        extractionStatus: "pending",
        bytesStored: false,
      },
      {
        _id: new ObjectId("64f1a2b3c4d5e6f7890abc11"),
        matterId: new ObjectId(MATTER_ID),
        filename: "fresh.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
        extractionStatus: "pending",
        bytesStored: false,
      },
      {
        _id: new ObjectId("64f1a2b3c4d5e6f7890abc12"),
        matterId: new ObjectId(MATTER_ID),
        filename: "stored.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        createdAt: old,
        updatedAt: old,
        extractionStatus: "pending",
        bytesStored: true,
      },
    );
    const result = await recoverProcessingRuns({ ...baseRecovery(), includeFresh: false });
    expect(result.errors).toBe(0);
    const byId = (id: string) =>
      fake.state.documents.find((d) => d._id.toHexString() === id);
    expect(byId("64f1a2b3c4d5e6f7890abc10")).toMatchObject({
      extractionStatus: "failed",
      extractionError: "upload_interrupted",
    });
    expect(byId("64f1a2b3c4d5e6f7890abc11")).toMatchObject({
      extractionStatus: "pending",
    });
    expect(byId("64f1a2b3c4d5e6f7890abc12")).toMatchObject({
      extractionStatus: "pending",
    });
  });
});

describe("startRecoveryLoop", () => {
  it("sweeps on startup and stops cleanly", async () => {
    seedDoc({});
    seedRun({ heartbeatAt: staleDate() });
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    const stop = startRecoveryLoop({ ...baseRecovery(), intervalMs: 60 * 60 * 1000 });
    try {
      await vi.waitFor(() => {
        expect(fake.processingState[0]?.active).toBe(false);
      });
      expect(fake.processingState[0]?.stage).toBe("completed");
    } finally {
      stop();
    }
  });
});

describe("POST /api/processing/recover", () => {
  it("recovers abandoned runs over HTTP", async () => {
    seedDoc({});
    seedRun({ heartbeatAt: staleDate() });
    gridfsMocks.readPdfBytes.mockResolvedValue(buildPdf([[SENTENCE]]));
    chatCompletionMock.mockResolvedValue({ content: modelFindings(SENTENCE), finishReason: "stop" });
    process.env["META_API_KEY"] = "test-key-not-real";
    process.env["META_MODEL_ID"] = "test-model";
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/processing/recover`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ checked: 1, finished: 1, stillActive: 0, errors: 0 });
    expect(fake.processingState[0]).toMatchObject({ stage: "completed", active: false });

    const again = await fetch(`${app.baseUrl}/api/processing/recover`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Record<string, unknown>)["checked"]).toBe(0);
  });
});
