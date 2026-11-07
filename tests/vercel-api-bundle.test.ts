import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Guards the Vercel API function against the production startup failure of
 * ESM syntax landing in a CommonJS-loaded file:
 *
 *   /var/task/api/index.js:1 - SyntaxError: Cannot use import statement
 *   outside a module
 *
 * The function ships as ONE esbuild bundle (`npm run build:vercel-api`,
 * format=cjs) so no TypeScript and no extensionless relative import ever
 * reaches the runtime. These tests rebuild that exact bundle in memory and
 * pin every invariant the deploy depends on.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function bundleApi(): string {
  const out = buildSync({
    entryPoints: [join(ROOT, "backend/src/vercel.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    write: false,
    logLevel: "silent",
  });
  expect(out.outputFiles).toHaveLength(1);
  return out.outputFiles[0].text;
}

const code = bundleApi();

describe("Vercel API bundle (api/index.js)", () => {
  it("emits CommonJS that parses outside a module (no ESM import statements)", () => {
    expect(() => new Script(code, { filename: "api/index.js" })).not.toThrow();
  });

  it("bundles all local code (no relative requires left for Node to resolve)", () => {
    expect(code).not.toMatch(/require\(["']\.\.?\//);
    expect(code).not.toMatch(/from\s+["']\.\.?\//);
  });

  it("keeps node_modules external (traced by Vercel, incl. pdfjs-dist for fonts)", () => {
    expect(code).toMatch(/require\(["']express["']\)/);
    expect(code).toMatch(/require\(["']pdfjs-dist\/legacy\/build\/pdf\.mjs["']\)/);
  });

  it("keeps .js as CommonJS (root package.json must not declare type: module)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      type?: string;
    };
    expect(pkg.type ?? "commonjs").toBe("commonjs");
  });

  it("regenerates the bundle on every production build", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain("build:vercel-api");
    expect(pkg.scripts["build:vercel-api"]).toContain("backend/src/vercel.ts");
    expect(pkg.scripts["build:vercel-api"]).toContain("--format=cjs");
    expect(pkg.scripts["build:vercel-api"]).toContain("api/index.js");
    // The Next.js preset's default build command is `next build`, which
    // would skip the bundle step — vercel.json must pin `npm run build`.
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      buildCommand?: string;
    };
    expect(vercel.buildCommand).toBe("npm run build");
  });
});
