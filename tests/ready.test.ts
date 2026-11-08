import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { createApp } from "@/backend/src/app";
import { resetServerContext } from "@/backend/src/context";
import { closeMongo } from "@/backend/src/repositories/mongo-client";

const TOKEN = "test-pilot-token-0123456789abcdef";
const DOCKER_URI = process.env.TEST_MONGODB_URI;

let server: Server | null = null;
let baseUrl = "";
let dir = "";

async function boot(extraEnv: Record<string, string>): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "vdr-ready-"));
  vi.stubEnv("STORAGE_DIR", dir);
  vi.stubEnv("INFERENCE_PROVIDER", "mock");
  vi.stubEnv("PILOT_ACCESS_TOKEN", TOKEN);
  vi.stubEnv("FRONTEND_ORIGIN", "https://pilot.example.com");
  for (const [key, value] of Object.entries(extraEnv)) vi.stubEnv(key, value);
  resetConfigCache();
  resetServerContext();
  await closeMongo();
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  if (!server) throw new Error("test server failed to listen");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetConfigCache();
  resetServerContext();
  await closeMongo();
});

describe("GET /api/ready", () => {
  it("rejects unauthenticated requests with 401", async () => {
    await boot({ STORAGE_BACKEND: "local" });
    const res = await fetch(`${baseUrl}/api/ready`);
    expect(res.status).toBe(401);
  });

  it("reports ok for the local backend without touching any dependency", async () => {
    await boot({ STORAGE_BACKEND: "local" });
    const res = await fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, storage: "local" });
  });

  it("reports 503 with a generic body when MongoDB is unreachable", async () => {
    await boot({ STORAGE_BACKEND: "mongodb", MONGODB_URI: "mongodb://127.0.0.1:1/vdr_ready_test" });
    const res = await fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "Database unavailable." });
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
    expect(JSON.stringify(body)).not.toContain("Mongo");
  }, 30000);

  it("pings a reachable MongoDB and reports latency", async () => {
    if (!DOCKER_URI) {
      throw new Error(
        "TEST_MONGODB_URI is required for MongoDB repository tests. " +
          "Start a disposable instance, e.g. `docker run -d -p 127.0.0.1:27017:27017 mongo:8`, " +
          "and set TEST_MONGODB_URI=mongodb://127.0.0.1:27017/vdr_auditor_test.",
      );
    }
    await boot({ STORAGE_BACKEND: "mongodb", MONGODB_URI: DOCKER_URI, MONGODB_DB: "vdr_auditor_test" });
    const res = await fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; storage: string; database: string; latencyMs: number };
    expect(body.ok).toBe(true);
    expect(body.storage).toBe("mongodb");
    expect(body.database).toBe("vdr_auditor_test");
    expect(typeof body.latencyMs).toBe("number");
  }, 30000);
});
