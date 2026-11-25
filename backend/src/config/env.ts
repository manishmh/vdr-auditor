import {
  ANALYSIS_CONCURRENCY,
  ANALYSIS_MAX_FINDINGS_PER_RUN,
  ANALYSIS_MAX_SECTIONS,
  ANALYSIS_SECTION_CHARS,
} from "../ai/analysis.js";

export interface Env {
  nodeEnv: string;
  port: number;
  frontendOrigin: string;
  mongodbUri: string | undefined;
  mongodbDbName: string;
  maxPdfBytes: number;
  metaApiKey: string | undefined;
  metaModelId: string | undefined;
  metaBaseUrl: string;
  metaTimeoutMs: number;
  metaMaxRetries: number;
  analysisSectionChars: number;
  analysisMaxSections: number;
  analysisConcurrency: number;
  analysisMaxFindings: number;
}

const DEFAULT_PORT = 4000;
const DEFAULT_DB_NAME = "vdr_auditor";
const DEFAULT_MAX_PDF_BYTES = 25 * 1024 * 1024;
const DEFAULT_META_BASE_URL = "https://api.meta.ai/v1";
/**
 * Per-attempt model timeout. Analysis sends small bounded sections, so a
 * 60s attempt budget is ample; the configured value is respected as-is and
 * long documents are bounded by section count plus an overall run deadline
 * instead of an inflated per-call timeout.
 */
const DEFAULT_META_TIMEOUT_MS = 60000;
const DEFAULT_META_MAX_RETRIES = 2;

function missing(name: string): Error {
  return new Error(
    `Missing required environment variable: ${name}. ` +
      `Copy backend/.env.example to backend/.env and set a value.`,
  );
}

/**
 * Validate and normalize process environment. Only names values that are
 * safe to log; never include secret values in error messages.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeMajor = Number.parseInt((process.versions.node.split(".")[0] ?? "").trim(), 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    // pdfjs-dist requires Node >=22.13; on older runtimes PDF parsing throws
    // at extraction time and every document fails as unparseable. Fail loud
    // at boot instead of serving a broken extractor.
    throw new Error(
      `Invalid runtime: this backend requires Node.js 22 or newer (running on ${process.versions.node}).`,
    );
  }
  const frontendOrigin = source["FRONTEND_ORIGIN"];
  if (frontendOrigin === undefined || frontendOrigin === "") {
    throw missing("FRONTEND_ORIGIN");
  }

  let port = DEFAULT_PORT;
  const rawPort = source["PORT"];
  if (rawPort !== undefined && rawPort !== "") {
    const parsed = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(
        `Invalid environment variable: PORT must be an integer between 1 and 65535.`,
      );
    }
    port = parsed;
  }

  const mongodbUri = source["MONGODB_URI"];
  const mongodbDbName =
    source["MONGODB_DB_NAME"] === undefined || source["MONGODB_DB_NAME"] === ""
      ? DEFAULT_DB_NAME
      : (source["MONGODB_DB_NAME"] as string);

  const metaApiKey = source["META_API_KEY"];
  const metaModelId = source["META_MODEL_ID"];

  return {
    nodeEnv: source["NODE_ENV"] ?? "development",
    port,
    frontendOrigin,
    mongodbUri: mongodbUri === "" ? undefined : mongodbUri,
    mongodbDbName,
    maxPdfBytes: parseBoundedInt(
      source["MAX_PDF_BYTES"],
      "MAX_PDF_BYTES",
      DEFAULT_MAX_PDF_BYTES,
      1,
      512 * 1024 * 1024,
    ),
    metaApiKey: metaApiKey === "" ? undefined : metaApiKey,
    metaModelId: metaModelId === "" ? undefined : metaModelId,
    metaBaseUrl: parseBaseUrl(source["META_BASE_URL"]),
    metaTimeoutMs: parseBoundedInt(
      source["META_TIMEOUT_MS"],
      "META_TIMEOUT_MS",
      DEFAULT_META_TIMEOUT_MS,
      1000,
      600000,
    ),
    metaMaxRetries: parseBoundedInt(
      source["META_MAX_RETRIES"],
      "META_MAX_RETRIES",
      DEFAULT_META_MAX_RETRIES,
      0,
      5,
    ),
    analysisSectionChars: parseBoundedInt(
      source["ANALYSIS_SECTION_CHARS"],
      "ANALYSIS_SECTION_CHARS",
      ANALYSIS_SECTION_CHARS,
      1000,
      100000,
    ),
    analysisMaxSections: parseBoundedInt(
      source["ANALYSIS_MAX_SECTIONS"],
      "ANALYSIS_MAX_SECTIONS",
      ANALYSIS_MAX_SECTIONS,
      1,
      1000,
    ),
    analysisConcurrency: parseBoundedInt(
      source["ANALYSIS_CONCURRENCY"],
      "ANALYSIS_CONCURRENCY",
      ANALYSIS_CONCURRENCY,
      1,
      8,
    ),
    analysisMaxFindings: parseBoundedInt(
      source["ANALYSIS_MAX_FINDINGS"],
      "ANALYSIS_MAX_FINDINGS",
      ANALYSIS_MAX_FINDINGS_PER_RUN,
      10,
      1000,
    ),
  };
}

function parseBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    return DEFAULT_META_BASE_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "Invalid environment variable: META_BASE_URL must be a valid URL.",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      "Invalid environment variable: META_BASE_URL must use https.",
    );
  }
  return raw.replace(/\/+$/, "");
}

function parseBoundedInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid environment variable: ${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return parsed;
}
