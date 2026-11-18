import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  it("applies safe defaults for optional values", () => {
    const env = loadEnv({ FRONTEND_ORIGIN: "http://localhost:3000" });
    expect(env.port).toBe(4000);
    expect(env.nodeEnv).toBe("development");
    expect(env.mongodbUri).toBeUndefined();
    expect(env.mongodbDbName).toBe("vdr_auditor");
    expect(env.maxPdfBytes).toBe(25 * 1024 * 1024);
  });

  it("reads the PDF size cap", () => {
    const env = loadEnv({
      FRONTEND_ORIGIN: "http://localhost:3000",
      MAX_PDF_BYTES: "1024",
    });
    expect(env.maxPdfBytes).toBe(1024);
  });

  it("rejects an invalid PDF size cap by name", () => {
    for (const value of ["0", "huge", "999999999999"]) {
      expect(() =>
        loadEnv({ FRONTEND_ORIGIN: "http://localhost:3000", MAX_PDF_BYTES: value }),
      ).toThrowError(/MAX_PDF_BYTES/);
    }
  });

  it("throws an actionable error naming the missing variable", () => {
    expect(() => loadEnv({})).toThrowError(/FRONTEND_ORIGIN/);
  });

  it("rejects an invalid PORT", () => {
    expect(() =>
      loadEnv({ FRONTEND_ORIGIN: "http://localhost:3000", PORT: "abc" }),
    ).toThrowError(/PORT/);
  });

  it("treats an empty MONGODB_URI as unconfigured, not as a value", () => {
    const env = loadEnv({
      FRONTEND_ORIGIN: "http://localhost:3000",
      MONGODB_URI: "",
    });
    expect(env.mongodbUri).toBeUndefined();
  });
});
