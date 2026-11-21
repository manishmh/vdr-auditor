/**
 * Post-response scheduling. On Vercel this uses the platform's tracked
 * background primitive so work continues after the HTTP response without an
 * open client connection; anywhere else (local dev, tests) the work runs
 * detached on the living process. Callers must still treat scheduling as
 * fallible: a synchronous throw means nothing was scheduled.
 */
export async function scheduleAfterResponse(task: () => Promise<unknown>): Promise<void> {
  const guarded = async (): Promise<void> => {
    try {
      await task();
    } catch (err: unknown) {
      console.error(
        "background processing failed:",
        err instanceof Error ? err.message : "unknown error",
      );
    }
  };
  if (process.env.VERCEL === "1") {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(guarded());
    return;
  }
  setImmediate(() => {
    void guarded();
  });
}
