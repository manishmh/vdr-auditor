import { ObjectId } from "mongodb";

export const PROCESSING_STAGES = [
  "queued",
  "extracting",
  "analyzing",
  "completed",
  "completed_with_limits",
  "failed",
] as const;
export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export const TERMINAL_PROCESSING_STAGES: readonly ProcessingStage[] = [
  "completed",
  "completed_with_limits",
  "failed",
];

export function isTerminalProcessingStage(stage: ProcessingStage): boolean {
  return (TERMINAL_PROCESSING_STAGES as readonly string[]).includes(stage);
}

/**
 * One upload-to-findings pipeline run for a single document. The single
 * source of truth for automatic processing state; the UI and recovery logic
 * read it, the driver advances it. `active` is false exactly for terminal
 * stages, which lets a partial unique index forbid duplicate active runs.
 */
export interface ProcessingRunRecord {
  _id: ObjectId;
  matterId: ObjectId;
  docId: ObjectId;
  stage: ProcessingStage;
  active: boolean;
  attempts: number;
  error?: string;
  note?: string;
  heartbeatAt: Date;
  claimedAt?: Date;
  startedAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
}

export interface ProcessingRun {
  id: string;
  matterId: string;
  docId: string;
  stage: ProcessingStage;
  active: boolean;
  attempts: number;
  error?: string;
  note?: string;
  heartbeatAt: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export function toProcessingRunResponse(run: ProcessingRunRecord): ProcessingRun {
  return {
    id: run._id.toHexString(),
    matterId: run.matterId.toHexString(),
    docId: run.docId.toHexString(),
    stage: run.stage,
    active: run.active,
    attempts: run.attempts,
    error: run.error,
    note: run.note,
    heartbeatAt: run.heartbeatAt.toISOString(),
    startedAt: run.startedAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
  };
}
