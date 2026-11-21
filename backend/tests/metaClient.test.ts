import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaError,
  chatCompletion,
  metaConfigFromEnv,
  parseRetryAfterMs,
  type MetaConfig,
  type MetaRequestEvent,
} from "../src/ai/metaClient.js";
import { loadEnv } from "../src/config/env.js";

const CONFIG: MetaConfig = {
  apiKey: "test-key-not-real",
  modelId: "test-model",
  baseUrl: "https://api.example.test/v1",
  timeoutMs: 5000,
  maxRetries: 2,
};

const REQUEST = {
  messages: [{ role: "user" as const, content: "hi" }],
  jsonSchema: {
    name: "flag",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  },
};

const instant = { sleep: async () => undefined, baseBackoffMs: 0 };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function completion(content: string, finishReason: string | null = "stop"): unknown {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("metaConfigFromEnv", () => {
  it("returns undefined without key or model", () => {
    expect(metaConfigFromEnv(loadEnv({ FRONTEND_ORIGIN: "http://x" }))).toBeUndefined();
    expect(
      metaConfigFromEnv(
        loadEnv({ FRONTEND_ORIGIN: "http://x", META_API_KEY: "k" }),
      ),
    ).toBeUndefined();
  });

  it("builds config with safe defaults", () => {
    const config = metaConfigFromEnv(
      loadEnv({
        FRONTEND_ORIGIN: "http://x",
        META_API_KEY: "k",
        META_MODEL_ID: "m",
      }),
    );
    expect(config).toMatchObject({
      modelId: "m",
      baseUrl: "https://api.meta.ai/v1",
      timeoutMs: 60000,
      maxRetries: 2,
    });
  });
});

describe("parseRetryAfterMs", () => {
  it("parses seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses HTTP dates", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfterMs(future);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(5000);
  });

  it("rejects garbage", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("chatCompletion", () => {
  it("sends an OpenAI-compatible request and returns content", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, completion('{"ok":true}')),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletion(CONFIG, REQUEST, instant);
    expect(result).toEqual({ content: '{"ok":true}', finishReason: "stop" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer test-key-not-real");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Only verified parameters: undocumented sampling/output controls are omitted.
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "response_format"]);
    expect(body).toMatchObject({ model: "test-model" });
    expect(body["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "flag", schema: REQUEST.jsonSchema.schema },
    });
  });

  it("does not retry auth, missing-model, or validation errors", async () => {
    const cases: Array<{ status: number; category: string }> = [
      { status: 400, category: "bad_request" },
      { status: 401, category: "auth" },
      { status: 403, category: "auth" },
      { status: 404, category: "model_not_found" },
      { status: 422, category: "bad_request" },
    ];
    for (const { status, category } of cases) {
      const fetchMock = vi.fn(async () => jsonResponse(status, { error: "x" }));
      vi.stubGlobal("fetch", fetchMock);
      const err = await chatCompletion(CONFIG, REQUEST, instant).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MetaError);
      expect((err as MetaError).category).toBe(category);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("retries 429 and succeeds", async () => {
    const fetchMock = vi.fn();
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, {}, { "retry-after": "0" })
        : jsonResponse(200, completion("{}"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletion(CONFIG, REQUEST, instant);
    expect(result.content).toBe("{}");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx up to the bound then fails unavailable", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, {}));
    vi.stubGlobal("fetch", fetchMock);
    const err = await chatCompletion({ ...CONFIG, maxRetries: 1 }, REQUEST, instant).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MetaError);
    expect((err as MetaError).category).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries network errors within the bound", async () => {
    const fetchMock = vi.fn();
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse(200, completion("{}"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletion(CONFIG, REQUEST, instant);
    expect(result.content).toBe("{}");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out within budget without hanging", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = chatCompletion(
      { ...CONFIG, timeoutMs: 100, maxRetries: 0 },
      REQUEST,
      { sleep: async () => undefined },
    );
    // Attach before advancing: the abort fires on the fake clock.
    const settled = pending.then(
      () => new Error("expected a timeout"),
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;
    expect(err).toBeInstanceOf(MetaError);
    expect((err as MetaError).category).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops attempts once the run deadline passes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, completion("{}")));
    vi.stubGlobal("fetch", fetchMock);
    const err = await chatCompletion(CONFIG, REQUEST, {
      ...instant,
      deadlineMs: Date.now() - 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaError);
    expect((err as MetaError).category).toBe("timeout");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed and empty responses without retrying", async () => {
    const cases: Array<() => Response> = [
      () => new Response("not json", { status: 200 }),
      () => jsonResponse(200, {}),
      () => jsonResponse(200, { choices: [] }),
      () => jsonResponse(200, completion("", "stop")),
    ];
    for (const build of cases) {
      const fetchMock = vi.fn(async () => build());
      vi.stubGlobal("fetch", fetchMock);
      const err = await chatCompletion(CONFIG, REQUEST, instant).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MetaError);
      expect((err as MetaError).category).toBe("bad_response");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects truncated responses without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, completion('{"partial":', "length")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const err = await chatCompletion(CONFIG, REQUEST, instant).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaError);
    expect((err as MetaError).category).toBe("truncated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs sanitized attempt telemetry with section context", async () => {
    const events: MetaRequestEvent[] = [];
    const fetchMock = vi.fn(async () => jsonResponse(200, completion("{}")));
    vi.stubGlobal("fetch", fetchMock);
    await chatCompletion(
      CONFIG,
      {
        ...REQUEST,
        messages: [{ role: "user", content: "SECRET-DOCUMENT-CONTENT" }],
        meta: { sectionId: "s2", sectionIndex: 1, sectionsTotal: 3 },
      },
      { ...instant, log: (event) => events.push(event) },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      attempt: 1,
      sectionId: "s2",
      sectionIndex: 1,
      sectionsTotal: 3,
      httpStatus: 200,
    });
    expect(typeof events[0]?.durationMs).toBe("number");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("SECRET-DOCUMENT-CONTENT");
    expect(serialized).not.toContain("test-key-not-real");
  });

  it("never includes secrets or content in error surfaces", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    const err = (await chatCompletion(
      { ...CONFIG, maxRetries: 0 },
      {
        ...REQUEST,
        messages: [{ role: "user", content: "SECRET-DOCUMENT-CONTENT" }],
      },
      instant,
    ).catch((e: unknown) => e)) as MetaError;
    expect(String(err)).not.toContain("test-key-not-real");
    expect(String(err)).not.toContain("SECRET-DOCUMENT-CONTENT");
    expect(String(err)).not.toContain("authorization");
  });
});
