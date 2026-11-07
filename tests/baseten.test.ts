import { describe, expect, it, vi } from "vitest";
import { BasetenProvider, BasetenProviderError } from "@/lib/inference/baseten";
import type { TextSection } from "@/lib/text/chunk";

const section = (id: string, text: string): TextSection => ({ id, text, pageStart: 1, pageEnd: 1 });

const CANDIDATE = {
  category: "change_of_control",
  severity: "high",
  title: "Possible change-of-control provision",
  explanation: "The text contains change-of-control language.",
  evidence: "In the event of a change of control, consent is required.",
  confidence: 0.8,
  recommendedAction: "Have counsel confirm the trigger.",
};

function chatResponse(
  content: string,
  extra: { message?: Record<string, unknown>; root?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "test-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, ...(extra.message ?? {}) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    ...(extra.root ?? {}),
  };
}

function okFetch(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
}

function statusFetch(status: number, body = "error", headers?: Record<string, string>): typeof fetch {
  return (async () => new Response(body, { status, headers })) as typeof fetch;
}

const INPUT = {
  sections: [section("s1", "Section 1. In the event of a change of control, consent is required.")],
  categories: ["change_of_control", "uncapped_liability", "missing_signature"] as (
    | "change_of_control"
    | "uncapped_liability"
    | "missing_signature"
  )[],
  documentLabel: "test.pdf (id)",
};

function providerWith(fetchFn: typeof fetch, overrides = {}) {
  return new BasetenProvider({
    apiKey: "test-key",
    modelId: "test-org/test-model",
    fetchFn,
    sleepFn: async () => {},
    maxRetries: 0,
    ...overrides,
  });
}

