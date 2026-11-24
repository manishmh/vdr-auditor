import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// NOTE: filename predates the current behavior; this file covers timeouts,
// in-flight dedup, caching, and the single connection-failure retry for
// requestJson (GETs retry once on TypeError only; timeouts never retry).
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

  it("retries a failed GET connection once, then succeeds", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fetchMock.mockResolvedValueOnce(jsonOk([1]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestJson(API_URL, "/api/matters")).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retried connection also fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const err = await requestJson(API_URL, "/api/matters").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MattersApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("Failed to fetch");
  });

  it("never attaches a post-mutation read to a pre-mutation request", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(gate.then(() => jsonOk(["stale"])))
      .mockImplementation(async () => jsonOk(["fresh"]));
    vi.stubGlobal("fetch", fetchMock);
    const beforeMutation = requestJson(API_URL, "/api/matters");
    await requestJson(API_URL, "/api/matters", { method: "POST" });
    const afterMutation = requestJson(API_URL, "/api/matters");
    release(undefined);
    expect(await afterMutation).toEqual(["fresh"]);
    expect(await beforeMutation).toEqual(["stale"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never retries a failed write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const err = await requestJson(API_URL, "/api/matters", { method: "POST" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MattersApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
