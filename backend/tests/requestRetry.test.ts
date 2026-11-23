import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// NOTE: filename predates the current behavior; this file covers timeout,
// in-flight dedup, and caching for requestJson (single attempt, no retry).
import { MattersApiError, bustApiCache, requestJson } from "../../frontend/lib/matters.js";

// requestJson is pure TypeScript (fetch + DOMException only), so the backend
// suite covers it until the frontend grows its own harness.

const API_URL = "http://api.test";

function hangingFetch(): ReturnType<typeof vi.fn> {
  // Rejects like real fetch does when AbortSignal.timeout() fires.
  return vi.fn(
    (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("timeout", "TimeoutError"));
        });
      }),
  );
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  bustApiCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("requestJson timeout behavior", () => {
  it("makes exactly one attempt on timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestJson(API_URL, "/api/matters", undefined, 100);
    const settled = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;
    expect(err).toBeInstanceOf(MattersApiError);
    expect((err as MattersApiError).message).toContain("taking longer than expected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent identical reads", async () => {
    const fetchMock = vi.fn(async () => jsonOk([1]));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([
      requestJson(API_URL, "/api/matters"),
      requestJson(API_URL, "/api/matters"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
  });

  it("serves stable GETs from cache until it expires", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonOk([1]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestJson(API_URL, "/api/matters")).toEqual([1]);
    expect(await requestJson(API_URL, "/api/matters")).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await requestJson(API_URL, "/api/matters")).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hands out copies so callers cannot corrupt the cache", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ items: [1] }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await requestJson<Record<string, unknown>>(API_URL, "/api/matters");
    first["items"] = ["mutated"];
    const second = await requestJson<Record<string, unknown>>(API_URL, "/api/matters");
    expect(second).toEqual({ items: [1] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fresh reads and writes bypass or bust the cache", async () => {
    const fetchMock = vi.fn(async () => jsonOk([1]));
    vi.stubGlobal("fetch", fetchMock);
    await requestJson(API_URL, "/api/matters");
    await requestJson(API_URL, "/api/matters", undefined, undefined, { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await requestJson(API_URL, "/api/matters", { method: "POST" });
    await requestJson(API_URL, "/api/matters");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never caches live collections but still dedupes them", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ runs: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await requestJson(API_URL, "/api/processing");
    await requestJson(API_URL, "/api/processing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await Promise.all([
      requestJson(API_URL, "/api/processing"),
      requestJson(API_URL, "/api/processing"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never dedupes writes", async () => {
    const fetchMock = vi.fn(async () => jsonOk({}));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([
      requestJson(API_URL, "/api/matters", { method: "POST" }),
      requestJson(API_URL, "/api/matters", { method: "POST" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
