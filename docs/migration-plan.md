# Migration plan: PostgreSQL/Prisma → MongoDB, Next Route Handlers → Express

Date: 2026-11-01. Branch: `migrate/mongodb-express`. Phase 4 security
contract (`docs/security.md`) is preserved throughout.

## 1. Current architecture and affected modules

```
browser ──► Next.js App Router ──► Route Handlers (app/api/*, 5 files)
                                        │ Zod │ pilot gate │ UUID scope
                                        ▼
                              lib/pipeline.ts (validate → extract → chunk →
                              analyze → verify → persist)
                                        │                 │
                    lib/store/* (local JSON / Prisma)    lib/inference/* (mock/Baseten)
```

- API: `app/api/documents/route.ts` (GET list, POST upload),
  `app/api/documents/[id]/route.ts` (GET detail, DELETE),
  `app/api/documents/[id]/file/route.ts` (GET download),
  `app/api/documents/[id]/findings/[findingId]/route.ts` (PATCH),
  `app/api/demo/seed/route.ts` (POST). All callers go through the single
  frontend wrapper `components/api.ts` (+ `PilotTokenPrompt`, `Dashboard`,
  `ReviewClient`, `UploadDropzone` as UI consumers).
- Storage: `DocumentStore` interface (`lib/store/types.ts`) with
  `LocalFileStore` (JSON, used by the eval harness + offline dev) and
  `PrismaStore` (`lib/store/prisma.ts` + `prisma/schema.prisma`, 3 models:
  Document/Finding/ReviewEvent). Selected by `STORAGE_BACKEND`.
- Config: `lib/config.ts` (Zod env validation). Auth: `lib/server/pilot-auth.ts`
  (timing-safe Bearer gate). Wiring: `lib/server/context.ts` singletons.
- Untouched by this migration: `lib/pdf/*`, `lib/evidence.ts`,
  `lib/findings/*`, `lib/inference/*`, `lib/text/*`, `lib/risks.ts`,
  `lib/eval/*`, `scripts/eval.ts`, `evals/fixtures/*` (dataset 1.0.0,
  methodology 2.0.0), all UI components except the API base URL.
- Data: no production database exists (never deployed; Postgres was only a
  local scratch instance; `.data/` is gitignored dev data). No record
  migration is required; see §8.

## 2. Target architecture and repository structure

```
browser ──► Next.js (Vercel project "web", repo root)
                │  fetch $NEXT_PUBLIC_API_BASE_URL/… (CORS allowlisted)
                ▼
        Express API (Vercel project "api", repo root, api/index.ts fn)
          server/src/{app,server,routes,controllers,middleware,config}.ts
                │  imports shared domain from lib/ (no duplication)
                ▼
   ┌─ lib/pipeline.ts, lib/pdf, lib/inference, lib/evidence, lib/store/types
   └─ server/src/repositories/mongo-store.ts ──► MongoDB Atlas (TLS)
```

- `lib/` remains the shared domain layer. `lib/store/local.ts` is kept for
  the eval harness and credential-free local dev/test. Prisma files are
  deleted after the cutover is verified.
- `server/src/`: `app.ts` (Express factory: CORS, JSON limit, routes,
  404 + central error handler), `server.ts` (local `listen()` entry),
  `routes/documents.ts`, `routes/demo.ts`, `controllers/*`,
  `middleware/{pilot-auth,upload-limits,errors}.ts`, `config.ts`,
  `repositories/{mongo-client,mongo-store}.ts`, `context.ts` (wiring).
- `api/index.ts` (repo root): Vercel function entry re-exporting the
  Express app (no persistent listener; see §5).
- New runtime deps: `express@4`, `cors`, `multer@1` (+ `@types/*`),
  `mongodb` (official driver). Removed: `prisma`, `@prisma/client`.

## 3. MongoDB document models, identifiers, indexes, relationships

External UUIDs stay the API contract: `_id` IS the UUID string (no
ObjectId is ever exposed). One database (`MONGODB_DB`), three collections:

- `documents`: `{ _id, filename, mimeType, sizeBytes, checksumSha256,
  status, statusDetail, pageCount, findingCount, source, original?: Binary,
  pages?: [{pageNumber, text}], createdAt, updatedAt }`. Statuses/sources
  stored as the existing lowercase strings (no enum translation layer).
- `findings`: `{ _id, documentId, category, severity, title, explanation,
  evidence, pageStart?, pageEnd?, confidence?, recommendedAction, status,
  reviewerNote?, modelId?, createdAt, updatedAt }`.
