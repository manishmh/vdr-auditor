#!/usr/bin/env node
/**
 * Evaluation harness CLI. Runs the exact production pipeline over the fixture
 * dataset and writes JSON + Markdown reports. Mock mode is deterministic and
 * offline; live mode calls the configured Baseten model (explicit opt-in).
 *
 *   npm run eval -- --mode mock
 *   npm run eval -- --mode live --dataset evals/fixtures --confirm-live
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { CliError, loadDotEnvFile, parseEvalArgs } from "../lib/eval/cli";
import { loadDataset } from "../lib/eval/loader";
import { buildReport, renderMarkdown } from "../lib/eval/report";
import { runFixtures } from "../lib/eval/runner";
import { BasetenProvider } from "../lib/inference/baseten";
import { MockInferenceProvider } from "../lib/inference/mock";
import type { InferenceProvider } from "../lib/inference/types";

async function main(): Promise<number> {
  loadDotEnvFile();
  let options;
  try {
    options = parseEvalArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof CliError ? err.message : String(err));
    return 2;
  }

  let provider: InferenceProvider;
  if (options.mode === "mock") {
    provider = new MockInferenceProvider();
  } else {
    if (!options.confirmLive) {
      console.error("Live mode requires --confirm-live. Refusing to call the Baseten API without explicit opt-in.");
      return 2;
    }
    const apiKey = process.env.BASETEN_API_KEY;
    const modelId = process.env.BASETEN_MODEL_ID;
    if (!apiKey || !modelId) {
      console.error("Live mode requires BASETEN_API_KEY and BASETEN_MODEL_ID in the environment.");
      return 2;
    }
    provider = new BasetenProvider({
      apiKey,
      modelId,
      baseUrl: process.env.BASETEN_BASE_URL || undefined,
      timeoutMs: parseOptionalInt(process.env.BASETEN_TIMEOUT_MS),
      maxRetries: parseOptionalInt(process.env.BASETEN_MAX_RETRIES),
      structuredOutputs: parseOptionalBool(process.env.BASETEN_STRUCTURED_OUTPUTS) ?? true,
    });
  }

  const dataset = await loadDataset(options.dataset).catch((err: Error) => {
    console.error(`Dataset error: ${err.message}`);
    return null;
  });
  if (!dataset) return 2;
  if (options.only.length > 0) {
    const known = new Set(dataset.fixtures.map((f) => f.id));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      console.error(`Unknown fixture ids: ${unknown.join(", ")}`);
      return 2;
    }
  }

  console.info(
    `[eval] mode=${options.mode} model=${provider.modelId} dataset=${dataset.version} ` +
      `fixtures=${dataset.fixtures.length} concurrency=${options.concurrency}`,
  );
  const run = await runFixtures({
    fixtures: dataset.fixtures,
    mode: options.mode,
    makeProvider: () => provider,
    concurrency: options.concurrency,
    only: options.only.length > 0 ? options.only : undefined,
  });
  const report = buildReport({
    datasetVersion: dataset.version,
    mode: options.mode,
    modelId: run.modelId,
    fixtures: dataset.fixtures,
    outcomes: run.outcomes,
  });

  const outDir = path.resolve(options.out);
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${report.runId}.json`);
  const mdPath = path.join(outDir, `${report.runId}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");

  const m = report.metrics;
  console.info(
    `[eval] run=${report.runId} microF1=${formatMetric(m.micro.f1)} ` +
      `completed=${m.counts.completed} partial=${m.counts.partial} failed=${m.counts.failed} ` +
      `skipped=${m.counts.skipped} ambiguous=${m.counts.ambiguous}`,
  );
  console.info(`[eval] reports: ${jsonPath} ${mdPath}`);
  return 0;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseOptionalBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`[eval] crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
