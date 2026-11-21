import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/mongodb.js", () => ({
  pingDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { startApp, type RunningApp } from "./matters-fake.js";

describe("CORS preflight", () => {
  let app: RunningApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("allows every method the API uses", async () => {
    app = await startApp(undefined);
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const res = await fetch(`${app.baseUrl}/api/matters`, {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": method,
        },
      });
      expect(res.status).toBe(204);
      const allowed = res.headers.get("access-control-allow-methods") ?? "";
      expect(allowed.split(",").map((m) => m.trim())).toContain(method);
    }
  });

  it("never reflects a foreign origin", async () => {
    app = await startApp(undefined);
    const res = await fetch(`${app.baseUrl}/api/matters`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });
    // Browsers enforce an exact match, so anything other than the foreign
    // origin itself (absent, or the single configured origin) blocks it.
    expect(res.headers.get("access-control-allow-origin")).not.toBe(
      "https://evil.example",
    );
  });
});