- `reviewEvents`: `{ _id, documentId, findingId?, action, actor?,
  note?, createdAt }` (`actor` stays null: still no per-user identity).

Indexes (created once at startup): `findings(documentId)`,
`reviewEvents(documentId)`, `documents(createdAt desc)`. `_id` uniqueness is
automatic; duplicate-key errors map to explicit failures, never silent
overwrites. No transactions (keeps standalone/docker Mongo working, not
just replica sets): `saveFindings` = `deleteMany` + ordered `insertMany`,
`updateFinding` = document-scoped read → update → insert event.
Read paths use single queries (find/countDocuments); `findingCount` is
maintained on the document to avoid N+1 on list. Total deletion = one
`deleteOne` on the document + `deleteMany` on findings/events (verified by
test). Connection: one cached `MongoClient` per process (global-guarded),
connected at server startup when the backend is `mongodb`.

## 4. Preserved API contracts and security controls

Same paths (all still under `/api/*`), methods, request/response shapes,
and status codes (201 upload, 200/201 seed, 400/401/403/404/413, 500
generic). Same `{ error, reason? }` JSON error contract via a central
Express error handler. Preserved: timing-safe pilot gate on every route
(header-only Bearer), 32-char minimum + production requirement, upload
size/type validation with a pre-parse Content-Length 413 (plus multer
`fileSize` enforcement during parse), document-scoped finding access
(cross-document → 404), fail-closed `missing_assets` extraction, HTTPS-only
inference URL, demo seeding disabled in production, no secret/content
logging, evidence verification + untrusted-data prompt framing,
server-side-only credentials. New: CORS restricted to `FRONTEND_ORIGIN`
(single validated origin, no credentials), `nosniff` on API responses,
`express.json({limit:"100kb"})` for PATCH bodies.

## 5. Deployment arrangement (Vercel + Atlas)

Two Vercel projects sharing this repo (same root, different settings):

- **web**: Framework Next.js. Builds the UI; `app/api/*` handlers are
  deleted so no server code ships in the frontend. Env:
  `NEXT_PUBLIC_API_BASE_URL` (+ nothing secret).
- **api**: Framework Other (no build command needed; Vercel bundles
  `api/index.ts` as a Node serverless function). Env: `MONGODB_URI`
  (Atlas `mongodb+srv://`, TLS), `MONGODB_DB`, `PILOT_ACCESS_TOKEN`,
  `FRONTEND_ORIGIN`, `INFERENCE_PROVIDER=baseten`, `BASETEN_*`,
  `STORAGE_BACKEND=mongodb`, `MAX_UPLOAD_BYTES` (≤ ~4 MB on Vercel),
  `MAX_PDF_PAGES`. `vercel.json` pins `includeFiles` for
  `node_modules/pdfjs-dist/standard_fonts/**` (runtime `fs` reads are
  invisible to the function tracer; without this, extraction correctly
  fails closed).
- Local dev: `npm run dev:api` (tsx, :3001) + `npm run dev` (:3000) with
  `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`; `STORAGE_BACKEND=local`
  needs no credentials; `mongodb` backend can point at local docker Mongo.
- Known Vercel limits (documented, not worked around by pretending):
  4.5 MB request payload (pilot uploads must stay under it on Vercel),
  function duration/memory caps (large multi-section inference runs belong
  on a long-running host or job worker — see `docs/security.md` §worker);
  serverless concurrency is safe (stateless handlers, pooled client).

## 6. Testing, migration, rollback, acceptance

- New: `tests/mongo-store.test.ts` (disposable DB via `TEST_MONGODB_URI`;
  fails loudly — never silently skips — when unset), rewritten route tests
  against Express on an ephemeral port (auth, validation, limits,
  cross-document, deletion, seed guard). Kept: pdf/evidence/baseten/
  pipeline/eval suites + deterministic mock eval, unchanged.
- Gates: typecheck, lint (zero warnings), full suite with real Mongo,
  `config:validate` (replaces `db:validate`), `build` (web) +
  `build:api` (esbuild bundle proving the deployable resolves), mock eval,
  frontend→API smoke test over HTTP.
- Data migration: none required (§1). Manual path for any Postgres data:
  run the old code from git history to export, re-upload via the new API.
- Rollback: `git checkout main` (+ redeploy); the migration branch keeps
  history intact and Prisma removal is the last step.
- Acceptance: UI workflows pass against Express+Mongo locally; security
  controls in §4 verified by tests; methodology 2.0.0 / dataset 1.0.0
  intact; deployment docs match the implemented architecture. No claim of
  production readiness from green gates alone.
