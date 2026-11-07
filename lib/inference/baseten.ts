import { InferenceResponseSchema, type CandidateFinding } from "../findings/schema";
import type { TextSection } from "../text/chunk";
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisUserPrompt, FINDINGS_JSON_SCHEMA } from "./prompts";
import type { AnalyzeInput, AnalyzeResult, InferenceProvider, SectionError } from "./types";

export const DEFAULT_BASE_URL = "https://inference.baseten.co/v1";
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_MAX_RETRIES = 2;

export type BasetenErrorCode =
  | "auth"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "malformed"
  | "refused"
  | "incomplete"
  | "invalid_output";

/**
 * Failure talking to Baseten. `fatal` means retrying other sections is
 * pointless (bad credentials, unknown model) — the pipeline fails the
 * document instead of burning calls. The configured model is never replaced.
 */
export class BasetenProviderError extends Error {
  readonly code: BasetenErrorCode;
  readonly status?: number;
  readonly fatal: boolean;
  readonly retryAfterMs?: number;
  /** Token usage reported with a failed response, when the API includes it. */
  readonly usage?: { promptTokens?: number; completionTokens?: number };

  constructor(
    code: BasetenErrorCode,
    message: string,
    options?: {
      status?: number;
      fatal?: boolean;
      retryAfterMs?: number;
      usage?: { promptTokens?: number; completionTokens?: number };
    },
  ) {
    super(message);
    this.name = "BasetenProviderError";
    this.code = code;
    this.status = options?.status;
    this.fatal = options?.fatal ?? false;
    this.retryAfterMs = options?.retryAfterMs;
    this.usage = options?.usage;
  }
}

export interface BasetenProviderOptions {
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * When true (default), constrain output with a json_schema response_format.
   * Set false for models without structured-output support (e.g. Muse Spark
   * Open): the prompt then requests JSON explicitly and the content is parsed
   * defensively. Either way the Zod schema is the authoritative validator.
   */
  structuredOutputs?: boolean;
  /** Injectable for deterministic tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable sleep for fast retry tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Baseten Model APIs provider (OpenAI-compatible Chat Completions).
 * One request per document section, sequential, with per-attempt timeouts and
 * bounded retries on 429/5xx and network failures only. Models with
 * structured-output support get a json_schema response_format; models without
 * (e.g. Muse Spark Open) get explicit JSON instructions in the prompt and
 * defensive content parsing. Section failures are reported, never hidden.
 */
export class BasetenProvider implements InferenceProvider {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly structuredOutputs: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: BasetenProviderOptions) {
    if (!options.apiKey) throw new BasetenProviderError("auth", "Baseten API key is missing.");
    if (!options.modelId) throw new BasetenProviderError("not_found", "Baseten model id is missing.");
    this.apiKey = options.apiKey;
    this.modelId = options.modelId;
    this.endpoint = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.structuredOutputs = options.structuredOutputs ?? true;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const findings: CandidateFinding[] = [];
    const sectionErrors: SectionError[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let sawUsage = false;
    const addUsage = (usage?: { promptTokens?: number; completionTokens?: number }) => {
      if (!usage) return;
      sawUsage = true;
      promptTokens += usage.promptTokens ?? 0;
      completionTokens += usage.completionTokens ?? 0;
    };
    for (const section of input.sections) {
      try {
        const sectionFindings = await this.analyzeSection(section, input);
        findings.push(...sectionFindings.findings);
        addUsage(sectionFindings.usage);
      } catch (err) {
        if (err instanceof BasetenProviderError && err.fatal) throw err;
        // Failed sections still contribute reported usage, so truncated and
        // refused responses stay diagnosable (counts only, never content).
        if (err instanceof BasetenProviderError) addUsage(err.usage);
        const message = err instanceof Error ? err.message : "Unknown analysis error.";
        sectionErrors.push({
          sectionId: section.id,
          message,
          ...(err instanceof BasetenProviderError ? { code: err.code } : {}),
        });
      }
    }
    return {
      findings,
      sectionErrors,
      ...(sawUsage ? { usage: { promptTokens, completionTokens } } : {}),
    };
  }

