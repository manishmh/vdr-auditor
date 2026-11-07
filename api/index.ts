import { createApp } from "../backend/src/app";

/**
 * Vercel serverless entry for /api/* (no persistent listener). Single
 * project: Next.js serves the UI from the same deployment and vercel.json
 * rewrites /api/:path* here. Thin adapter: this file must stay at `api/`
 * (Vercel function convention) and re-export the Express app from
 * `backend/`, where all API code lives. The Express app is itself a
 * (req, res) handler. MongoDB connects lazily on first use and the client
 * is reused across warm invocations.
 */
const app = createApp();

export default app;
