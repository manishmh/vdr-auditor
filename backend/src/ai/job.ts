import { ObjectId } from "mongodb";
import type { AnalysesCollections } from "../db/analyses.js";
import type { Collection } from "mongodb";
import {
  FINDINGS_JSON_SCHEMA,
  analyzePages,
  type ModelCallMeta,
} from "./analysis.js";
import {
  chatCompletion,
  type MetaConfig,
  type MetaRequestEvent,
} from "./metaClient.js";
import type { DocumentRecord } from "../models/document.js";
import { PAGE_SEPARATOR } from "../extraction/service.js";
import {
  toAnalysisRunResponse,
  toFindingResponse,
  type AnalysisRun,
  type Finding,
} from "../models/analysis.js";

export type AnalysisJobOutcome =
  | { ok: true; run: AnalysisRun; findings: Finding[]; sectionsTotal: number; sectionsFailed: number }
  | {
      ok: false;
      code:
        | "not_found"
        | "in_progress"
        | "no_usable_text"
        | "unavailable"
        | "internal"
        | "auth"
        | "model_not_found"
        | "rate_limited"
        | "timeout"
        | "bad_request"
        | "bad_response"
        | "truncated"
        | "network";
    };

export type AnalysisModelCall = (
  messages: { role: "system" | "user"; content: string }[],
  meta: ModelCallMeta,
) => Promise<string>;

