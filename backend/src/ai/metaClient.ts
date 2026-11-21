import type { Env } from "../config/env.js";

export interface MetaConfig {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  /** Per-attempt timeout in milliseconds. Respected as configured. */
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Build provider config from the environment, or undefined when the
 * integration is not configured. Never logs the key.
 */
export function metaConfigFromEnv(env: Env): MetaConfig | undefined {
  if (env.metaApiKey === undefined || env.metaModelId === undefined) {
    return undefined;
  }
  return {
    apiKey: env.metaApiKey,
    modelId: env.metaModelId,
    baseUrl: env.metaBaseUrl,
    timeoutMs: env.metaTimeoutMs,
    maxRetries: env.metaMaxRetries,
  };
}

export type MetaErrorCategory =
  | "auth"
  | "model_not_found"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "bad_request"
  | "bad_response"
  | "truncated"
  | "network";

/**
 * Deterministic failures: retrying the same request cannot help, so callers
 * must fail fast instead of burning attempts or moving on to more sections.
 */
export const FATAL_META_CATEGORIES: ReadonlySet<MetaErrorCategory> = new Set([
  "auth",
  "model_not_found",
  "bad_request",
]);

export function isFatalMetaCategory(category: MetaErrorCategory): boolean {
  return FATAL_META_CATEGORIES.has(category);
}

/** Provider failure with a safe category. Never carries secrets or content. */
export class MetaError extends Error {
  readonly category: MetaErrorCategory;
  readonly httpStatus: number | undefined;

