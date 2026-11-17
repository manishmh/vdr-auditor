import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock("../src/db/mongodb.js", () => ({
  pingDatabase: vi.fn(),
  getDb: getDbMock,
  closeDatabase: vi.fn(),
}));

import {
  createMattersFake,
  startApp,
  type MattersFake,
  type RunningApp,
} from "./matters-fake.js";

const URI = "mongodb://testuser:test-pass-123@localhost:27017/testdb";

let fake: MattersFake;
let app: RunningApp | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createMattersFake();
  getDbMock.mockResolvedValue(fake.db);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function seed(idHex: string, title: string, createdAt: string): void {
  fake.state.docs.push({
    _id: new ObjectId(idHex),
    title,
    status: "active",
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  });
}

describe("POST /api/matters", () => {
  it("creates a matter and returns 201 with the persisted record", async () => {
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Smith merger review" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toMatch(/^[0-9a-f]{24}$/);
    expect(body["title"]).toBe("Smith merger review");
    expect(body["status"]).toBe("active");
    expect(body).not.toHaveProperty("_id");
    expect(body).not.toHaveProperty("description");
    expect(Number.isNaN(Date.parse(body["createdAt"] as string))).toBe(false);
    expect(Number.isNaN(Date.parse(body["updatedAt"] as string))).toBe(false);
    expect(fake.state.docs).toHaveLength(1);
  });

  it("persists description and non-default status", async () => {
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "T",
        description: "Checklist",
        status: "on_hold",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["description"]).toBe("Checklist");
    expect(body["status"]).toBe("on_hold");
  });

  it("rejects invalid input with 400 without touching the database", async () => {
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "  ", status: "archived" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("validation_error");
    expect(Array.isArray(body["issues"])).toBe(true);
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("invalid_json");
  });

  it("ignores client-supplied ids and timestamps", async () => {
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "T",
        id: "64f1a2b3c4d5e6f7890abcde",
        createdAt: "2001-01-01T00:00:00.000Z",
        updatedAt: "2001-01-01T00:00:00.000Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).not.toBe("64f1a2b3c4d5e6f7890abcde");
    expect(body["createdAt"]).not.toBe("2001-01-01T00:00:00.000Z");
  });

  it("returns 503 without leaking secrets when the database fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      getDbMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      app = await startApp(URI);
      const res = await fetch(`${app.baseUrl}/api/matters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T" }),
      });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: "database_unavailable" });
      expect(text).not.toContain("test-pass-123");
      expect(text).not.toContain("testuser");
      expect(text).not.toContain("ECONNREFUSED");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("GET /api/matters", () => {
  it("returns matters newest first", async () => {
    seed("64f1a2b3c4d5e6f7890abc01", "Older", "2026-01-01T00:00:00.000Z");
    seed("64f1a2b3c4d5e6f7890abc02", "Newer", "2026-02-01T00:00:00.000Z");
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((m) => m["title"])).toEqual(["Newer", "Older"]);
    expect(body[0]).toMatchObject({ id: "64f1a2b3c4d5e6f7890abc02" });
  });

  it("returns an empty array when no matters exist", async () => {
    app = await startApp(URI);
    const res = await fetch(`${app.baseUrl}/api/matters`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

});

describe("GET /api/matters/:id", () => {
  it("returns one matter", async () => {
    seed("64f1a2b3c4d5e6f7890abc03", "Single", "2026-03-01T00:00:00.000Z");
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/64f1a2b3c4d5e6f7890abc03`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "64f1a2b3c4d5e6f7890abc03",
      title: "Single",
    });
  });

  it("returns 404 for a missing matter", async () => {
    app = await startApp(URI);
    const res = await fetch(
      `${app.baseUrl}/api/matters/64f1a2b3c4d5e6f7890abc99`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 400 for malformed ids", async () => {
    app = await startApp(URI);
    for (const id of ["nope", "123", "64f1a2b3c4d5e6f7890abcdeg"]) {
      const res = await fetch(`${app.baseUrl}/api/matters/${id}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_id" });
    }
  });
});

describe("without database configuration", () => {
  it("returns 503 for list, create, and lookup", async () => {
    app = await startApp(undefined);
    const list = await fetch(`${app.baseUrl}/api/matters`);
    expect(list.status).toBe(503);
    const created = await fetch(`${app.baseUrl}/api/matters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "T" }),
    });
    expect(created.status).toBe(503);
    const one = await fetch(
      `${app.baseUrl}/api/matters/64f1a2b3c4d5e6f7890abc03`,
    );
    expect(one.status).toBe(503);
    expect(getDbMock).not.toHaveBeenCalled();
  });
});

describe("health endpoints", () => {
  it("still answer alongside matters routes", async () => {
    app = await startApp(undefined);
    const res = await fetch(`${app.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const ready = await fetch(`${app.baseUrl}/api/health/ready`);
    expect(ready.status).toBe(503);
  });
});
