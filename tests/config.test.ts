import { describe, expect, it } from "vitest";
import { getConfig, resetConfigCache } from "@/lib/config";

const base = {
  INFERENCE_PROVIDER: "mock",
  MAX_UPLOAD_BYTES: "100",
  MAX_PDF_PAGES: "10",
  STORAGE_DIR: ".data",
} as unknown as NodeJS.ProcessEnv;

describe("getConfig", () => {
  it("applies defaults for a minimal environment", () => {
    resetConfigCache();
    const config = getConfig({} as NodeJS.ProcessEnv);
    expect(config.INFERENCE_PROVIDER).toBe("mock");
    expect(config.MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
    expect(config.MAX_PDF_PAGES).toBe(200);
    expect(config.BASETEN_BASE_URL).toBe("https://inference.baseten.co/v1");
    expect(config.BASETEN_TIMEOUT_MS).toBe(60000);
    expect(config.BASETEN_MAX_RETRIES).toBe(2);
    expect(config.STORAGE_BACKEND).toBe("local");
  });

  it("coerces numeric strings", () => {
    expect(getConfig(base).MAX_UPLOAD_BYTES).toBe(100);
  });

  it("rejects invalid values", () => {
    expect(() => getConfig({ ...base, MAX_UPLOAD_BYTES: "-5" })).toThrow(/Invalid environment/);
    expect(() => getConfig({ ...base, INFERENCE_PROVIDER: "openai" })).toThrow(/Invalid environment/);
  });

  it("parses the structured-outputs flag, defaulting to true", () => {
    expect(getConfig(base).BASETEN_STRUCTURED_OUTPUTS).toBe(true);
    expect(getConfig({ ...base, BASETEN_STRUCTURED_OUTPUTS: "false" }).BASETEN_STRUCTURED_OUTPUTS).toBe(false);
    expect(() => getConfig({ ...base, BASETEN_STRUCTURED_OUTPUTS: "yes" })).toThrow(/Invalid environment/);
  });

  it("bounds Baseten tuning knobs", () => {
    expect(getConfig({ ...base, BASETEN_TIMEOUT_MS: "5000" }).BASETEN_TIMEOUT_MS).toBe(5000);
    expect(() => getConfig({ ...base, BASETEN_TIMEOUT_MS: "50" })).toThrow(/Invalid environment/);
    expect(() => getConfig({ ...base, BASETEN_MAX_RETRIES: "9" })).toThrow(/Invalid environment/);
  });

  it("requires MONGODB_URI when the mongodb backend is selected", () => {
    expect(() => getConfig({ ...base, STORAGE_BACKEND: "mongodb" })).toThrow(/MONGODB_URI/);
    const ok = getConfig({
      ...base,
      STORAGE_BACKEND: "mongodb",
      MONGODB_URI: "mongodb://127.0.0.1:27017/db",
    });
    expect(ok.STORAGE_BACKEND).toBe("mongodb");
    expect(() => getConfig({ ...base, MONGODB_URI: "not-a-uri" })).toThrow(/MONGODB_URI/);
  });

  it("rejects the removed PostgreSQL variables with a clear message", () => {
    expect(() => getConfig({ ...base, DATABASE_URL: "postgresql://x/y" })).toThrow(/MONGODB_URI/);
    expect(() => getConfig({ ...base, STORAGE_BACKEND: "postgres" })).toThrow(/Invalid environment/);
  });

  it("requires FRONTEND_ORIGIN in production for API CORS", () => {
    expect(() =>
      getConfig({ ...base, NODE_ENV: "production", PILOT_ACCESS_TOKEN: "a".repeat(32) }),
    ).toThrow(/FRONTEND_ORIGIN/);
    const ok = getConfig({
      ...base,
      NODE_ENV: "production",
      PILOT_ACCESS_TOKEN: "a".repeat(32),
      FRONTEND_ORIGIN: "https://app.example.com",
    });
    expect(ok.FRONTEND_ORIGIN).toBe("https://app.example.com");
  });

  it("requires Baseten credentials when the Baseten provider is selected", () => {
    expect(() => getConfig({ ...base, INFERENCE_PROVIDER: "baseten" })).toThrow(
      /BASETEN_API_KEY and BASETEN_MODEL_ID/,
    );
    const ok = getConfig({
      ...base,
      INFERENCE_PROVIDER: "baseten",
      BASETEN_API_KEY: "key",
      BASETEN_MODEL_ID: "some/slug",
    });
    expect(ok.BASETEN_MODEL_ID).toBe("some/slug");
  });

  it("requires the pilot token in production and a strong token when set", () => {
    expect(() => getConfig({ ...base, NODE_ENV: "production" })).toThrow(/PILOT_ACCESS_TOKEN/);
    expect(() => getConfig({ ...base, PILOT_ACCESS_TOKEN: "short" })).toThrow(/Invalid environment/);
    const ok = getConfig({
      ...base,
      NODE_ENV: "production",
      PILOT_ACCESS_TOKEN: "a".repeat(32),
      FRONTEND_ORIGIN: "https://app.example.com",
    });
    expect(ok.PILOT_ACCESS_TOKEN).toBe("a".repeat(32));
  });

  it("refuses storage inside public/", () => {
    expect(() => getConfig({ ...base, STORAGE_DIR: "public/uploads" })).toThrow(/public/);
    expect(() => getConfig({ ...base, STORAGE_DIR: "public" })).toThrow(/public/);
    expect(getConfig({ ...base, STORAGE_DIR: ".data" }).STORAGE_DIR).toBe(".data");
  });

  it("requires https for the inference endpoint when provider is baseten", () => {
    expect(() =>
      getConfig({
        ...base,
        INFERENCE_PROVIDER: "baseten",
        BASETEN_API_KEY: "key",
        BASETEN_MODEL_ID: "m",
        BASETEN_BASE_URL: "http://127.0.0.1:8080/v1",
      }),
    ).toThrow(/https/);
  });

  it("never includes secret values in validation errors", () => {
    const secret = "sk-secret-marker-xyz";
    let message = "";
    try {
      getConfig({ ...base, INFERENCE_PROVIDER: "baseten", BASETEN_API_KEY: secret });
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("BASETEN_MODEL_ID");
    expect(message).not.toContain(secret);
  });
});
