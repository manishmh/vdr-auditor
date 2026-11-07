import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { makePdf } from "./helpers/make-pdf";

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
  });

  it("never statically requires an ESM (.mjs) module (ERR_REQUIRE_ESM repro)", () => {
    // The production crash: require() of pdfjs-dist's ESM-only build from
    // the CJS bundle throws on Node runtimes without require(esm). The
    // parser must load via dynamic import() instead (see loadPdfjs).
    expect(code).not.toMatch(/require\(["'][^"']*\.mjs["']\)/);
    expect(code).toContain('import("pdfjs-dist/legacy/build/pdf.mjs")');
  });

  it("takes crypto from node:crypto, never the ambient global", () => {
    // The ambient webcrypto global is absent in some runtimes (verified:
    // Node 18 file context throws `crypto is not defined`). Server code
    // must import randomUUID/subtle from node:crypto instead.
    expect(code).not.toMatch(/[^a-zA-Z0-9_.]crypto\.(subtle|randomUUID)/);
    expect(code).toMatch(/require\(["']node:crypto["']\)/);
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
  it("requires as CJS and serves health, listing, and upload", async () => {
    // Build to a temp dir UNDER the repo root so the bundle's external
    // requires resolve the repo's node_modules, as in the deployed function.
    const dir = mkdtempSync(join(ROOT, ".tmp-vercel-verify-"));
    // Production-like env, set BEFORE the bundle loads: config is cached
    // at first require, as in the deployed function.
    const savedEnv = {
      PILOT_ACCESS_TOKEN: process.env.PILOT_ACCESS_TOKEN,
      STORAGE_BACKEND: process.env.STORAGE_BACKEND,
      STORAGE_DIR: process.env.STORAGE_DIR,
      INFERENCE_PROVIDER: process.env.INFERENCE_PROVIDER,
    };
    const load = createRequire(join(ROOT, "package.json"));
    const crypto = load("node:crypto") as typeof import("node:crypto");
    const token = crypto.randomBytes(32).toString("hex");
    process.env.PILOT_ACCESS_TOKEN = token;
    process.env.STORAGE_BACKEND = "local";
    process.env.STORAGE_DIR = join(dir, "store");
    process.env.INFERENCE_PROVIDER = "mock";
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
        const request = (
          path: string,
          options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
        ): Promise<{ status: number | undefined; body: string }> =>
          new Promise((resolve, reject) => {
            const req = http.request(
              { port, host: "127.0.0.1", path, method: options.method ?? "GET", headers: options.headers },
              (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => resolve({ status: res.statusCode, body: data }));
              },
            );
            req.on("error", reject);
            if (options.body) req.write(options.body);
            req.end();
          });

        const health = await request("/api/health");
        expect(health.status).toBe(200);
        expect(health.body).toBe('{"ok":true}');

        const unauth = await request("/api/documents");
        expect(unauth.status).toBe(401);

        const authed = await request("/api/documents", {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(authed.status).toBe(200);

        // Upload exercises the lazy dynamic import of pdfjs for real.
        const pdf = makePdf([
          "This agreement requires written consent for any change of control transaction by either party.",
          "Neither party shall face uncapped liability: the aggregate liability cap is five million dollars.",
        ]);
        const boundary = "vitestboundary";
        const payload = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.pdf"\r\n` +
              `Content-Type: application/pdf\r\n\r\n`,
          ),
          pdf,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const upload = await request("/api/documents", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(payload.length),
          },
          body: payload,
        });
        expect(upload.status).toBe(201);
        const parsed = JSON.parse(upload.body) as {
          document: { status: string };
          findings: unknown[];
        };
        expect(parsed.document.status).toBe("completed");
        expect(Array.isArray(parsed.findings)).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
