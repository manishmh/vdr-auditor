import { createApp } from "./app";

/**
 * Vercel serverless entry source (never deployed directly). `npm run
 * build:vercel-api` bundles this file — backend + lib, no TS left — into
 * `backend/dist/vercel-api.cjs`, which the committed stub `api/index.js`
 * requires (`vercel.json` routes /api/* there). Never put .ts back under
 * api/: Vercel transpiles each file there individually, which reintroduces
 * the ESM-into-CJS startup failure (see tests/vercel-api-bundle.test.ts).
 * The Express app itself is the (req, res) handler. MongoDB connects
 * lazily on first use and the client is reused across warm invocations.
 */
const app = createApp();

export default app;
