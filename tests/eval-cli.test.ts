import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnvFile, parseEvalArgs } from "@/lib/eval/cli";

describe("parseEvalArgs", () => {
  it("parses mock mode with defaults", () => {
    expect(parseEvalArgs(["--mode", "mock"])).toEqual({
      mode: "mock",
      dataset: "evals/fixtures",
      confirmLive: false,
      concurrency: 1,
      out: "evals/reports",
      only: [],
    });
  });

  it("parses live mode with explicit options", () => {
    expect(
      parseEvalArgs([
        "--mode",
        "live",
        "--dataset",
        "evals/fixtures",
        "--confirm-live",
        "--concurrency",
        "4",
        "--out",
        "/tmp/eval",
        "--only",
        "a,b",
      ]),
    ).toEqual({
      mode: "live",
      dataset: "evals/fixtures",
      confirmLive: true,
      concurrency: 4,
      out: "/tmp/eval",
      only: ["a", "b"],
    });
  });

  it("loads .env values without overriding explicit environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vdr-eval-dotenv-"));
    try {
      await writeFile(join(dir, ".env"), "# comment\nEVAL_TEST_FILL=from-file\nEVAL_TEST_KEEP=from-file\n\nmalformed\n");
      process.env.EVAL_TEST_KEEP = "explicit";
      loadDotEnvFile(dir);
      expect(process.env.EVAL_TEST_FILL).toBe("from-file");
      expect(process.env.EVAL_TEST_KEEP).toBe("explicit");
    } finally {
      delete process.env.EVAL_TEST_FILL;
      delete process.env.EVAL_TEST_KEEP;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a missing .env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vdr-eval-noenv-"));
    try {
      expect(() => loadDotEnvFile(dir)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing mode, bad concurrency, and valueless flags", () => {
    expect(() => parseEvalArgs([])).toThrow(/--mode/);
    expect(() => parseEvalArgs(["--mode", "staging"])).toThrow(/--mode/);
    expect(() => parseEvalArgs(["--mode", "mock", "--concurrency", "0"])).toThrow(/concurrency/);
    expect(() => parseEvalArgs(["--mode", "mock", "--concurrency", "99"])).toThrow(/concurrency/);
    expect(() => parseEvalArgs(["--mode", "mock", "--dataset"])).toThrow(/requires a value/);
  });
});
