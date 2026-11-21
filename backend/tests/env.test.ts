import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  it("applies safe defaults for optional values", () => {
    const env = loadEnv({ FRONTEND_ORIGIN: "http://localhost:3000" });
    expect(env.port).toBe(4000);
    expect(env.nodeEnv).toBe("development");
    expect(env.mongodbUri).toBeUndefined();
    expect(env.mongodbDbName).toBe("vdr_auditor");
    expect(env.maxPdfBytes).toBe(25 * 1024 * 1024);
    expect(env.metaApiKey).toBeUndefined();
    expect(env.metaModelId).toBeUndefined();
    expect(env.metaBaseUrl).toBe("https://api.meta.ai/v1");
    expect(env.metaTimeoutMs).toBe(60000);
    expect(env.metaMaxRetries).toBe(2);
  });

  it("reads model configuration", () => {
    const env = loadEnv({
      FRONTEND_ORIGIN: "http://localhost:3000",
      META_API_KEY: "k",
      META_MODEL_ID: "m",
      META_BASE_URL: "https://models.example.test/v1/",
      META_TIMEOUT_MS: "300000",
      META_MAX_RETRIES: "1",
    });
    expect(env.metaApiKey).toBe("k");
    expect(env.metaModelId).toBe("m");
    expect(env.metaBaseUrl).toBe("https://models.example.test/v1");
    expect(env.metaTimeoutMs).toBe(300000);
    expect(env.metaMaxRetries).toBe(1);
  });

  it("respects the configured model timeout as-is", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const env = loadEnv({
        FRONTEND_ORIGIN: "http://localhost:3000",
        META_TIMEOUT_MS: "60000",
      });
      expect(env.metaTimeoutMs).toBe(60000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects an invalid model configuration by name", () => {
    for (const vars of [
      { META_TIMEOUT_MS: "50" },
      { META_MAX_RETRIES: "9" },
      { META_BASE_URL: "http://insecure.example/v1" },
      { META_BASE_URL: "not a url" },
    ]) {
      expect(() =>
        loadEnv({ FRONTEND_ORIGIN: "http://localhost:3000", ...vars }),
      ).toThrowError(/META_(TIMEOUT_MS|MAX_RETRIES|BASE_URL)/);
    }
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
