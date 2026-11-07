import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal `.env` loader for the eval CLI (tsx does not load one, unlike Next).
 * Only fills variables that are not already set; explicit environment wins.
 * Never prints values.
 */
export function loadDotEnvFile(cwd: string = process.cwd()): void {
  const file = `${cwd.replace(/\/+$/, "")}/.env`;
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key !== "" && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export interface EvalCliOptions {
  mode: "mock" | "live";
  dataset: string;
  confirmLive: boolean;
  concurrency: number;
  out: string;
  only: string[];
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export const EVAL_USAGE = `Usage: npm run eval -- --mode <mock|live> [options]

Options:
  --mode <mock|live>    mock: deterministic, no network. live: real Baseten API (requires --confirm-live).
  --dataset <dir>       Fixture directory (default: evals/fixtures).
  --confirm-live        Explicit opt-in for live API calls. Never set in CI by default.
  --concurrency <n>     Parallel fixtures, 1-8 (default: 1 for mock, 2 for live).
  --out <dir>           Report directory (default: evals/reports).
  --only <a,b,c>        Run only these fixture ids; others are reported as skipped.
  --help                Show this message.`;

/** Pure argv parser (argv without node/script entries). Throws CliError on invalid input. */
export function parseEvalArgs(argv: string[]): EvalCliOptions {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`Flag ${flag} requires a value.`);
    }
    return value;
  };
  if (argv.includes("--help")) {
    throw new CliError(EVAL_USAGE);
  }
  const mode = get("--mode");
  if (mode !== "mock" && mode !== "live") {
    throw new CliError("--mode must be 'mock' or 'live'.\n" + EVAL_USAGE);
  }
  const concurrencyRaw = get("--concurrency");
  const concurrencyDefault = mode === "mock" ? 1 : 2;
  const concurrency = concurrencyRaw === undefined ? concurrencyDefault : Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new CliError("--concurrency must be an integer from 1 to 8.");
  }
  const onlyRaw = get("--only");
  const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
  return {
    mode,
    dataset: get("--dataset") ?? "evals/fixtures",
    confirmLive: argv.includes("--confirm-live"),
    concurrency,
    out: get("--out") ?? "evals/reports",
    only,
  };
}