export interface AnalysisJobInput {
  documents: Collection<DocumentRecord>;
  analyses: AnalysesCollections;
  meta: MetaConfig;
  matterId: ObjectId;
  docId: ObjectId;
  complete?: AnalysisModelCall;
  /**
   * Epoch ms; sections not started before it are skipped and reported, never
   * faked. Bounds the whole run regardless of section count.
   */
  deadlineMs?: number;
  /**
   * Fail pre-existing running runs for this document as interrupted instead
   * of refusing with in_progress. Only the processing driver (which holds an
   * exclusive claim on the document's work) may adopt: anything still marked
   * running under its claim is stale by construction.
   */
  adoptStale?: boolean;
  log?: (event: MetaRequestEvent) => void;
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

function defaultLog(event: MetaRequestEvent): void {
  console.log(JSON.stringify({ scope: "meta", ...event }));
}

async function defaultComplete(
  meta: MetaConfig,
  log: (event: MetaRequestEvent) => void,
  deadlineMs: number | undefined,
  messages: { role: "system" | "user"; content: string }[],
  callMeta: ModelCallMeta,
): Promise<string> {
  const result = await chatCompletion(
    meta,
    {
      messages,
      jsonSchema: FINDINGS_JSON_SCHEMA,
      meta: {
        sectionId: callMeta.sectionId,
        sectionIndex: callMeta.sectionIndex,
        sectionsTotal: callMeta.sectionsTotal,
      },
    },
    { log, ...(deadlineMs !== undefined ? { deadlineMs } : {}) },
  );
  return result.content;
}

/**
 * Run one document analysis job: validate eligibility, create a guarded run,
 * call the model over the persisted extraction output section by section,
 * verify and persist findings. Shared by the HTTP endpoint and the
 * background processing driver, so both paths persist identical state. Never
 * throws for expected outcomes; unexpected driver errors propagate to the
 * caller.
 *
 * Findings are persisted only for runs with usable output (completed or
 * limited). A failed run persists nothing, so the previous successful run's
 * findings stay current; the routes only ever read completed/limited runs.
 */
export async function runAnalysisJob(input: AnalysisJobInput): Promise<AnalysisJobOutcome> {
  const { documents, analyses, meta, matterId, docId } = input;
  const log = input.log ?? defaultLog;
  const complete =
    input.complete ??
    ((messages, callMeta) => defaultComplete(meta, log, input.deadlineMs, messages, callMeta));
  const { runs, findings } = analyses;

  const doc = await documents.findOne({ _id: docId, matterId });
  if (doc === null) {
    return { ok: false, code: "not_found" };
  }
  if (doc.extractionStatus === "processing") {
    return { ok: false, code: "in_progress" };
  }
  if (doc.extractionStatus !== "completed" || doc.extractedText === undefined) {
    return { ok: false, code: "no_usable_text" };
  }
  if (input.adoptStale === true) {
    await adoptStaleRuns(runs, findings, matterId, docId);
  }
  const runId = new ObjectId();
  const startedAt = new Date();
  try {
    await runs.insertOne({
      _id: runId,
      matterId,
      docId,
      status: "running",
      limitations: [],
      startedAt,
    });
  } catch (err: unknown) {
    if (isDuplicateKey(err)) {
      return { ok: false, code: "in_progress" };
    }
    throw err;
  }
  const failRun = async (code: string): Promise<void> => {
    await runs
      .updateOne(
        { _id: runId },
        { $set: { status: "failed", error: code, finishedAt: new Date() } },
      )
      .catch(() => undefined);
  };
  // Analyze the persisted extraction output so section boundaries and page
  // references match exactly what is stored.
  const pages = (doc.extractedText as string).split(PAGE_SEPARATOR);
  let outcome;
  try {
    outcome = await analyzePages(pages, complete, {
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
      // Live progress for the UI. Best-effort: a failed write must never
      // break analysis, and the final update below always overwrites these.
      onProgress: (progress) => {
        void runs
          .updateOne(
            { _id: runId },
            {
              $set: {
                sectionsAnalyzed: progress.sectionsDone,
                sectionsTotal: progress.sectionsTotal,
                pagesAnalyzed: progress.pagesCovered,
                totalPages: progress.totalPages,
              },
            },
          )
          .catch(() => undefined);
      },
    });
    // The document may have been deleted while the model calls ran; never
    // persist findings for a document that no longer exists.
    const stillThere = await documents.findOne({ _id: docId, matterId });
    if (stillThere === null) {
      await failRun("internal");
      return { ok: false, code: "not_found" };
    }
  } catch (err: unknown) {
    // analyzePages only throws for programmer errors; anything else is a bug.
    console.error("analysis pipeline threw unexpectedly:", err);
    await failRun("internal");
    return { ok: false, code: "internal" };
  }
  if (outcome.fatal !== undefined && outcome.findings.length === 0) {
    await failRun(outcome.fatal);
    return { ok: false, code: outcome.fatal as AnalysisJobOutcomeFailureCode };
  }
  if (outcome.stats.sectionsAnalyzed === 0 && outcome.findings.length === 0) {
    // No usable output at all. With section errors, the first one names the
    // cause; without any (only the deadline skips sections before analysis),
    // the run simply ran out of time.
    const code = outcome.sectionErrors[0]?.code ?? "timeout";
    await failRun(code);
    return { ok: false, code: code as AnalysisJobOutcomeFailureCode };
  }
  try {
    const now = new Date();
    if (outcome.findings.length > 0) {
      await findings.insertMany(
        outcome.findings.map((finding) => ({
          _id: new ObjectId(),
          runId,
          matterId,
          docId,
          category: finding.category,
          severity: finding.severity,
          title: finding.title,
          explanation: finding.explanation,
          excerpt: finding.excerpt,
          page: finding.page,
          ...(finding.counterEvidence !== undefined
            ? { counterEvidence: finding.counterEvidence }
            : {}),
          ...(finding.uncertainty !== undefined
            ? { uncertainty: finding.uncertainty }
            : {}),
          reviewStatus: "open" as const,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    const status = outcome.limited ? "limited" : "completed";
    const sectionsAnalyzed = outcome.stats.sectionsAnalyzed + outcome.stats.sectionsFailed;
    const sectionsTotal = outcome.stats.sectionsPlanned;
    await runs.updateOne(
      { _id: runId },
      {
        $set: {
          status,
          pagesAnalyzed: outcome.pagesAnalyzed,
          totalPages: outcome.totalPages,
          sectionsAnalyzed,
          sectionsTotal,
          limitations: outcome.limitations,
          finishedAt: now,
        },
      },
    );
    const stored = await findings.find({ runId }).toArray();
    return {
      ok: true,
      run: toAnalysisRunResponse({
        _id: runId,
        matterId,
        docId,
        status,
        pagesAnalyzed: outcome.pagesAnalyzed,
        totalPages: outcome.totalPages,
        sectionsAnalyzed,
        sectionsTotal,
        limitations: outcome.limitations,
        startedAt,
        finishedAt: now,
      }),
      findings: stored.map((finding: (typeof stored)[number]) =>
        toFindingResponse(finding, doc.filename),
      ),
      sectionsTotal: outcome.stats.sectionsTotal,
      sectionsFailed: outcome.stats.sectionsFailed,
    };
  } catch (err: unknown) {
    console.error("analysis persist failed:", err);
    await failRun("internal");
    return { ok: false, code: "internal" };
  }
}

type AnalysisJobOutcomeFailureCode = Extract<
  AnalysisJobOutcome,
  { ok: false }
>["code"];

/**
 * Fail running runs left behind by a dead driver and remove their invisible
 * partial findings (only completed/limited runs are ever read). Previous
 * successful runs are untouched, so their findings stay current until this
 * run produces usable output.
 */
async function adoptStaleRuns(
  runs: AnalysesCollections["runs"],
  findings: AnalysesCollections["findings"],
  matterId: ObjectId,
  docId: ObjectId,
): Promise<void> {
  const stale = await runs.find({ matterId, docId, status: "running" }).toArray();
  for (const run of stale) {
    await findings.deleteMany({ runId: run._id }).catch(() => undefined);
    await runs
      .updateOne(
        { _id: run._id },
        { $set: { status: "failed", error: "interrupted", finishedAt: new Date() } },
      )
      .catch(() => undefined);
  }
}
