import path from "node:path";
import { z } from "zod";
import { getMongoUriTlsWarning } from "./mongo-uri";

const EnvSchema = z.object({
  INFERENCE_PROVIDER: z.enum(["mock", "baseten"]).default("mock"),
  BASETEN_API_KEY: z.string().min(1).optional(),
  BASETEN_MODEL_ID: z.string().min(1).optional(),
  BASETEN_BASE_URL: z.string().url().default("https://inference.baseten.co/v1"),
  BASETEN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
  BASETEN_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  BASETEN_STRUCTURED_OUTPUTS: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  MAX_PDF_PAGES: z.coerce.number().int().positive().default(200),
  STORAGE_DIR: z.string().min(1).default(".data"),
  STORAGE_BACKEND: z.enum(["local", "mongodb"]).default("local"),
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_DB: z.string().min(1).default("vdr_auditor"),
  /** Single allowed browser origin for API CORS. Required in production. */
  FRONTEND_ORIGIN: z.string().url().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /**
   * Shared pilot access token (Bearer) required by every API route when set.
   * Single-tenant gate only — no per-user isolation. Required in production.
   */
  PILOT_ACCESS_TOKEN: z.string().min(32).optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;

/** Validated server-side config. Throws on invalid env. Never import from client code. */
export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const config = parsed.data;
  if (config.INFERENCE_PROVIDER === "baseten" && (!config.BASETEN_API_KEY || !config.BASETEN_MODEL_ID)) {
    throw new Error("Invalid environment: BASETEN_API_KEY and BASETEN_MODEL_ID are required when INFERENCE_PROVIDER=baseten");
  }
  if (config.INFERENCE_PROVIDER === "baseten" && new URL(config.BASETEN_BASE_URL).protocol !== "https:") {
    throw new Error("Invalid environment: BASETEN_BASE_URL must use https when INFERENCE_PROVIDER=baseten");
  }
  if (env.DATABASE_URL !== undefined) {
    throw new Error("Invalid environment: DATABASE_URL was removed with PostgreSQL; use MONGODB_URI instead");
  }
  if (config.STORAGE_BACKEND === "mongodb" && !config.MONGODB_URI) {
    throw new Error("Invalid environment: MONGODB_URI is required when STORAGE_BACKEND=mongodb");
  }
  if (config.MONGODB_URI !== undefined && !/^mongodb(\+srv)?:\/\//.test(config.MONGODB_URI)) {
    throw new Error("Invalid environment: MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string");
  }
  if (isUnderPublicDir(config.STORAGE_DIR)) {
    throw new Error("Invalid environment: STORAGE_DIR must not be inside public/ (uploads would be served statically)");
  }
  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnv === "production" && !config.PILOT_ACCESS_TOKEN) {
    throw new Error("Invalid environment: PILOT_ACCESS_TOKEN is required when NODE_ENV=production");
  }
  if (nodeEnv === "production" && !config.FRONTEND_ORIGIN) {
    throw new Error("Invalid environment: FRONTEND_ORIGIN is required when NODE_ENV=production");
  }
  if (
    nodeEnv === "production" &&
    config.STORAGE_BACKEND === "mongodb" &&
    config.MONGODB_URI !== undefined
  ) {
    // Fail closed at boot instead of dying mid-handshake: a remote
    // mongodb:// URI without TLS passes the scheme check above, then the
    // Atlas handshake aborts with `tlsv1 alert internal error` on the
    // first database request. The message names the host only, never
    // credentials (see getMongoUriTlsWarning).
    const tlsWarning = getMongoUriTlsWarning(config.MONGODB_URI);
    if (tlsWarning) throw new Error(`Invalid environment: ${tlsWarning}`);
  }
  if (nodeEnv === "production" && config.STORAGE_BACKEND === "local") {
    // Warning only (not a throw: local remains valid for tests and
    // one-off jobs): on serverless the filesystem is ephemeral, so a
    // production compose with the local JSON store silently loses
    // documents across invocations. Production deploys must use mongodb.
    console.warn(
      "[config] STORAGE_BACKEND=local with NODE_ENV=production loses data across serverless invocations; use STORAGE_BACKEND=mongodb.",
    );
  }
  if (env === process.env) cached = config;
  return config;
}

/** True when the resolved storage dir is the public dir or anything under it. */
function isUnderPublicDir(storageDir: string): boolean {
  const storage = path.resolve(storageDir);
  const pub = path.resolve("public");
  return storage === pub || path.relative(pub, storage).split(path.sep)[0] !== "..";
}

/** Test hook: clear the cached config. */
export function resetConfigCache(): void {
  cached = null;
}
