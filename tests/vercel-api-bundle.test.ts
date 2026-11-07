import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Guards the Vercel API function against two production failures:
 *
 * 1. ESM syntax landing in a CommonJS-loaded file:
 *      /var/task/api/index.js:1 - SyntaxError: Cannot use import statement
 *      outside a module
 *    Fix: the function ships as ONE esbuild bundle (format=cjs) so no
 *    TypeScript and no extensionless relative import ever reaches Node.
 *
 * 2. [unused_function]: the `functions` pattern in vercel.json must match a
 *    file committed BEFORE the build runs — Vercel validates patterns
 *    before the build command, so a build-generated api/index.js never
 *    matches.
 *    Fix: committed CJS stub api/index.js (deployed as-is, requires the
 *    generated backend/dist/vercel-api.cjs bundle, traced by nft).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STUB_REQUIRE = "../backend/dist/vercel-api.cjs";

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

describe("Vercel API bundle (backend/dist/vercel-api.cjs)", () => {
  it("emits CommonJS that parses outside a module (no ESM import statements)", () => {
    expect(() => new Script(code, { filename: "vercel-api.cjs" })).not.toThrow();
  });

  it("bundles all local code (no relative requires left for Node to resolve)", () => {
    expect(code).not.toMatch(/require\(["']\.\.?\//);
    expect(code).not.toMatch(/from\s+["']\.\.?\//);
  });

  it("keeps node_modules external (traced by Vercel, incl. pdfjs-dist for fonts)", () => {
    expect(code).toMatch(/require\(["']express["']\)/);
    expect(code).toMatch(/require\(["']pdfjs-dist\/legacy\/build\/pdf\.mjs["']\)/);
  });

  it("keeps .js/.cjs as CommonJS (root package.json must not declare type: module)", () => {
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
    expect(pkg.scripts["build:vercel-api"]).toContain("backend/dist/vercel-api.cjs");
    // The Next.js preset's default build command is `next build`, which
    // would skip the bundle step — vercel.json must pin `npm run build`.
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      buildCommand?: string;
    };
    expect(vercel.buildCommand).toBe("npm run build");
  });
});

describe("Vercel API stub (api/index.js)", () => {
  it("is committed plain CommonJS requiring the generated bundle", () => {
    const stub = readFileSync(join(ROOT, "api/index.js"), "utf8");
    expect(stub).toContain(`require("${STUB_REQUIRE}")`);
    expect(() => new Script(stub, { filename: "api/index.js" })).not.toThrow();
  });

  it("matches the functions pattern in vercel.json (pre-build validation)", () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      functions?: Record<string, unknown>;
    };
    // Every functions key must match a file present before the build runs.
    for (const pattern of Object.keys(vercel.functions ?? {})) {
      expect(() => readFileSync(join(ROOT, pattern), "utf8")).not.toThrow();
    }
    expect(vercel.functions).toHaveProperty("api/index.js");
  });
});

describe("Vercel API loads like production loads it", () => {
  it("requires as CJS and serves /api/health", async () => {
    // Build to a temp dir UNDER the repo root so the bundle's external
    // requires resolve the repo's node_modules, as in the deployed function.
    const dir = mkdtempSync(join(ROOT, ".tmp-vercel-verify-"));
    try {
      buildSync({
        entryPoints: [join(ROOT, "backend/src/vercel.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        outfile: join(dir, "vercel-api.cjs"),
        logLevel: "silent",
      });
      const load = createRequire(join(ROOT, "package.json"));
      const bundled = load(join(dir, "vercel-api.cjs")) as {
        default?: unknown;
      };
      const handler = (bundled.default ?? bundled) as (
        req: unknown,
        res: unknown,
      ) => void;
      expect(typeof handler).toBe("function");

      const http = load("node:http") as typeof import("node:http");
      const server = http.createServer(handler as never);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const port = (server.address() as { port: number }).port;
        const body = await new Promise<string>((resolve, reject) => {
          http
            .get({ port, host: "127.0.0.1", path: "/api/health" }, (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () => {
                try {
                  expect(res.statusCode).toBe(200);
                  resolve(data);
                } catch (err) {
                  reject(err);
                }
              });
            })
            .on("error", reject);
        });
        expect(body).toBe('{"ok":true}');
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
