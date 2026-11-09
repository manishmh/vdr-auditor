import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Backend startup regression tests. The ECONNREFUSED incident was a backend
 * that was never started; these prove the entry point boots, listens, and
 * fails fast with a clear error instead of leaving the proxy without a
 * server. Spawns real processes on test-only ports (3121-3124) against an
 * isolated database of the disposable test server. Missing, malformed, or
 * unreachable MongoDB configuration must fail startup loudly — the server
 * never falls back to filesystem storage.
 */

const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI;

if (!TEST_MONGODB_URI) {
  throw new Error(
    "TEST_MONGODB_URI is required for MongoDB repository tests. " +
      "Start a disposable instance, e.g. `docker run -d -p 127.0.0.1:27017:27017 mongo:8`, " +
      "and set TEST_MONGODB_URI=mongodb://127.0.0.1:27017/vdr_auditor_test.",
  );
}

const uri: string = TEST_MONGODB_URI;
const ENTRY = join("backend", "src", "server.ts");
let child: ChildProcess | null = null;

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  child = null;
});

function spawnBackend(port: number, extraEnv: Record<string, string>): { proc: ChildProcess; stderr: string[] } {
  const env = { ...process.env };
  // Isolate from any developer shell exports; the child must boot on exactly
  // the env given here.
  for (const key of Object.keys(env)) {
    if (
      /^(PILOT_ACCESS_TOKEN|DATABASE_URL|TEST_DATABASE_URL|MONGODB_URI|MONGODB_DB|STORAGE_BACKEND|NEXT_PUBLIC_)/.test(
        key,
      )
    )
      delete env[key];
  }
  const proc = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    env: { ...env, PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  const stderr: string[] = [];
  proc.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  return { proc, stderr };
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    proc.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
}

describe("backend startup", () => {
  it("boots the entry point and serves health on the configured port", async () => {
    spawnBackend(3121, {
      STORAGE_BACKEND: "mongodb",
      MONGODB_URI: uri,
      MONGODB_DB: "vdr_auditor_boot_test",
      INFERENCE_PROVIDER: "mock",
    });
    expect(await waitForHealth(3121, 25000)).toBe(true);
    const res = await fetch("http://127.0.0.1:3121/api/documents");
    expect(res.status).toBe(200);
    expect((await res.json()) as { documents: unknown[] }).toHaveProperty("documents");
  }, 30000);

  it("fails fast with a clear error when the mongodb backend has no URI", async () => {
    const { proc, stderr } = spawnBackend(3122, {
      STORAGE_BACKEND: "mongodb",
      MONGODB_DB: "vdr_auditor_boot_test",
      INFERENCE_PROVIDER: "mock",
    });
    const code = await waitForExit(proc, 25000);
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(stderr.join("")).toContain("MONGODB_URI");
  }, 30000);

  it("fails fast when MongoDB is not selected (no filesystem fallback)", async () => {
    const { proc, stderr } = spawnBackend(3123, { INFERENCE_PROVIDER: "mock" });
    const code = await waitForExit(proc, 25000);
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(stderr.join("")).toContain("STORAGE_BACKEND=mongodb");
  }, 30000);

  it("fails fast with a clear error when MongoDB is unreachable", async () => {
    const { proc, stderr } = spawnBackend(3124, {
      STORAGE_BACKEND: "mongodb",
      MONGODB_URI: "mongodb://127.0.0.1:1/vdr_boot_test",
      MONGODB_DB: "vdr_auditor_boot_test",
      INFERENCE_PROVIDER: "mock",
    });
    const code = await waitForExit(proc, 30000);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("cannot reach MongoDB");
  }, 35000);
});
