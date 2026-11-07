import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Backend startup regression tests. The ECONNREFUSED incident was a backend
 * that was never started; these prove the entry point boots, listens, and
 * fails fast with a clear error instead of leaving the proxy without a
 * server. Spawns real processes on test-only ports (3121/3122).
 */

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
    if (/^(PILOT_ACCESS_TOKEN|DATABASE_URL|TEST_DATABASE_URL|MONGODB_URI|NEXT_PUBLIC_)/.test(key)) delete env[key];
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

describe("backend startup", () => {
  it("boots the entry point and serves health on the configured port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vdr-boot-"));
    try {
      spawnBackend(3121, { STORAGE_BACKEND: "local", STORAGE_DIR: dir, INFERENCE_PROVIDER: "mock" });
      expect(await waitForHealth(3121, 20000)).toBe(true);
      const res = await fetch("http://127.0.0.1:3121/api/documents");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ documents: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("fails fast with a clear error when the mongodb backend has no URI", async () => {
    const { proc, stderr } = spawnBackend(3122, { STORAGE_BACKEND: "mongodb", INFERENCE_PROVIDER: "mock" });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 25000);
      proc.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(stderr.join("")).toContain("MONGODB_URI");
  }, 30000);
});
