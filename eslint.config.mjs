import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Bundled Express API output (gitignored build artifact).
    "backend/dist/**",
  ]),
  // Frontend/backend boundary: client code (app/, components/) may use only
  // the shared contracts (lib types/schemas/consts/utils). Server-only
  // modules — backend code, env config, PDF extraction, inference, the
  // pipeline, and file/Mongo stores — must never enter the browser bundle.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/backend/src/app", message: "Frontend must call the API over HTTP, not import backend code." },
            { name: "@/lib/config", message: "Server-only env config must never enter the frontend bundle." },
            { name: "@/lib/pipeline", message: "Server-only pipeline must never enter the frontend bundle." },
            { name: "@/lib/store/local", message: "Server-only store must never enter the frontend bundle." },
            { name: "@/lib/demo", message: "Server-only demo seeding must never enter the frontend bundle." },
          ],
          patterns: [
            { group: ["@/backend/**", "backend/**"], message: "Frontend must call the API over HTTP, not import backend code." },
            { group: ["@/server/**", "server/**"], message: "Removed path: backend code lives in backend/." },
            { group: ["@/lib/pdf/**", "@/lib/inference/**", "@/lib/text/**", "@/lib/eval/**"], message: "Server-only lib modules must never enter the frontend bundle." },
            { group: ["../backend/**", "../../backend/**", "../server/**"], message: "Frontend must call the API over HTTP, not import backend code." },
          ],
        },
      ],
    },
  },
  // The committed Vercel stub is plain CommonJS by design (Vercel loads
  // api/*.js as CJS), so require() is its only import mechanism.
  {
    files: ["api/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Mirror boundary: backend and the Vercel adapter never import UI code.
  // Application runtime is MongoDB-only: the filesystem store adapter is
  // test-only scaffolding (unit tests and the offline eval harness
  // instantiate it directly) and must never be imported by backend code.
  {
    files: ["backend/**/*.ts", "api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/components/**", "@/app/**", "../components/**", "../app/**"], message: "Backend must never import frontend UI code." },
            { group: ["**/lib/store/local"], message: "Filesystem storage is test-only; application runtime uses MongoDB (see getStore)." },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