  private async analyzeSection(
    section: TextSection,
    input: AnalyzeInput,
  ): Promise<{ findings: CandidateFinding[]; usage?: { promptTokens?: number; completionTokens?: number } }> {
    const messages: ChatMessage[] = [
      { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildAnalysisUserPrompt(
          { sections: [section], categories: input.categories },
          { jsonInPrompt: !this.structuredOutputs },
        ),
      },
    ];
    const body = JSON.stringify({
      model: this.modelId,
      messages,
      temperature: 0,
      ...(this.structuredOutputs
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "due_diligence_findings", strict: false, schema: FINDINGS_JSON_SCHEMA },
            },
          }
        : {}),
    });

    let lastError: BasetenProviderError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const started = Date.now();
      try {
        const response = await this.post(body);
        const parsed = await this.readFindings(response, section.id);
        console.info(
          `[baseten] section=${section.id} findings=${parsed.findings.length} ` +
            `latencyMs=${Date.now() - started} usage=${parsed.usageText} reasoning=${parsed.reasoning}`,
        );
        return { findings: parsed.findings, usage: parsed.usage };
      } catch (err) {
        lastError = err instanceof BasetenProviderError ? err : new BasetenProviderError("network", String(err));
        if (lastError.fatal || attempt === this.maxRetries || !isRetryable(lastError)) break;
        console.info(
          `[baseten] section=${section.id} attempt=${attempt + 1} retryable=${lastError.code} ` +
            `status=${lastError.status ?? "-"} doc=${input.documentLabel}`,
        );
        await this.sleepFn(backoffMs(attempt, lastError.retryAfterMs));
      }
    }
    throw lastError ?? new BasetenProviderError("network", "Baseten request failed.");
  }

  private async post(body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new BasetenProviderError("timeout", `Baseten request timed out after ${this.timeoutMs} ms.`);
      }
      throw new BasetenProviderError("network", `Baseten request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readFindings(
    response: Response,
    sectionId: string,
  ): Promise<{
    findings: CandidateFinding[];
    usage?: { promptTokens?: number; completionTokens?: number };
    usageText: string;
    reasoning: "present" | "absent";
  }> {
    if (response.status === 401 || response.status === 403) {
      const detail = await safeSnippet(response);
      throw new BasetenProviderError(
        "auth",
        `Baseten authentication failed (HTTP ${response.status}). Check BASETEN_API_KEY.` +
          (detail ? ` API says: ${detail}` : ""),
        { status: response.status, fatal: true },
      );
    }
    if (response.status === 404) {
      const detail = await safeSnippet(response);
      throw new BasetenProviderError(
        "not_found",
        `Baseten model "${this.modelId}" was not found (HTTP 404). Check BASETEN_MODEL_ID; no other model was substituted.` +
          (detail ? ` API says: ${detail}` : ""),
        { status: 404, fatal: true },
      );
    }
    if (response.status === 429) {
      throw new BasetenProviderError("rate_limited", "Baseten rate limit exceeded (HTTP 429).", {
        status: 429,
        fatal: false,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      });
    }
    if (response.status >= 500) {
      throw new BasetenProviderError("server", `Baseten server error (HTTP ${response.status}).`, {
        status: response.status,
      });
    }
    if (!response.ok) {
      const detail = await safeSnippet(response);
      throw new BasetenProviderError(
        "bad_request",
        `Baseten request rejected (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BasetenProviderError("malformed", "Baseten returned an unreadable response body.");
    }
    // Parse usage before content checks so failed responses stay diagnosable.
    const usage = parseUsage(payload);
    const message = extractMessage(payload);
    if (message.refusal) {
      throw new BasetenProviderError("refused", `Model refused section ${sectionId}: ${truncate(message.refusal, 300)}`, {
        usage,
      });
    }
    if (message.finishReason === "length") {
      const chars = message.content?.length ?? 0;
      throw new BasetenProviderError(
        "incomplete",
        `Model output was cut off (length limit) for section ${sectionId} after ${chars} chars; findings would be incomplete.`,
        { usage },
      );
    }
    if (!message.content) {
      throw new BasetenProviderError("invalid_output", `Model returned no content for section ${sectionId}.`, {
        usage,
      });
    }
    const contentJson = extractJsonObject(message.content, sectionId);
    const validated = InferenceResponseSchema.safeParse(contentJson);
    if (!validated.success) {
      throw new BasetenProviderError(
        "invalid_output",
        `Model output failed schema validation for section ${sectionId}: ${validated.error.issues[0]?.message ?? "invalid findings"}`,
        { usage },
      );
    }
    return {
      findings: validated.data.findings,
      usage,
      usageText: usage
        ? `${usage.promptTokens ?? "-"}/${usage.completionTokens ?? "-"}`
        : "-/-",
      reasoning: message.hasReasoning ? "present" : "absent",
    };
  }
}

