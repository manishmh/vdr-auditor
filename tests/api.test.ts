import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { resetConfigCache } from "@/lib/config";
import { createApp } from "@/backend/src/app";
import { resetServerContext } from "@/backend/src/context";
import { errorHandler } from "@/backend/src/middleware/errors";
import { makePdf } from "./helpers/make-pdf";

const TOKEN = "test-pilot-token-0123456789abcdef";

let dir: string;
let server: Server;
let baseUrl: string;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vdr-api-"));
  vi.stubEnv("STORAGE_DIR", dir);
  vi.stubEnv("STORAGE_BACKEND", "local");
  vi.stubEnv("INFERENCE_PROVIDER", "mock");
  vi.stubEnv("PILOT_ACCESS_TOKEN", TOKEN);
  vi.stubEnv("FRONTEND_ORIGIN", "https://pilot.example.com");
  vi.stubEnv("MAX_UPLOAD_BYTES", String(2 * 1024 * 1024));
  resetConfigCache();
  resetServerContext();
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("STORAGE_DIR", dir);
  vi.stubEnv("STORAGE_BACKEND", "local");
  vi.stubEnv("INFERENCE_PROVIDER", "mock");
  vi.stubEnv("PILOT_ACCESS_TOKEN", TOKEN);
  vi.stubEnv("FRONTEND_ORIGIN", "https://pilot.example.com");
  vi.stubEnv("MAX_UPLOAD_BYTES", String(2 * 1024 * 1024));
  resetConfigCache();
});

describe("pilot access gate", () => {
  it("rejects unauthenticated requests on every protected endpoint", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174001";
    const paths: [string, string][] = [
      ["GET", "/api/documents"],
      ["POST", "/api/documents"],
      ["GET", `/api/documents/${id}`],
      ["DELETE", `/api/documents/${id}`],
      ["GET", `/api/documents/${id}/file`],
      ["PATCH", `/api/documents/${id}/findings/${id}`],
      ["POST", "/api/demo/seed"],
      ["GET", "/api/ready"],
    ];
    for (const [method, path] of paths) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toContain("Authentication required");
      expect(text).not.toContain(TOKEN);
    }
  });

  it("rejects wrong and malformed credentials", async () => {
    const wrong = await fetch(`${baseUrl}/api/documents`, {
      headers: { authorization: "Bearer wrong-token-0123456789abcdef" },
    });
    expect(wrong.status).toBe(401);
    const malformed = await fetch(`${baseUrl}/api/documents`, {
      headers: { authorization: "Token abc" },
    });
    expect(malformed.status).toBe(401);
  });

  it("allows correctly authenticated requests", async () => {
    const res = await fetch(`${baseUrl}/api/documents`, { headers: authHeaders() });
    expect(res.status).toBe(200);
  });
});

