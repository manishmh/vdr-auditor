import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock("../src/db/mongodb.js", () => ({
  pingDatabase: vi.fn(),
  getDb: getDbMock,
  closeDatabase: vi.fn(),
}));

import { startApp, type RunningApp } from "./matters-fake.js";
import { createDocumentsFake, type DocumentsFake } from "./documents-fake.js";

// Fresh module registry per file, so the index memo starts empty here.
describe("documents index lifecycle", () => {
  let fake: DocumentsFake;
  let app: RunningApp | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createDocumentsFake();
    getDbMock.mockResolvedValue(fake.db);
    fake.state.matters.push({
      _id: new ObjectId("64f1a2b3c4d5e6f7890abc01"),
      title: "Matter",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("ensures the matter listing index exactly once across requests", async () => {
    app = await startApp("mongodb://localhost:27017/testdb");
    await fetch(`${app.baseUrl}/api/matters/64f1a2b3c4d5e6f7890abc01/documents`);
    await fetch(`${app.baseUrl}/api/matters/64f1a2b3c4d5e6f7890abc01/documents`);
    const calls = fake.documents.createIndex.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({ matterId: 1, createdAt: -1 });
  });
});