describe("BasetenProvider request shape", () => {
  it("posts an OpenAI-compatible request with structured outputs and parses findings", async () => {
    const calls: { url: unknown; init: unknown }[] = [];
    const fetchFn = (async (url: unknown, init: unknown) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(chatResponse(JSON.stringify({ findings: [CANDIDATE] }))), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await providerWith(fetchFn).analyze(INPUT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe(CANDIDATE.title);
    expect(result.sectionErrors).toHaveLength(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://inference.baseten.co/v1/chat/completions");
    const init = calls[0].init as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.model).toBe("test-org/test-model");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toMatchObject({ type: "json_schema" });
    const schema = (body.response_format as { json_schema: { schema: { properties: { findings: unknown } } } })
      .json_schema.schema;
    expect(schema.properties.findings).toBeTruthy();
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toMatch(/untrusted/i);
    expect(messages[1].content).toContain("change of control, consent is required");
    expect(init.body).not.toContain("test-key");
  });

  it("returns empty findings when the model finds nothing", async () => {
    const result = await providerWith(okFetch(chatResponse(JSON.stringify({ findings: [] })))).analyze(INPUT);
    expect(result.findings).toEqual([]);
    expect(result.sectionErrors).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
  });

  it("requires credentials at construction", () => {
    expect(() => new BasetenProvider({ apiKey: "", modelId: "m" })).toThrow(/API key/);
    expect(() => new BasetenProvider({ apiKey: "k", modelId: "" })).toThrow(/model id/);
  });
});

describe("BasetenProvider output handling", () => {
  it("records a section error for an unreadable response body", async () => {
    const fetchFn = (async () => new Response("not json{{", { status: 200 })) as typeof fetch;
    const result = await providerWith(fetchFn).analyze(INPUT);
    expect(result.findings).toHaveLength(0);
    expect(result.sectionErrors).toHaveLength(1);
    expect(result.sectionErrors[0].sectionId).toBe("s1");
  });

  it("records a section error for prose without a JSON object", async () => {
    const result = await providerWith(okFetch(chatResponse("Here are my thoughts in prose."))).analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/no JSON object/);
  });

  it("records a section error for schema-invalid content", async () => {
    const bad = { findings: [{ ...CANDIDATE, severity: "extreme" }] };
    const result = await providerWith(okFetch(chatResponse(JSON.stringify(bad)))).analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/schema validation/);
  });

  it("records a section error on model refusal without retrying", async () => {
    const fetchFn = vi.fn(okFetch(chatResponse("", { message: { refusal: "I cannot help." } })));
    const result = await providerWith(fetchFn as typeof fetch).analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/refused/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("records a section error when output is cut off by the length limit", async () => {
    const payload = chatResponse(JSON.stringify({ findings: [CANDIDATE] }));
    (payload.choices as { finish_reason: string }[])[0].finish_reason = "length";
    const result = await providerWith(okFetch(payload)).analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/cut off/);
  });

  it("captures cutoff diagnostics: code, received chars, and usage, without retrying", async () => {
    const content = `{"findings": [{"title": "${"x".repeat(5000)}`;
    const payload = chatResponse(content);
    (payload.choices as { finish_reason: string }[])[0].finish_reason = "length";
    const fetchFn = vi.fn(okFetch(payload));
    const result = await providerWith(fetchFn as typeof fetch, { maxRetries: 2 }).analyze(INPUT);
    expect(result.findings).toHaveLength(0);
    expect(result.sectionErrors).toHaveLength(1);
    expect(result.sectionErrors[0]).toMatchObject({ sectionId: "s1", code: "incomplete" });
    expect(result.sectionErrors[0].message).toContain(`after ${content.length} chars`);
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("accumulates usage from schema-invalid responses", async () => {
    const bad = { findings: [{ ...CANDIDATE, severity: "extreme" }] };
    const result = await providerWith(okFetch(chatResponse(JSON.stringify(bad)))).analyze(INPUT);
    expect(result.sectionErrors[0]).toMatchObject({ sectionId: "s1", code: "invalid_output" });
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
  });
});

describe("BasetenProvider prompt-requested JSON mode", () => {
  const unstructured = { structuredOutputs: false };

  it("omits response_format and puts JSON instructions in the prompt", async () => {
    const calls: { init: unknown }[] = [];
    const fetchFn = (async (_url: unknown, init: unknown) => {
      calls.push({ init });
      return new Response(JSON.stringify(chatResponse(JSON.stringify({ findings: [] }))), { status: 200 });
    }) as typeof fetch;
    const result = await providerWith(fetchFn, unstructured).analyze(INPUT);
    expect(result.findings).toEqual([]);
    expect(result.sectionErrors).toEqual([]);
    const body = JSON.parse((calls[0].init as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("response_format");
    expect(body.model).toBe("test-org/test-model");
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[1].content).toContain('"findings"');
    expect(messages[1].content).toContain("missing_signature");
  });

  it("parses JSON wrapped in markdown fences", async () => {
    const content = '```json\n' + JSON.stringify({ findings: [CANDIDATE] }) + '\n```';
    const result = await providerWith(okFetch(chatResponse(content)), unstructured).analyze(INPUT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).toBe(CANDIDATE.evidence);
  });

  it("parses JSON wrapped in surrounding prose", async () => {
    const content = `Here is my analysis:\n${JSON.stringify({ findings: [CANDIDATE] })}\nLet me know if you need more.`;
    const result = await providerWith(okFetch(chatResponse(content)), unstructured).analyze(INPUT);
    expect(result.findings).toHaveLength(1);
  });

  it("retries truncated JSON, then records a section error", async () => {
    const fetchFn = vi.fn(okFetch(chatResponse('Result: {"findings": [{"category": "change_of_control",}]} end.')));
    const result = await providerWith(fetchFn as typeof fetch, { ...unstructured, maxRetries: 1 }).analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/malformed JSON/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("records a section error for prose without braces", async () => {
    const result = await providerWith(
      okFetch(chatResponse("I reviewed the section and found nothing noteworthy.")),
      unstructured,
    ).analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/no JSON object/);
  });

  it("ignores reasoning_content and parses only the final answer", async () => {
    const reasoning = JSON.stringify({
      findings: [{ ...CANDIDATE, title: "Draft thought, not a finding", evidence: "invented draft quote" }],
    });
    const payload = chatResponse(JSON.stringify({ findings: [CANDIDATE] }), {
      message: { reasoning_content: `Let me think... ${reasoning}` },
    });
    const result = await providerWith(okFetch(payload), unstructured).analyze(INPUT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe(CANDIDATE.title);
    expect(result.findings[0].evidence).not.toContain("invented draft quote");
  });

  it("records a section error when only reasoning is returned without content", async () => {
    const payload = chatResponse("", { message: { reasoning_content: "thinking…" } });
    const result = await providerWith(okFetch(payload), unstructured).analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/no content/);
  });

  it("records refusals and truncation without retrying", async () => {
    const refusalFetch = vi.fn(okFetch(chatResponse("", { message: { refusal: "declined" } })));
    const refused = await providerWith(refusalFetch as typeof fetch, unstructured).analyze(INPUT);
    expect(refused.sectionErrors[0].message).toMatch(/refused/);
    expect(refusalFetch).toHaveBeenCalledTimes(1);

    const payload = chatResponse(JSON.stringify({ findings: [] }));
    (payload.choices as { finish_reason: string }[])[0].finish_reason = "length";
    const truncated = await providerWith(okFetch(payload), unstructured).analyze(INPUT);
    expect(truncated.sectionErrors[0].message).toMatch(/cut off/);
  });
});

describe("BasetenProvider retries and errors", () => {
  it("retries rate limits and honors Retry-After", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify(chatResponse(JSON.stringify({ findings: [CANDIDATE] }))), {
        status: 200,
      });
    }) as typeof fetch;
    const provider = providerWith(fetchFn, { maxRetries: 2, sleepFn: async (ms: number) => { sleeps.push(ms); } });
    const result = await provider.analyze(INPUT);
    expect(result.findings).toHaveLength(1);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up after bounded retries and records a section error", async () => {
    const fetchFn = vi.fn(statusFetch(503, "overloaded"));
    const provider = providerWith(fetchFn as typeof fetch, { maxRetries: 2 });
    const result = await provider.analyze(INPUT);
    expect(result.sectionErrors).toHaveLength(1);
    expect(result.sectionErrors[0].message).toMatch(/503/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries network failures", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return new Response(JSON.stringify(chatResponse(JSON.stringify({ findings: [] }))), { status: 200 });
    }) as typeof fetch;
    const result = await providerWith(fetchFn, { maxRetries: 1 }).analyze(INPUT);
    expect(result.sectionErrors).toHaveLength(0);
    expect(calls).toBe(2);
  });

  it("aborts on timeout and records a section error", async () => {
    const fetchFn = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const result = await providerWith(fetchFn, { timeoutMs: 20 }).analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/timed out/);
  });

  it("throws fatally on auth failure without retrying or touching later sections", async () => {
    const fetchFn = vi.fn(statusFetch(401, "bad key"));
    const provider = providerWith(fetchFn as typeof fetch, { maxRetries: 3 });
    const err = await provider
      .analyze({ ...INPUT, sections: [section("s1", "a".repeat(60)), section("s2", "b".repeat(60))] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BasetenProviderError);
    expect((err as BasetenProviderError).fatal).toBe(true);
    expect((err as BasetenProviderError).code).toBe("auth");
    expect((err as Error).message).toContain("bad key");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws fatally on unknown model without substituting another", async () => {
    const provider = providerWith(statusFetch(404, "no such model"));
    const err = await provider.analyze(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BasetenProviderError);
    expect((err as BasetenProviderError).fatal).toBe(true);
    expect((err as Error).message).toContain("test-org/test-model");
    expect((err as Error).message).toMatch(/no other model was substituted/i);
  });

  it("never includes the API key in error messages", async () => {
    const secret = "sk-live-marker-9z8y7x";
    const provider = new BasetenProvider({
      apiKey: secret,
      modelId: "test-org/test-model",
      fetchFn: statusFetch(401, "bad key"),
      sleepFn: async () => {},
      maxRetries: 0,
    });
    const err = await provider.analyze(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BasetenProviderError);
    expect((err as Error).message).not.toContain(secret);
    const malformed = new BasetenProvider({
      apiKey: secret,
      modelId: "test-org/test-model",
      fetchFn: okFetch({ not: "a chat completion" }),
      sleepFn: async () => {},
      maxRetries: 0,
    });
    const result = await malformed.analyze(INPUT);
    for (const sectionError of result.sectionErrors) {
      expect(sectionError.message).not.toContain(secret);
    }
  });

  it("does not retry bad requests and records a section error", async () => {
    const fetchFn = vi.fn(statusFetch(400, "bad schema"));
    const provider = providerWith(fetchFn as typeof fetch, { maxRetries: 3 });
    const result = await provider.analyze(INPUT);
    expect(result.sectionErrors[0].message).toMatch(/rejected.*400/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps successful sections when another section fails", async () => {
    const fetchFn = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as {
        messages: { content: string }[];
      };
      if (body.messages[1].content.includes("SECTION-TWO")) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify(chatResponse(JSON.stringify({ findings: [CANDIDATE] }))), {
        status: 200,
      });
    }) as typeof fetch;
    const result = await providerWith(fetchFn, { maxRetries: 0 }).analyze({
      ...INPUT,
      sections: [section("s1", "Section one with SECTION-ONE marker."), section("s2", "SECTION-TWO marker here.")],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.sectionErrors).toHaveLength(1);
    expect(result.sectionErrors[0].sectionId).toBe("s2");
  });
});
