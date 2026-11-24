import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/mongodb.js", () => ({
  pingDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { pingDatabase } from "../src/db/mongodb.js";
import { SERVICE_NAME } from "../src/routes/health.js";

const mockedPing = vi.mocked(pingDatabase);

let server: Server | undefined;
let baseUrl = "";

async function startApp(mongodbUri: string | undefined): Promise<void> {
  const env = loadEnv({
    ...process.env,
    FRONTEND_ORIGIN: "http://localhost:3000",
    MONGODB_URI: mongodbUri,
  });
  const app: Express = createApp(env);
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server?.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
});

describe("GET /api/health", () => {
  it("returns 200 with service id and timestamp without touching MongoDB", async () => {
    await startApp(undefined);

    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["service"]).toBe(SERVICE_NAME);
    expect(body["status"]).toBe("ok");
    expect(body["node"]).toBe(process.versions.node);
    expect(Number.isNaN(Date.parse(body["timestamp"] as string))).toBe(false);
    expect(mockedPing).not.toHaveBeenCalled();
  });
});

describe("GET /api/health/ready", () => {
  it("returns 200 after a successful MongoDB ping", async () => {
    mockedPing.mockResolvedValueOnce(undefined);
    await startApp("mongodb://user:pass@localhost:27017/test");

    const res = await fetch(`${baseUrl}/api/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["service"]).toBe(SERVICE_NAME);
    expect(body["status"]).toBe("ready");
    expect(body["database"]).toBe("connected");
    expect(mockedPing).toHaveBeenCalledTimes(1);
  });

  it("returns 503 without leaking secrets when MongoDB is unreachable", async () => {
    mockedPing.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const secretUri = "mongodb://dbuser:s3cr3t-pw@cluster0.example.net/test";
    await startApp(secretUri);

    const res = await fetch(`${baseUrl}/api/health/ready`);
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body["service"]).toBe(SERVICE_NAME);
    expect(body["status"]).toBe("not_ready");
    expect(body["database"]).toBe("unavailable");
    expect(text).not.toContain("s3cr3t-pw");
    expect(text).not.toContain("dbuser");
    expect(text).not.toContain("cluster0.example.net");
    expect(text).not.toContain("ECONNREFUSED");
  });

  it("returns 503 when no MongoDB URI is configured", async () => {
    await startApp(undefined);

    const res = await fetch(`${baseUrl}/api/health/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["database"]).toBe("unconfigured");
    expect(mockedPing).not.toHaveBeenCalled();
  });
});

describe("unknown routes", () => {
  it("returns JSON 404", async () => {
    await startApp(undefined);

    const res = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("not_found");
  });
});
