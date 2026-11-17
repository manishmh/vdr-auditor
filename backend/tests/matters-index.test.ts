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

// This file runs in its own module registry, so the index-creation memo in
// src/db/matters.ts starts empty here regardless of other test files.
describe("matters index lifecycle", () => {
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

  it("ensures the listing index exactly once across requests", async () => {
    app = await startApp("mongodb://localhost:27017/testdb");
    await fetch(`${app.baseUrl}/api/matters`);
    await fetch(`${app.baseUrl}/api/matters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "T" }),
    });
    await fetch(`${app.baseUrl}/api/matters/64f1a2b3c4d5e6f7890abc03`);
    expect(fake.collection.createIndex).toHaveBeenCalledTimes(1);
    expect(fake.collection.createIndex).toHaveBeenCalledWith({ createdAt: -1 });
  });
});
