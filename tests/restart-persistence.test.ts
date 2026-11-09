import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { createApp } from "@/backend/src/app";
import { resetServerContext } from "@/backend/src/context";
import { closeMongo, getMongoDb } from "@/backend/src/repositories/mongo-client";
import { makePdf } from "./helpers/make-pdf";

/**
 * Restart persistence: documents uploaded through one application boot
 * remain available after the application restarts against the same
 * MongoDB database. Uses an isolated database of the disposable test
 * server — never development or production data.
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
const TOKEN = "test-pilot-token-0123456789abcdef";
const DB = "vdr_auditor_restart_test";

let server: Server | null = null;

async function boot(): Promise<string> {
  vi.stubEnv("STORAGE_BACKEND", "mongodb");
  vi.stubEnv("MONGODB_URI", uri);
  vi.stubEnv("MONGODB_DB", DB);
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
  if (!server) throw new Error("test server failed to listen");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function shutdown(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
  }
  resetServerContext();
  await closeMongo();
}

afterAll(async () => {
  await shutdown();
  vi.unstubAllEnvs();
  resetConfigCache();
});

describe("restart persistence", () => {
  it("keeps uploaded documents available across an application restart", async () => {
    const db = await getMongoDb(uri, DB);
    await Promise.all([
      db.collection("documents").deleteMany({}),
      db.collection("findings").deleteMany({}),
      db.collection("reviewEvents").deleteMany({}),
    ]);

    const first = await boot();
    const pdf = makePdf(["Restart clause: change of control notice is required."]);
    const form = new FormData();
    form.append("file", new File([Buffer.from(pdf)], "restart.pdf", { type: "application/pdf" }));
    const uploaded = await fetch(`${first}/api/documents`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const id = ((await uploaded.json()) as { document: { id: string } }).document.id;
    await shutdown();

    const second = await boot();
    const listed = await fetch(`${second}/api/documents`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { documents: { id: string }[] };
    expect(body.documents.map((d) => d.id)).toContain(id);
    const detail = await fetch(`${second}/api/documents/${id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(detail.status).toBe(200);
    await fetch(`${second}/api/documents/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await shutdown();
  }, 60000);
});
