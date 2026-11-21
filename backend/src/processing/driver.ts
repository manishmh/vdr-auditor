import type { Collection, ObjectId } from "mongodb";
import { runAnalysisJob } from "../ai/job.js";
import type { MetaConfig } from "../ai/metaClient.js";
import { getAnalysesCollections } from "../db/analyses.js";
import { getDocumentsCollection } from "../db/documents.js";
import { getDb } from "../db/mongodb.js";
import { getProcessingRuns } from "../db/processing.js";
import { runExtractionJob } from "../extraction/job.js";
import type { DocumentRecord } from "../models/document.js";
import {
  isTerminalProcessingStage,
  type ProcessingRunRecord,
} from "../models/processing.js";

/** Failed attempts tolerated per run before it goes terminally failed. */
export const PROCESSING_MAX_ATTEMPTS = 3;
/** Active run without a heartbeat this old is considered abandoned. */
export const PROCESSING_STALE_MS = 10 * 60 * 1000;
/**
 * Maximum age of an active run. Anything older is failed as interrupted:
 * the backstop that guarantees no run stays active forever, no matter how
 * often recovery retries it.
 */
export const PROCESSING_MAX_AGE_MS = 30 * 60 * 1000;
/** Maximum wall-clock time one drive call spends working. */
export const PROCESSING_BUDGET_MS = 8 * 60 * 1000;
/** Pause between attempts inside one drive call. */
export const PROCESSING_RETRY_DELAY_MS = 2000;
/** Heartbeat refresh cadence while a drive call owns a run. */
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface RunLogEvent {
  runId: string;
  matterId: string;
  docId: string;
  event: string;
  stage?: string;
  attempt?: number;
  durationMs?: number;
  error?: string;
  pagesAnalyzed?: number;
  totalPages?: number;
  findingsKept?: number;
  sectionsTotal?: number;
  sectionsFailed?: number;
}

export function logRunEvent(event: RunLogEvent): void {
  console.log(JSON.stringify({ scope: "processing", ...event }));
}

export interface DriveOptions {
  mongodbUri: string;
  mongodbDbName: string;
  meta: MetaConfig | undefined;
  budgetMs?: number;
  staleMs?: number;
  maxAttempts?: number;
  maxAgeMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: RunLogEvent) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type StageStep =
  | { done: true; run: ProcessingRunRecord | null }
  | { done: false; run: ProcessingRunRecord }
  | { retry: true; code: string };

/**
 * Advance one processing run toward a terminal stage. Idempotent and safe to
 * call concurrently: claiming is atomic, only one driver works a run, and
 * every state change is persisted before the next step begins. Never throws
 * for expected outcomes; unexpected driver errors propagate to the caller.
 */
