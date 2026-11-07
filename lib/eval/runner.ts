import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceProvider } from "../inference/types";
import { analyzeAndPersist } from "../pipeline";
import { LocalFileStore } from "../store/local";
import type { EvalFixture } from "./dataset";
import type { FixtureOutcome } from "./types";

export interface RunOptions {
  fixtures: EvalFixture[];
  mode: "mock" | "live";
  makeProvider: () => InferenceProvider;
  /** Max parallel fixtures. Use 1 for deterministic mock runs. */
  concurrency?: number;
  /** When set, only these fixture ids run; the rest are reported as skipped. */
  only?: string[];
  /** Scratch store root. Defaults to a fresh tmp dir, removed after the run. */
  workDir?: string;
}

export interface CompletedRun {
  outcomes: FixtureOutcome[];
  modelId: string;
}

/**
 * Execute the exact production pipeline (analyze → validate → verify → persist)
 * for every fixture. Each fixture runs in an isolated scratch store that is
 * removed afterwards. Failures are captured per fixture, never thrown.
 */
export async function runFixtures(options: RunOptions): Promise<CompletedRun> {
  const provider = options.makeProvider();
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 1));
  const only = options.only ? new Set(options.only) : null;
  const dir = options.workDir ?? (await mkdtemp(join(tmpdir(), "vdr-eval-")));
  const store = new LocalFileStore(dir);
  const outcomes: FixtureOutcome[] = new Array(options.fixtures.length);

  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, options.fixtures.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= options.fixtures.length) return;
      const fixture = options.fixtures[index];
      outcomes[index] =
        only && !only.has(fixture.id)
          ? {
              fixtureId: fixture.id,
              status: "skipped",
              latencyMs: 0,
              findings: [],
              droppedInvalid: 0,
              droppedUnverified: 0,
              sectionErrors: [],
            }
          : await runOneFixture(store, provider, fixture);
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    if (!options.workDir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { outcomes, modelId: provider.modelId };
}

async function runOneFixture(
  store: LocalFileStore,
  provider: InferenceProvider,
  fixture: EvalFixture,
): Promise<FixtureOutcome> {
  const started = Date.now();
  try {
    const text = fixture.pages.map((p) => p.text).join("\n");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const document = await store.createDocument({
      filename: `${fixture.id}.eval.pdf`,
      mimeType: "application/pdf",
      sizeBytes: new TextEncoder().encode(text).length,
      sha256,
      source: "upload",
    });
    await store.updateDocument(document.id, { status: "processing" });
    await store.savePages(
      document.id,
      fixture.pages.map((p) => ({ pageNumber: p.pageNumber, text: p.text })),
    );
    const outcome = await analyzeAndPersist(store, provider, document, fixture.pages, fixture.pages.length);
    const status = outcome.document.status;
    return {
      fixtureId: fixture.id,
      status: status === "completed" || status === "partial" ? status : "failed",
      latencyMs: Date.now() - started,
      findings: outcome.findings,
      droppedInvalid: outcome.droppedInvalid,
      droppedUnverified: outcome.droppedUnverified,
      sectionErrors: outcome.sectionErrors,
      usage: outcome.usage,
      error: status === "failed" ? (outcome.document.statusDetail ?? "analysis failed") : undefined,
    };
  } catch (err) {
    return {
      fixtureId: fixture.id,
      status: "failed",
      latencyMs: Date.now() - started,
      findings: [],
      droppedInvalid: 0,
      droppedUnverified: 0,
      sectionErrors: [],
      error: err instanceof Error ? err.message : "unknown harness error",
    };
  }
}
