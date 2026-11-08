import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { createApp } from "@/backend/src/app";
import { resetServerContext } from "@/backend/src/context";
import { closeMongo } from "@/backend/src/repositories/mongo-client";
import { makePdf } from "./helpers/make-pdf";

/**
 * Database-down HTTP contract: when MongoDB is unreachable, document
 * endpoints fail with a generic 500 that leaks no infrastructure detail
 * (hostnames, driver names, topology state). Pins the production incident
 * shape — the diagnosis lives in server logs, never in client bodies.
 */

const TOKEN = "test-pilot-token-0123456789abcdef";

let dir: string;
let server: Server;
let baseUrl: string;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vdr-dbdown-"));
  vi.stubEnv("STORAGE_DIR", dir);
  vi.stubEnv("STORAGE_BACKEND", "mongodb");
  vi.stubEnv("MONGODB_URI", "mongodb://127.0.0.1:1/vdr_dbdown_test");
  vi.stubEnv("INFERENCE_PROVIDER", "mock");
  vi.stubEnv("PILOT_ACCESS_TOKEN", TOKEN);
  vi.stubEnv("FRONTEND_ORIGIN", "https://pilot.example.com");
  resetConfigCache();
  resetServerContext();
  await closeMongo();
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetConfigCache();
  resetServerContext();
  await closeMongo();
});

describe("database unavailable", () => {
  it("fails authenticated listing with a generic sanitized 500", async () => {
    const res = await fetch(`${baseUrl}/api/documents`, { headers: authHeaders() });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "Request failed unexpectedly." });
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
    expect(JSON.stringify(body)).not.toContain("Mongo");
  }, 30000);

  it("fails uploads with a generic sanitized 500", async () => {
    const pdf = makePdf(["Terms. Upon a change of control, notice is required."]);
    const form = new FormData();
    form.append("file", new File([Buffer.from(pdf)], "deal.pdf", { type: "application/pdf" }));
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "Upload failed unexpectedly." });
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
    expect(JSON.stringify(body)).not.toContain("Mongo");
  }, 30000);

  it("still rejects unauthenticated requests with 401 (auth precedes storage)", async () => {
    const res = await fetch(`${baseUrl}/api/documents`);
    expect(res.status).toBe(401);
  });
});