  constructor(category: MetaErrorCategory, message: string, httpStatus?: number) {
    super(message);
    this.name = "MetaError";
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  jsonSchema: JsonSchemaSpec;
  /** Caller context echoed back in log events. Never sent to the provider. */
  meta?: {
    sectionId?: string;
    sectionIndex?: number;
    sectionsTotal?: number;
  };
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string | null;
}

/** Sanitized per-attempt telemetry. Never contains keys or content. */
export interface MetaRequestEvent {
  attempt: number;
  sectionId?: string;
  sectionIndex?: number;
  sectionsTotal?: number;
  httpStatus?: number;
  durationMs: number;
  category?: MetaErrorCategory;
}

export interface ChatCompletionOptions {
  sleep?: (ms: number) => Promise<void>;
  baseBackoffMs?: number;
  /** Overall deadline (epoch ms); attempts stop once it passes. */
  deadlineMs?: number;
  now?: () => number;
  log?: (event: MetaRequestEvent) => void;
}

const DEFAULT_BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;
const MAX_RETRY_AFTER_MS = 60000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Parse a Retry-After value (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  if (Number.isInteger(seconds) && seconds >= 0 && String(seconds) === value.trim()) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(dateMs - Date.now(), 0);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function backoffMs(attempt: number, baseBackoffMs: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, 0), MAX_RETRY_AFTER_MS);
  }
  return Math.min(baseBackoffMs * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * POST one OpenAI-compatible chat completion with JSON-schema output. Only
 * parameters verified for the Meta endpoint are sent (`model`, `messages`,
 * `response_format`): sampling parameters such as `temperature` and output
 * controls such as `max_tokens` or `strict` are deliberately omitted.
 * `timeoutMs` bounds each attempt; retries cover transient network errors,
 * timeouts, HTTP 429, and retryable 5xx only, within `maxRetries` attempts.
 * This module never logs keys, headers, or message content.
 */
export async function chatCompletion(
  config: MetaConfig,
  request: ChatCompletionRequest,
  options: ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  const sleep = options.sleep ?? defaultSleep;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const now = options.now ?? Date.now;
  const log = options.log;

  const emit = (event: Omit<MetaRequestEvent, "sectionId" | "sectionIndex" | "sectionsTotal">): void => {
    if (log === undefined) {
      return;
    }
    log({
      ...event,
      ...(request.meta?.sectionId !== undefined ? { sectionId: request.meta.sectionId } : {}),
      ...(request.meta?.sectionIndex !== undefined
        ? { sectionIndex: request.meta.sectionIndex }
        : {}),
      ...(request.meta?.sectionsTotal !== undefined
        ? { sectionsTotal: request.meta.sectionsTotal }
        : {}),
    });
  };

  let attempt = 0;
  for (;;) {
    if (options.deadlineMs !== undefined && now() >= options.deadlineMs) {
      throw new MetaError("timeout", "Model request deadline reached.");
    }
    const started = now();
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        res = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.modelId,
            messages: request.messages,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.jsonSchema.name,
                schema: request.jsonSchema.schema,
              },
            },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err: unknown) {
      const category: MetaErrorCategory =
        err instanceof Error && err.name === "AbortError" ? "timeout" : "network";
      const failure = new MetaError(
        category,
        category === "timeout"
          ? `Model request timed out after ${config.timeoutMs} ms.`
          : "Model request failed.",
      );
      emit({ attempt: attempt + 1, durationMs: now() - started, category });
      if (attempt >= config.maxRetries) {
        throw failure;
      }
      attempt += 1;
      await sleep(backoffMs(attempt - 1, baseBackoffMs));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      emit({ attempt: attempt + 1, httpStatus: res.status, durationMs: now() - started, category: "auth" });
      throw new MetaError("auth", "Model authentication failed.", res.status);
    }
    if (res.status === 404) {
      emit({
        attempt: attempt + 1,
        httpStatus: res.status,
        durationMs: now() - started,
        category: "model_not_found",
      });
      throw new MetaError("model_not_found", "Model was not found.", res.status);
    }
    if (RETRYABLE_STATUSES.has(res.status)) {
      const category: MetaErrorCategory = res.status === 429 ? "rate_limited" : "unavailable";
      emit({ attempt: attempt + 1, httpStatus: res.status, durationMs: now() - started, category });
      if (attempt >= config.maxRetries) {
        throw new MetaError(
          category,
          category === "rate_limited"
            ? "Model rate limit exceeded."
            : `Model service unavailable (HTTP ${res.status}).`,
          res.status,
        );
      }
      const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
      attempt += 1;
      await sleep(backoffMs(attempt - 1, baseBackoffMs, retryAfter));
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      emit({
        attempt: attempt + 1,
        httpStatus: res.status,
        durationMs: now() - started,
        category: "bad_request",
      });
      throw new MetaError(
        "bad_request",
        `Model request rejected (HTTP ${res.status}).`,
        res.status,
      );
    }

    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      emit({
        attempt: attempt + 1,
        httpStatus: res.status,
        durationMs: now() - started,
        category: "bad_response",
      });
      throw new MetaError("bad_response", "Model response was not valid JSON.", res.status);
    }
    const message = extractMessage(body);
    if (message.refusal !== null) {
      emit({
        attempt: attempt + 1,
        httpStatus: res.status,
        durationMs: now() - started,
        category: "bad_response",
      });
      throw new MetaError("bad_response", "Model refused the request.", res.status);
    }
    if (message.finishReason === "length") {
      emit({
        attempt: attempt + 1,
        httpStatus: res.status,
        durationMs: now() - started,
        category: "truncated",
      });
      throw new MetaError("truncated", "Model response was cut off.", res.status);
    }
    if (message.content === null || message.content === "") {
      emit({
        attempt: attempt + 1,
        httpStatus: res.status,
        durationMs: now() - started,
        category: "bad_response",
      });
      throw new MetaError("bad_response", "Model response had no content.", res.status);
    }
    emit({ attempt: attempt + 1, httpStatus: res.status, durationMs: now() - started });
    return { content: message.content, finishReason: message.finishReason };
  }
}

interface ExtractedMessage {
  content: string | null;
  refusal: string | null;
  finishReason: string | null;
}

function extractMessage(payload: unknown): ExtractedMessage {
  const empty: ExtractedMessage = { content: null, refusal: null, finishReason: null };
  if (!isRecord(payload)) {
    return empty;
  }
  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return empty;
  }
  const first = choices[0] as { message?: unknown; finish_reason?: unknown };
  if (!isRecord(first)) {
    return empty;
  }
  const message = isRecord(first["message"]) ? first["message"] : {};
  return {
    content: typeof message["content"] === "string" ? (message["content"] as string) : null,
    refusal: typeof message["refusal"] === "string" ? (message["refusal"] as string) : null,
    finishReason: typeof first["finish_reason"] === "string" ? (first["finish_reason"] as string) : null,
  };
}
