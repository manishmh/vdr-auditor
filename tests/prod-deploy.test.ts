import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import nextConfig from "@/next.config";

/**
 * Single-project production deploy: one Vercel project serves the Next.js
 * UI and the Express API (same-origin /api/* via vercel.json). These tests
 * pin the routing config and the placeholder-only prod env checklist so a
 * refactor cannot silently break the deploy or leak a secret into the repo.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRoot(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

/** Uncommented KEY=value assignments of an env-style file. */
function activeEntries(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

describe("single-project Vercel routing", () => {
  it("routes /api/* to the Express adapter with no conflicting rewrites", () => {
    const vercel = JSON.parse(readRoot("vercel.json")) as {
      rewrites?: { source: string; destination: string }[];
      functions?: Record<string, { includeFiles?: string }>;
    };
    expect(vercel.rewrites).toHaveLength(1);
    expect(vercel.rewrites![0]).toEqual({ source: "/api/:path*", destination: "/api/index" });
    // pdf.js font assets ship with the function; without them extraction
    // fails closed by design.
    expect(vercel.functions?.["api/index.js"]?.includeFiles).toContain("pdfjs-dist");
  });

  it("never bakes the localhost dev proxy into production builds", async () => {
    expect(typeof nextConfig.rewrites).toBe("function");
    vi.stubEnv("NODE_ENV", "production");
    try {
      vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
      const unset = (await nextConfig.rewrites!()) as unknown[];
      expect(unset).toHaveLength(0);
      vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.com");
      const split = (await nextConfig.rewrites!()) as unknown[];
      expect(split).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Node runtime pin", () => {
  it("pins engines.node and .nvmrc so production cannot float majors", () => {
    const pkg = JSON.parse(readRoot("package.json")) as { engines?: { node?: string } };
    // Vercel reads engines.node (overriding the dashboard default); the
    // mongodb driver requires >=20.19.0 and the suite runs on Node 22.
    expect(pkg.engines?.node).toBe("22.x");
    expect(readRoot(".nvmrc").trim()).toBe("22");
  });
});

describe("production env checklist (.env.prod)", () => {
  const entries = activeEntries(readRoot(".env.prod"));

  it("names every production-required server variable", () => {
    for (const name of [
      "NODE_ENV",
      "PILOT_ACCESS_TOKEN",
      "FRONTEND_ORIGIN",
      "STORAGE_BACKEND",
      "MONGODB_URI",
      "INFERENCE_PROVIDER",
      "BASETEN_API_KEY",
      "BASETEN_MODEL_ID",
      "MAX_UPLOAD_BYTES",
    ]) {
      expect(entries.has(name), `missing ${name}`).toBe(true);
    }
  });

  it("keeps every secret empty (names only, values live in Vercel)", () => {
    for (const name of ["PILOT_ACCESS_TOKEN", "MONGODB_URI", "BASETEN_API_KEY"]) {
      expect(entries.get(name)).toBe("");
    }
    for (const [name, value] of entries) {
      expect(value, name).not.toMatch(/mongodb(\+srv)?:\/\/.+@/);
      expect(value.length, name).toBeLessThan(32);
    }
  });

  it("leaves the API same-origin and keeps NEXT_PUBLIC_ free of secrets", () => {
    expect(entries.has("NEXT_PUBLIC_API_BASE_URL")).toBe(false);
    for (const name of entries.keys()) {
      if (name.startsWith("NEXT_PUBLIC_")) {
        expect(["NEXT_PUBLIC_MAX_UPLOAD_MB", "NEXT_PUBLIC_MAX_PDF_PAGES"]).toContain(name);
      }
    }
  });

  it("sets no dev-only or removed variables", () => {
    for (const name of ["PORT", "STORAGE_DIR", "TEST_MONGODB_URI", "DATABASE_URL"]) {
      expect(entries.has(name), name).toBe(false);
    }
  });
});

describe("env gitignore", () => {
  it("ignores real/placeholder env files but allows the example", () => {
    const lines = readRoot(".gitignore")
      .split("\n")
      .map((l) => l.trim());
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
    // A bare ".env*" would re-ignore .env.example despite the negation
    // being absent; the explicit triple above is the whole contract.
    expect(lines).not.toContain(".env*");
  });
});
