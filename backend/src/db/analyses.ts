import type { Collection, Db } from "mongodb";
import type { AnalysisRunRecord, FindingRecord } from "../models/analysis.js";
import { getDb } from "./mongodb.js";

export const ANALYSIS_RUNS_COLLECTION_NAME = "analysis_runs";
export const FINDINGS_COLLECTION_NAME = "findings";

/**
 * Index-creation promise, memoized per process. The partial unique index on
 * running runs is the concurrency guard: only one running run per document
 * can exist, so simultaneous starts cannot corrupt analysis state.
 */
let indexesEnsured: Promise<void> | undefined;

async function ensureAnalysesIndexes(db: Db): Promise<void> {
  if (indexesEnsured === undefined) {
    const runs = db.collection<AnalysisRunRecord>(ANALYSIS_RUNS_COLLECTION_NAME);
    const findings = db.collection<FindingRecord>(FINDINGS_COLLECTION_NAME);
    indexesEnsured = Promise.all([
      runs.createIndex(
        { docId: 1 },
        { unique: true, partialFilterExpression: { status: "running" } },
      ),
      runs.createIndex({ matterId: 1, docId: 1, startedAt: -1 }),
      findings.createIndex({ runId: 1 }),
      findings.createIndex({ matterId: 1, docId: 1 }),
    ])
      .then(() => undefined)
      .catch((err: unknown) => {
        indexesEnsured = undefined;
        throw err;
      });
  }
  await indexesEnsured;
}

export interface AnalysesCollections {
  runs: Collection<AnalysisRunRecord>;
  findings: Collection<FindingRecord>;
}

export async function getAnalysesCollections(
  uri: string,
  dbName: string,
): Promise<AnalysesCollections> {
  const db = await getDb(uri, dbName);
  await ensureAnalysesIndexes(db);
  return {
    runs: db.collection<AnalysisRunRecord>(ANALYSIS_RUNS_COLLECTION_NAME),
    findings: db.collection<FindingRecord>(FINDINGS_COLLECTION_NAME),
  };
}
