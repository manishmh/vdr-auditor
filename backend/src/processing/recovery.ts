import type { AnalysisSettings } from "../ai/analysis.js";
import type { MetaConfig } from "../ai/metaClient.js";
import { getAnalysesCollections } from "../db/analyses.js";
import { getProcessingRuns } from "../db/processing.js";
import { isTerminalProcessingStage, type ProcessingRunRecord } from "../models/processing.js";
import {
  PROCESSING_MAX_AGE_MS,
  PROCESSING_STALE_MS,
  driveProcessingRun,
  type RunLogEvent,
} from "./driver.js";

/** How often a long-lived server sweeps for abandoned runs. */
export const RECOVERY_INTERVAL_MS = 60 * 1000;
/** Max runs driven per sweep; each sweep is bounded work. */
export const RECOVERY_BATCH_SIZE = 25;

export interface RecoveryOptions {
  mongodbUri: string;
  mongodbDbName: string;
  meta: MetaConfig | undefined;
  analysis?: AnalysisSettings;
  staleMs?: number;
  maxAgeMs?: number;
  maxAttempts?: number;
  budgetMs?: number;
  batchSize?: number;
  /**
   * False sweeps only stale runs (periodic use). True also picks up fresh
   * active runs (startup use: after a restart, this process holds no live
   * driver, so every active run is abandoned — including ones with a fresh
   * heartbeat from the dead process — and their claims are released before
   * driving). Only one long-lived backend may sweep a database; concurrent
   * sweepers still arbitrate through atomic claiming.
   */
  includeFresh?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: RunLogEvent) => void;
}

export interface RecoveryResult {
  checked: number;
  /** Runs terminal after this sweep (completed, limited, or failed). */
  finished: number;
  /** Runs still active after this sweep (driven, skipped, or errored). */
  stillActive: number;
  /** Sweeps that threw outside the driver's own hardening. */
  errors: number;
  /** Orphaned analysis runs failed as interrupted by this sweep. */
  staleAnalysesFailed: number;
}

function isTerminal(run: ProcessingRunRecord): boolean {
  return !run.active || isTerminalProcessingStage(run.stage);
}

/**
 * Drive abandoned processing runs toward a terminal stage. Idempotent and
 * safe to run concurrently (drive claiming arbitrates) and repeatedly. A
 * failed sweep never leaves a run worse off: every drive either advances
 * persisted state or releases its claim for the next sweep, and the attempts
 * budget plus the max-age backstop guarantee a terminal state eventually.
 */
export async function recoverProcessingRuns(options: RecoveryOptions): Promise<RecoveryResult> {
  const staleMs = options.staleMs ?? PROCESSING_STALE_MS;
  const maxAgeMs = options.maxAgeMs ?? PROCESSING_MAX_AGE_MS;
  const batchSize = options.batchSize ?? RECOVERY_BATCH_SIZE;
  const result: RecoveryResult = {
    checked: 0,
    finished: 0,
    stillActive: 0,
    errors: 0,
    staleAnalysesFailed: 0,
  };
  let runs;
  try {
    runs = await getProcessingRuns(options.mongodbUri, options.mongodbDbName);
  } catch {
    return { ...result, errors: 1 };
  }
  result.staleAnalysesFailed = await failOrphanedAnalysisRuns(options, maxAgeMs).catch(() => 0);
  const candidates = await runs
    .find({
      active: true,
      ...(options.includeFresh === true
        ? {}
        : { heartbeatAt: { $lt: new Date(Date.now() - staleMs) } }),
    })
    .sort({ updatedAt: 1 })
    .limit(batchSize)
    .toArray()
    .catch(() => null);
  if (candidates === null) {
    return { ...result, errors: 1 };
  }
  for (const candidate of candidates) {
    result.checked += 1;
    if (options.includeFresh === true) {
      // No live driver exists in a just-started process: release the dead
      // claim so driving does not wait out the heartbeat's staleness.
      await runs
        .updateOne(
          { _id: candidate._id, active: true },
          {
            $set: {
              heartbeatAt: new Date(Date.now() - staleMs - 1000),
              updatedAt: new Date(),
            },
          },
        )
        .catch(() => undefined);
    }
    try {
      const final = await driveProcessingRun(candidate._id, {
        mongodbUri: options.mongodbUri,
        mongodbDbName: options.mongodbDbName,
        meta: options.meta,
        ...(options.analysis !== undefined ? { analysis: options.analysis } : {}),
        ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
        ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
        ...(options.log !== undefined ? { log: options.log } : {}),
      });
      if (final !== null && isTerminal(final)) {
        result.finished += 1;
      } else {
        result.stillActive += 1;
      }
    } catch {
      result.errors += 1;
      result.stillActive += 1;
    }
  }
  return result;
}

/**
 * Fail analysis runs orphaned by dead drivers: anything still `running`
 * past the max age cannot be legitimate, because every analysis path runs
 * under an 8-minute deadline. Their invisible partial findings are removed
 * and previous successful runs are untouched, so current results never
 * regress. Without this, pre-existing orphans would read as "running"
 * forever and the UI could never settle.
 */
async function failOrphanedAnalysisRuns(
  options: RecoveryOptions,
  maxAgeMs: number,
): Promise<number> {
  const { runs, findings } = await getAnalysesCollections(
    options.mongodbUri,
    options.mongodbDbName,
  );
  const orphans = await runs
    .find({ status: "running", startedAt: { $lt: new Date(Date.now() - maxAgeMs) } })
    .toArray();
  let failed = 0;
  for (const orphan of orphans) {
    await findings.deleteMany({ runId: orphan._id }).catch(() => undefined);
    const updated = await runs
      .updateOne(
        { _id: orphan._id, status: "running" },
        { $set: { status: "failed", error: "interrupted", finishedAt: new Date() } },
      )
      .catch(() => null);
    if (updated !== null && updated.matchedCount === 1) {
      failed += 1;
    }
  }
  return failed;
}

export interface RecoveryLoopOptions extends RecoveryOptions {
  intervalMs?: number;
}

/**
 * Run recovery once at startup (all active runs: after a restart every one
 * of them is abandoned) and then periodically (stale runs only). For
 * long-lived servers only; serverless deployments trigger recovery through
 * POST /api/processing/recover on a schedule instead. The timer never keeps
 * the process alive on its own.
 */
export function startRecoveryLoop(options: RecoveryLoopOptions): () => void {
  const intervalMs = options.intervalMs ?? RECOVERY_INTERVAL_MS;
  let inFlight = false;
  let stopped = false;
  const sweep = (includeFresh: boolean): void => {
    if (inFlight || stopped) {
      return;
    }
    inFlight = true;
    void recoverProcessingRuns({ ...options, includeFresh })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };
  sweep(true);
  const timer = setInterval(() => sweep(false), intervalMs);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") {
    timer.unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