function isRetryable(err: BasetenProviderError): boolean {
  return (
    err.code === "rate_limited" ||
    err.code === "server" ||
    err.code === "timeout" ||
    err.code === "network" ||
    err.code === "malformed" ||
    err.code === "invalid_output"
  );
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(Math.max(retryAfterMs, 0), 60000);
  return Math.min(1000 * 2 ** attempt, 10000);
}

/** Parse a Retry-After header (seconds, possibly fractional) into milliseconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Short error snippet from a rejected response. Bodies here are API errors, never document text. */
async function safeSnippet(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    const compact = text.replace(/\s+/g, " ").trim();
    return compact ? truncate(compact, 200) : null;
  } catch {
    return null;
  }
}

interface ExtractedMessage {
  content: string | null;
  refusal: string | null;
  finishReason: string | null;
  /** Reasoning models (e.g. Muse Spark Open) return `reasoning_content` alongside the answer. */
  hasReasoning: boolean;
}

function extractMessage(payload: unknown): ExtractedMessage {
  const empty: ExtractedMessage = { content: null, refusal: null, finishReason: null, hasReasoning: false };
  if (typeof payload !== "object" || payload === null) return empty;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return empty;
  const first = choices[0] as { message?: unknown; finish_reason?: unknown };
  const message = (first.message ?? {}) as { content?: unknown; refusal?: unknown; reasoning_content?: unknown };
  return {
    content: typeof message.content === "string" ? message.content : null,
    refusal: typeof message.refusal === "string" ? message.refusal : null,
    finishReason: typeof first.finish_reason === "string" ? first.finish_reason : null,
    hasReasoning: typeof message.reasoning_content === "string" && message.reasoning_content.length > 0,
  };
}

/**
 * Extract the JSON object from model content. Only `content` is ever parsed —
 * `reasoning_content` may hold drafts and half-formed quotes and is ignored.
 * Tolerates markdown fences and surrounding prose, then hands the parsed value
 * to Zod, which remains the authoritative validator.
 */
function extractJsonObject(content: string, sectionId: string): unknown {
  const withoutFences = content
    .replace(/^```[a-zA-Z]*\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new BasetenProviderError("invalid_output", `Model returned no JSON object for section ${sectionId}.`);
  }
  try {
    return JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    throw new BasetenProviderError(
      "invalid_output",
      `Model returned malformed JSON for section ${sectionId}.`,
    );
  }
}

function parseUsage(payload: unknown): { promptTokens?: number; completionTokens?: number } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const usage = (payload as { usage?: unknown }).usage as
    | { prompt_tokens?: unknown; completion_tokens?: unknown }
    | undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return { promptTokens, completionTokens };
}