describe("CORS", () => {
  it("reflects only the configured frontend origin", async () => {
    const allowed = await fetch(`${baseUrl}/api/documents`, {
      headers: { ...authHeaders(), Origin: "https://pilot.example.com" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://pilot.example.com");
    const denied = await fetch(`${baseUrl}/api/documents`, {
      headers: { ...authHeaders(), Origin: "https://evil.example.com" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("upload limits", () => {
  it("rejects declared oversized bodies with 413 before parsing", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const target = new URL(`${baseUrl}/api/documents`);
      const req = httpRequest(
        {
          hostname: target.hostname,
          port: Number(target.port),
          path: target.pathname,
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "multipart/form-data; boundary=x",
            "content-length": String(64 * 1024 * 1024),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end("too-short-body");
    });
    expect(status).toBe(413);
  });

  it("rejects oversized files with 413 and the too_large reason", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(0x25);
    const form = new FormData();
    form.append("file", new File([big], "big.pdf", { type: "application/pdf" }));
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    expect(res.status).toBe(413);
    expect((await res.json()) as { reason?: string }).toMatchObject({ reason: "too_large" });
  });

  it("rejects non-PDF uploads with 400", async () => {
    const form = new FormData();
    form.append("file", new File(["not a pdf"], "evil.txt", { type: "text/plain" }));
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    expect(res.status).toBe(400);
  });
});

describe("document lifecycle over HTTP", () => {
  it("uploads, analyzes, downloads, reviews, and deletes a document", async () => {
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
      findings: { id: string; category: string }[];
    };
    const id = created.document.id;
    expect(created.document.status).toBe("completed");
    expect(created.findings.length).toBeGreaterThan(0);
    expect(created.findings[0].category).toBe("change_of_control");

    const detail = await fetch(`${baseUrl}/api/documents/${id}`, { headers: authHeaders() });
    expect(detail.status).toBe(200);

    const file = await fetch(`${baseUrl}/api/documents/${id}/file`, { headers: authHeaders() });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);

    const findingId = created.findings[0].id;
    const patched = await fetch(`${baseUrl}/api/documents/${id}/findings/${findingId}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "confirmed", reviewerNote: "counsel verified" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { finding: { status: string } }).finding.status).toBe("confirmed");

    const deleted = await fetch(`${baseUrl}/api/documents/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleted.status).toBe(200);
    const gone = await fetch(`${baseUrl}/api/documents/${id}`, { headers: authHeaders() });
    expect(gone.status).toBe(404);
  });

  it("returns 404 (not 500) for cross-document finding updates", async () => {
    const pdf = makePdf([
      "Master services agreement. Upon a change of control of either party, written notice is required within thirty days of closing.",
    ]);
    async function upload(name: string): Promise<string> {
      const form = new FormData();
      form.append("file", new File([Buffer.from(pdf)], name, { type: "application/pdf" }));
      const res = await fetch(`${baseUrl}/api/documents`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { document: { id: string } }).document.id;
    }
    const docA = await upload("a.pdf");
    const docB = await upload("b.pdf");
    const detailB = (await (
      await fetch(`${baseUrl}/api/documents/${docB}`, { headers: authHeaders() })
    ).json()) as { findings: { id: string }[] };
    expect(detailB.findings.length).toBeGreaterThan(0);
    const res = await fetch(`${baseUrl}/api/documents/${docA}/findings/${detailB.findings[0].id}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(res.status).toBe(404);
    const untouched = (await (
      await fetch(`${baseUrl}/api/documents/${docB}`, { headers: authHeaders() })
    ).json()) as { findings: { status: string }[] };
    expect(untouched.findings[0].status).toBe("open");
  });

  it("rejects invalid ids and invalid JSON bodies with 400", async () => {
    const badId = await fetch(`${baseUrl}/api/documents/not-a-uuid`, { headers: authHeaders() });
    expect(badId.status).toBe(400);
    const id = "123e4567-e89b-12d3-a456-426614174001";
    const badJson = await fetch(`${baseUrl}/api/documents/${id}/findings/${id}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: "{oops",
    });
    expect(badJson.status).toBe(400);
  });

  it("rejects empty patches and over-long reviewer notes with 400", async () => {
    const clause = makePdf([
      "Master agreement. Upon a change of control of either party, written notice is required within thirty days. Signature: Jo.",
    ]);
    const form2 = new FormData();
    form2.append("file", new File([Buffer.from(clause)], "clause.pdf", { type: "application/pdf" }));
    const up2 = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: authHeaders(),
      body: form2,
    });
    expect(up2.status).toBe(201);
    const created = (await up2.json()) as { document: { id: string }; findings: { id: string }[] };
    const url = `${baseUrl}/api/documents/${created.document.id}/findings/${created.findings[0].id}`;
    const empty = await fetch(url, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    const tooLong = await fetch(url, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ reviewerNote: "x".repeat(4001) }),
    });
    expect(tooLong.status).toBe(400);
  });

  it("reports failed status (never clean) for unparseable PDFs", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([Buffer.from("%PDF-1.4 not really a pdf%")], "broken.pdf", { type: "application/pdf" }),
    );
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: { status: string; statusDetail: string }; findings: unknown[] };
    expect(body.document.status).toBe("failed");
    expect(body.findings).toHaveLength(0);
  });

  it("completes honestly with zero findings when nothing is flagged", async () => {
    const pdf = makePdf([
      "Office catering schedule for the month of June, duly executed by both sides. Sandwiches on Mondays. Signature: Jo.",
    ]);
    const form = new FormData();
    form.append("file", new File([Buffer.from(pdf)], "catering.pdf", { type: "application/pdf" }));
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: { status: string }; findings: unknown[] };
    expect(body.document.status).toBe("completed");
    expect(body.findings).toHaveLength(0);
  });

  it("rejects non-multipart uploads with 400", async () => {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ file: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("error handler", () => {
  function fakeRes() {
    const captured: { status?: number; body?: unknown; headersSent: boolean } = { headersSent: false };
    const res = {
      get headersSent() {
        return captured.headersSent;
      },
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as unknown as Response;
    return { res, captured };
  }

  it("returns generic 500s without leaking infrastructure details", () => {
    const { res, captured } = fakeRes();
    const err = new Error("MongoServerSelectionError: connect ECONNREFUSED 10.0.0.9:27017 [atlas-shard]");
    errorHandler(err, { method: "GET", path: "/api/documents" } as Request, res, (() => {}) as NextFunction);
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ error: "Request failed unexpectedly." });
    expect(JSON.stringify(captured.body)).not.toContain("10.0.0.9");
  });
});

describe("demo seeding guard", () => {
  it("seeds in non-production and refuses in production", async () => {
    const first = await fetch(`${baseUrl}/api/demo/seed`, { method: "POST", headers: authHeaders() });
    expect([200, 201]).toContain(first.status);
    vi.stubEnv("NODE_ENV", "production");
    resetConfigCache();
    const blocked = await fetch(`${baseUrl}/api/demo/seed`, { method: "POST", headers: authHeaders() });
    expect(blocked.status).toBe(403);
  });
});