export async function driveProcessingRun(
  runId: ObjectId,
  options: DriveOptions,
): Promise<ProcessingRunRecord | null> {
  const log = options.log ?? logRunEvent;
  const budgetMs = options.budgetMs ?? PROCESSING_BUDGET_MS;
  const staleMs = options.staleMs ?? PROCESSING_STALE_MS;
  const maxAttempts = options.maxAttempts ?? PROCESSING_MAX_ATTEMPTS;
  const maxAgeMs = options.maxAgeMs ?? PROCESSING_MAX_AGE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const startedAtMs = Date.now();
  // Overall run deadline, enforced inside long stages (analysis) so one
  // drive call cannot run unbounded no matter how many sections remain.
  const deadlineMs = startedAtMs + budgetMs;

  let runs;
  try {
    runs = await getProcessingRuns(options.mongodbUri, options.mongodbDbName);
  } catch {
    log({
      runId: runId.toHexString(),
      matterId: "",
      docId: "",
      event: "drive-failed",
      error: "database_unavailable",
    });
    return null;
  }

  const existing = await runs.findOne({ _id: runId });
  if (existing === null || !existing.active || isTerminalProcessingStage(existing.stage)) {
    return existing;
  }
  const finish = (run: ProcessingRunRecord | null): ProcessingRunRecord | null => {
    if (run !== null && (!run.active || isTerminalProcessingStage(run.stage))) {
      log({
        runId: run._id.toHexString(),
        matterId: run.matterId.toHexString(),
        docId: run.docId.toHexString(),
        event: "drive-finished",
        stage: run.stage,
        attempt: run.attempts,
        durationMs: Date.now() - startedAtMs,
        ...(run.error !== undefined ? { error: run.error } : {}),
      });
    }
    return run;
  };
  if (Date.now() - existing.startedAt.getTime() > maxAgeMs) {
    // Backstop: age out runs that recovery keeps retrying without progress
    // (deterministic crashes, poison documents). Never stuck forever.
    const finished = await markTerminal(options, existing, "failed", "interrupted");
    return finish(finished);
  }
  const claimed = await runs.findOneAndUpdate(
    {
      _id: runId,
      $or: [{ claimedAt: { $exists: false } }, { heartbeatAt: { $lt: new Date(Date.now() - staleMs) } }],
    },
    { $set: { claimedAt: new Date(), heartbeatAt: new Date() } },
    { returnDocument: "after" },
  );
  if (claimed === null) {
    log({
      runId: runId.toHexString(),
      matterId: existing.matterId.toHexString(),
      docId: existing.docId.toHexString(),
      event: "drive-skipped",
      stage: existing.stage,
    });
    return existing;
  }
  let current = claimed;
  log({
    runId: runId.toHexString(),
    matterId: current.matterId.toHexString(),
    docId: current.docId.toHexString(),
    event: "drive-started",
    stage: current.stage,
    attempt: current.attempts,
  });

  const heartbeat = setInterval(() => {
    runs
      .updateOne({ _id: runId }, { $set: { heartbeatAt: new Date() } })
      .catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  const unref = (heartbeat as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") {
    heartbeat.unref();
  }
  try {
    for (;;) {
      if (Date.now() - startedAtMs >= budgetMs) {
        // No live driver after this return, so mark the heartbeat stale:
        // the recovery sweep (or a manual retry) resumes immediately
        // instead of dead-zoning until the heartbeat would have aged out
        // on its own.
        clearInterval(heartbeat);
        await setRunFields(options, runId, {
          heartbeatAt: new Date(Date.now() - staleMs - 1000),
          updatedAt: new Date(),
        });
        log({
          runId: runId.toHexString(),
          matterId: current.matterId.toHexString(),
          docId: current.docId.toHexString(),
          event: "drive-paused",
          stage: current.stage,
        });
        return current;
      }
      let step: StageStep;
      try {
        step = await advanceOneStage(options, current, deadlineMs);
      } catch (err: unknown) {
        step = {
          retry: true,
          code: err instanceof Error ? err.name : "internal",
        };
      }
      if ("done" in step && step.done) {
        return finish(step.run);
      }
      if ("retry" in step) {
        const attempts = current.attempts + 1;
        if (attempts > maxAttempts) {
          const finished = await markTerminal(options, current, "failed", step.code);
          return finish(finished === null ? null : { ...finished, attempts });
        }
        await setRunFields(options, current._id, {
          attempts,
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        });
        log({
          runId: runId.toHexString(),
          matterId: current.matterId.toHexString(),
          docId: current.docId.toHexString(),
          event: "attempt-failed",
          stage: current.stage,
          attempt: attempts,
          error: step.code,
        });
        await sleep(PROCESSING_RETRY_DELAY_MS);
        const refreshed = await reloadRun(options, runId);
        if (refreshed === null) {
          return null;
        }
        current = refreshed;
        continue;
      }
      current = step.run;
      if (!current.active || isTerminalProcessingStage(current.stage)) {
        return finish(current);
      }
    }
  } catch (err: unknown) {
    // Unexpected driver/infrastructure failure outside the retry path (a bug
    // or a dying database connection). Release the claim immediately so the
    // recovery sweep retries soon; the attempts budget and the max-age
    // backstop still guarantee a terminal state eventually.
    clearInterval(heartbeat);
    const message = err instanceof Error ? err.message : "unknown error";
    log({
      runId: runId.toHexString(),
      matterId: current.matterId.toHexString(),
      docId: current.docId.toHexString(),
      event: "drive-error",
      stage: current.stage,
      attempt: current.attempts,
      error: "internal",
    });
    console.error(`processing drive failed for run ${runId.toHexString()}:`, message);
    await setRunFields(options, runId, {
      heartbeatAt: new Date(Date.now() - staleMs - 1000),
      updatedAt: new Date(),
    }).catch(() => undefined);
    return current;
  } finally {
    clearInterval(heartbeat);
  }
}

async function setRunFields(
  options: DriveOptions,
  runId: ObjectId,
  fields: Record<string, unknown>,
): Promise<void> {
  const runs = await getProcessingRuns(options.mongodbUri, options.mongodbDbName);
  await runs.updateOne({ _id: runId }, { $set: fields });
}

async function reloadRun(
  options: DriveOptions,
  runId: ObjectId,
): Promise<ProcessingRunRecord | null> {
  const runs = await getProcessingRuns(options.mongodbUri, options.mongodbDbName);
  return runs.findOne({ _id: runId });
}

async function markTerminal(
  options: DriveOptions,
  run: ProcessingRunRecord,
  stage: "completed" | "completed_with_limits" | "failed",
  error?: string,
  note?: string,
): Promise<ProcessingRunRecord | null> {
  const runs = await getProcessingRuns(options.mongodbUri, options.mongodbDbName);
  const now = new Date();
  await runs.updateOne(
    { _id: run._id },
    {
      $set: {
        stage,
        active: false,
        ...(error !== undefined ? { error } : {}),
        ...(note !== undefined ? { note } : {}),
        updatedAt: now,
        finishedAt: now,
      },
    },
  );
  return reloadRun(options, run._id);
}

async function advanceOneStage(
  options: DriveOptions,
  run: ProcessingRunRecord,
  deadlineMs: number,
): Promise<StageStep> {
  const runs = await getProcessingRuns(options.mongodbUri, options.mongodbDbName);
  const live = await runs.findOne({ _id: run._id });
  if (live === null) {
    return { done: true, run: null };
  }
  if (!live.active || isTerminalProcessingStage(live.stage)) {
    return { done: true, run: live };
  }
  const documents = await getDocumentsCollection(options.mongodbUri, options.mongodbDbName);
  const doc = await documents.findOne({ _id: live.docId, matterId: live.matterId });
  if (doc === null) {
    const finished = await markTerminal(options, live, "failed", "document_deleted");
    return { done: true, run: finished };
  }

  if (live.stage === "queued" || live.stage === "extracting") {
    return runExtractionStage(options, live, documents, doc);
  }
  return runAnalysisStage(options, live, documents, doc, deadlineMs);
}

type StageContext = {
  documents: Collection<DocumentRecord>;
  doc: DocumentRecord;
};

async function runExtractionStage(
  options: DriveOptions,
  run: ProcessingRunRecord,
  documents: StageContext["documents"],
  doc: StageContext["doc"],
): Promise<StageStep> {
  const log = options.log ?? logRunEvent;
  const healed = await healStuckExtraction(options, run, documents, doc);
  if (healed.extractionStatus === "completed" && healed.extractedText !== undefined) {
    await setRunFields(options, run._id, {
      stage: "analyzing",
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    });
    logRunEventSafe(log, run, "stage-skipped", "extracting", 0);
    const updated = await reloadRun(options, run._id);
    return updated === null ? { done: true, run: null } : { done: false, run: updated };
  }
  const db = await getDb(options.mongodbUri, options.mongodbDbName);
  const started = Date.now();
  const outcome = await runExtractionJob(documents, db, doc.matterId, doc._id);
  if (!outcome.ok) {
    if (outcome.code === "not_found") {
      const finished = await markTerminal(options, run, "failed", "document_deleted");
      return { done: true, run: finished };
    }
    if (outcome.code === "unavailable" || outcome.code === "internal") {
      return { retry: true, code: outcome.code };
    }
    if (outcome.code === "in_progress") {
      return { retry: true, code: "extraction_in_progress" };
    }
    const finished = await markTerminal(options, run, "failed", outcome.code);
    logRunEventSafe(log, run, "stage-finished", "failed", Date.now() - started, outcome.code);
    return { done: true, run: finished };
  }
  if (outcome.status === "no_text") {
    const finished = await markTerminal(
      options,
      run,
      "completed_with_limits",
      undefined,
      "No extractable text found; analysis skipped.",
    );
    logRunEventSafe(log, run, "stage-finished", "completed_with_limits", Date.now() - started);
    return { done: true, run: finished };
  }
  await setRunFields(options, run._id, {
    stage: "analyzing",
    attempts: 0,
    heartbeatAt: new Date(),
    updatedAt: new Date(),
  });
  logRunEventSafe(log, run, "stage-finished", "analyzing", Date.now() - started);
  const updated = await reloadRun(options, run._id);
  return updated === null ? { done: true, run: null } : { done: false, run: updated };
}

async function runAnalysisStage(
  options: DriveOptions,
  run: ProcessingRunRecord,
  documents: StageContext["documents"],
  doc: StageContext["doc"],
  deadlineMs: number,
): Promise<StageStep> {
  const log = options.log ?? logRunEvent;
  if (doc.extractionStatus !== "completed" || doc.extractedText === undefined) {
    await setRunFields(options, run._id, {
      stage: "extracting",
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    });
    const updated = await reloadRun(options, run._id);
    return updated === null ? { done: true, run: null } : { done: false, run: updated };
  }
  if (options.meta === undefined) {
    const finished = await markTerminal(options, run, "failed", "unconfigured");
    return { done: true, run: finished };
  }
  const analyses = await getAnalysesCollections(options.mongodbUri, options.mongodbDbName);
  const started = Date.now();
  const outcome = await runAnalysisJob({
    documents,
    analyses,
    meta: options.meta,
    matterId: doc.matterId,
    docId: doc._id,
    deadlineMs,
    // This driver holds the exclusive claim on the document's work, so any
    // running analysis run it finds is stale by construction: fail it as
    // interrupted instead of deadlocking against it.
    adoptStale: true,
  });
  if (!outcome.ok) {
    if (outcome.code === "not_found") {
      const finished = await markTerminal(options, run, "failed", "document_deleted");
      return { done: true, run: finished };
    }
    if (outcome.code === "no_usable_text") {
      await setRunFields(options, run._id, {
        stage: "extracting",
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      });
      const updated = await reloadRun(options, run._id);
      return updated === null ? { done: true, run: null } : { done: false, run: updated };
    }
    if (
      outcome.code === "auth" ||
      outcome.code === "bad_request" ||
      outcome.code === "model_not_found" ||
      outcome.code === "truncated"
    ) {
      // Deterministic configuration/request errors: retrying the same call
      // cannot help, so fail fast instead of burning all attempts.
      const finished = await markTerminal(options, run, "failed", outcome.code);
      logRunEventSafe(log, run, "stage-finished", "failed", Date.now() - started, outcome.code);
      return { done: true, run: finished };
    }
    return { retry: true, code: outcome.code };
  }
  const limited = outcome.run.status === "limited";
  const finished = await markTerminal(
    options,
    run,
    limited ? "completed_with_limits" : "completed",
    undefined,
    limited ? "Analysis covered only part of the document." : undefined,
  );
  logRunEventSafe(log, run, "stage-finished", limited ? "completed_with_limits" : "completed", Date.now() - started, undefined, {
    pagesAnalyzed: outcome.run.pagesAnalyzed,
    totalPages: outcome.run.totalPages,
    findingsKept: outcome.findings.length,
    sectionsTotal: outcome.sectionsTotal,
    sectionsFailed: outcome.sectionsFailed,
  });
  return { done: true, run: finished };
}

/**
 * Heal a document left in `processing` by a dead extractor (restart or crash
 * between the status write and the result write). Without this, recovery
 * would see `extraction_in_progress` forever. Only heals statuses older than
 * the staleness bound, so a live concurrent extractor is never disturbed
 * (and per-document run claiming makes that rare already).
 */
async function healStuckExtraction(
  options: DriveOptions,
  run: ProcessingRunRecord,
  documents: StageContext["documents"],
  doc: StageContext["doc"],
): Promise<StageContext["doc"]> {
  const log = options.log ?? logRunEvent;
  const staleMs = options.staleMs ?? PROCESSING_STALE_MS;
  if (doc.extractionStatus !== "processing") {
    return doc;
  }
  if (Date.now() - doc.updatedAt.getTime() <= staleMs) {
    return doc;
  }
  const healedStatus = doc.extractedText !== undefined ? "completed" : "pending";
  await documents.updateOne(
    { _id: doc._id },
    { $set: { extractionStatus: healedStatus, updatedAt: new Date() } },
  );
  log({
    runId: run._id.toHexString(),
    matterId: run.matterId.toHexString(),
    docId: run.docId.toHexString(),
    event: "extraction-healed",
    stage: run.stage,
    attempt: run.attempts,
  });
  return { ...doc, extractionStatus: healedStatus, updatedAt: new Date() };
}

function logRunEventSafe(
  log: (event: Parameters<typeof logRunEvent>[0]) => void,
  run: ProcessingRunRecord,
  event: string,
  stage: string,
  durationMs: number,
  error?: string,
  extra?: Pick<
    RunLogEvent,
    "pagesAnalyzed" | "totalPages" | "findingsKept" | "sectionsTotal" | "sectionsFailed"
  >,
): void {
  log({
    runId: run._id.toHexString(),
    matterId: run.matterId.toHexString(),
    docId: run.docId.toHexString(),
    event,
    stage,
    attempt: run.attempts,
    durationMs,
    ...(error !== undefined ? { error } : {}),
    ...(extra ?? {}),
  });
}
