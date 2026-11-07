import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architecture boundary test: the frontend (app/, components/) talks to the
 * backend over HTTP and shares only lib contracts (types, schemas, risk
 * categories, formatting utils). This guards the separation independently of
 * ESLint so violations fail `npm run test` too.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out; // optional dir (e.g. api/ before the first build generates it)
  }
  for (const entry of entries) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(join(dir, entry)));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(/(?:import|export)[^"']*["']([^"']+)["']/g)) found.push(match[1]);
  for (const match of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]);
  return found;
}

/** Shared lib modules the browser bundle is allowed to use. */
const FRONTEND_ALLOWED_LIB = new Set([
  "@/lib/store/types",
  "@/lib/findings/schema",
  "@/lib/risks",
  "@/lib/utils",
]);

describe("frontend/backend separation", () => {
  it("keeps server-only modules out of app/ and components/", () => {
    const violations: string[] = [];
    for (const file of [...sourceFiles("app"), ...sourceFiles("components")]) {
      for (const spec of importsOf(file)) {
        if (
          spec.includes("backend/") ||
          spec.includes("server/") ||
          spec === "@/lib/config" ||
          spec === "@/lib/pipeline" ||
          spec === "@/lib/demo" ||
          spec === "@/lib/store/local" ||
          spec.startsWith("@/lib/pdf") ||
          spec.startsWith("@/lib/inference") ||
          spec.startsWith("@/lib/text") ||
          spec.startsWith("@/lib/eval")
        ) {
          violations.push(`${file}: ${spec}`);
        }
        if (spec.startsWith("@/lib/") && !FRONTEND_ALLOWED_LIB.has(spec)) {
          violations.push(`${file}: non-allowlisted shared import ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps UI imports out of backend/ and api/", () => {
    const violations: string[] = [];
    for (const file of [...sourceFiles("backend/src"), ...sourceFiles("api")]) {
      for (const spec of importsOf(file)) {
        if (spec.includes("components/") || spec === "@/app" || spec.startsWith("@/app/")) {
          violations.push(`${file}: ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps backend/src/vercel.ts a thin adapter over backend/", () => {
    const text = readFileSync(join(ROOT, "backend/src/vercel.ts"), "utf8");
    expect(text).toContain("./app");
    expect(text.split("\n").length).toBeLessThan(30);
  });

  it("keeps TypeScript out of api/ (each .ts there becomes a separately transpiled Vercel function)", () => {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(ROOT, "api"));
    } catch {
      entries = [];
    }
    expect(entries.filter((entry) => entry.endsWith(".ts"))).toEqual([]);
  });

  it("has no leftover server/ sources", () => {
    expect(() => readdirSync(join(ROOT, "server"))).toThrow();
  });
});
