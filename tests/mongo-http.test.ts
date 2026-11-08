import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { createApp } from "@/backend/src/app";
import { resetServerContext } from "@/backend/src/context";
import { closeMongo, getMongoDb } from "@/backend/src/repositories/mongo-client";
import { makePdf } from "./helpers/make-pdf";

/**
 * Production-parity document lifecycle over HTTP against the MongoDB
 * backend (mock inference): upload persists, the document appears in the
 * list, and detail/download/review/delete all round-trip. Uses an isolated
 * database on the disposable test server so parallel suites sharing
 * TEST_MONGODB_URI cannot interfere.
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

let dir: string;
let server: Server;
let baseUrl: string;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vdr-mongo-http-"));
  vi.stubEnv("STORAGE_DIR", dir);
  vi.stubEnv("STORAGE_BACKEND", "mongodb");
  vi.stubEnv("MONGODB_URI", uri);
  vi.stubEnv("MONGODB_DB", "vdr_auditor_http_test");
  vi.stubEnv("INFERENCE_PROVIDER", "mock");
  vi.stubEnv("PILOT_ACCESS_TOKEN", TOKEN);
  vi.stubEnv("FRONTEND_ORIGIN", "https://pilot.example.com");
  resetConfigCache();
  resetServerContext();
  await closeMongo();
  const db = await getMongoDb(uri, "vdr_auditor_http_test");
  await Promise.all([
    db.collection("documents").deleteMany({}),
    db.collection("findings").deleteMany({}),
    db.collection("reviewEvents").deleteMany({}),
  ]);
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

describe("document lifecycle over HTTP with the mongodb backend", () => {
  it("uploads, lists, details, downloads, reviews, and deletes", async () => {
    const pdf = makePdf([
      "Acquisition agreement. Upon a change of control, the buyer must give written notice.",
      "General provisions and signatures follow on this page.",
    ]);
    const form = new FormData();
    form.append("file", new File([Buffer.from(pdf)], "deal.pdf", { type: "application/pdf" }));
    const uploaded = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const created = (await uploaded.json()) as {
      document: { id: string; status: string };
      findings: { id: string }[];
    };
    const id = created.document.id;
    expect(created.document.status).toBe("completed");
    expect(created.findings.length).toBeGreaterThan(0);

    const listed = await fetch(`${baseUrl}/api/documents`, { headers: authHeaders() });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { documents: { id: string }[] };
    expect(listedBody.documents.map((d) => d.id)).toContain(id);

    const detail = await fetch(`${baseUrl}/api/documents/${id}`, { headers: authHeaders() });
    expect(detail.status).toBe(200);

    const file = await fetch(`${baseUrl}/api/documents/${id}/file`, { headers: authHeaders() });
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);

    const patched = await fetch(`${baseUrl}/api/documents/${id}/findings/${created.findings[0].id}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "confirmed" }),
    });
    expect(patched.status).toBe(200);

    const deleted = await fetch(`${baseUrl}/api/documents/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleted.status).toBe(200);
    const relisted = (await (
      await fetch(`${baseUrl}/api/documents`, { headers: authHeaders() })
    ).json()) as { documents: { id: string }[] };
    expect(relisted.documents.map((d) => d.id)).not.toContain(id);
  }, 60000);
});
