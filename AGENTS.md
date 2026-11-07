<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## VDR Auditor conventions (Phase 1)

- ES modules, TypeScript strict, App Router. Client components fetch JSON API routes; no `runtime` segment export (cacheComponents forbids it).
- Zod at every trust boundary: env (`lib/config.ts`), uploads, API bodies, inference output.
- `lib/` is UI-free and unit-testable. Keep modules small: pdf, text, findings, evidence, inference, store, pipeline.
- Never use client filenames in storage paths (generated UUIDs only). Storage root stays out of `public/`.
- Never log API keys, contract text, or evidence. Log IDs, sizes, counts, outcomes.
- Mock inference is deterministic (no randomness, no Date in output). Baseten client is live behind `INFERENCE_PROVIDER=baseten`; tests must stub HTTP, never call it.
- Layout: frontend = `app/` + `components/` (Next.js owns the root); backend = `backend/src` (Express, Vercel entry `api/index.ts` thin adapter); `lib/` is the shared domain layer both sides import. Boundary enforced by ESLint + `tests/architecture.test.ts`. Next.js is UI only. Frontend calls `${NEXT_PUBLIC_API_BASE_URL}/api/*` (same-origin dev proxy otherwise).
- Storage: `STORAGE_BACKEND=local` (JSON, eval/offline) or `mongodb` (Atlas in prod). Mongo repository tests require `TEST_MONGODB_URI` and fail loudly without it — never skip silently.
- Dev: `npm run dev` starts backend (:3001) + frontend (:3000) together; `npm run dev:api` / `npm run dev:web` start each alone. Never run the frontend without the backend — the `/api/*` proxy refuses connections otherwise.
- Checks: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run config:validate`, `npm run build`, `npm run build:api`.
- Eval harness: `npm run eval -- --mode mock` (offline); live needs `--confirm-live` plus Baseten env. Reports go to gitignored `evals/reports/`.
- Docs: plan in `docs/plan.md`, Baseten notes in `docs/baseten.md`. Source PRD docx stays at root.
