export interface Env {
  nodeEnv: string;
  port: number;
  frontendOrigin: string;
  mongodbUri: string | undefined;
  mongodbDbName: string;
  maxPdfBytes: number;
}

const DEFAULT_PORT = 4000;
const DEFAULT_DB_NAME = "vdr_auditor";
const DEFAULT_MAX_PDF_BYTES = 25 * 1024 * 1024;

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
  };
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
