import { afterEach, describe, expect, it, vi } from "vitest";
import { MattersApiError, requestJson } from "../../frontend/lib/matters.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("requestJson timeout retry", () => {
  it("retries an idempotent GET once after a timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    let calls = 0;
    const hanging = hangingFetch();
    fetchMock.mockImplementation((...args: unknown[]) => {
      calls += 1;
      return calls === 1
        ? (hanging as (...a: unknown[]) => unknown)(...args)
        : Promise.resolve(jsonOk({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestJson<Record<string, unknown>>(API_URL, "/api/matters", undefined, 100);
    const settled = pending.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.advanceTimersByTimeAsync(150);
    const result = await settled;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries writes", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", hangingFetch());
    const pending = requestJson(API_URL, "/api/matters", { method: "POST" }, 100);
    const settled = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;
    expect(err).toBeInstanceOf(MattersApiError);
    expect((err as MattersApiError).message).toContain("taking longer than expected");
  });

  it("never retries HTTP errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await requestJson(API_URL, "/api/matters").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MattersApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry also times out", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestJson(API_URL, "/api/matters", undefined, 100);
    const settled = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(150);
    const err = await settled;
    expect(err).toBeInstanceOf(MattersApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Exactly one diagnostic line for the final failure (plus shape info).
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("vdr-api");
  });
});
