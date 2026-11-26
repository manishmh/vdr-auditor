/**
 * Copy the pdf.js worker into `public/` so the in-browser PDF viewer can
 * load it same-origin at `/pdf.worker.min.mjs`. Runs on postinstall (local
 * and Vercel): the worker is a build artifact of the installed pdfjs-dist
 * version, never committed. Fails the install loudly when the file moves
 * between pdfjs-dist versions instead of shipping a viewer without one.
 */
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const target = join(here, "..", "public", "pdf.worker.min.mjs");
copyFileSync(source, target);
console.log(`copied pdf.js worker to ${target}`);
