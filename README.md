# VDR Auditor

Due-diligence workspace: matters group deal PDFs (MongoDB GridFS); upload
automatically triggers text extraction and Meta-powered analysis with
evidence-backed findings. A Next.js frontend and an Express backend, each
independently deployable to Vercel. No auth or billing yet.

```
vdr-auditor/
├── data/          # Preserved source documents (PDFs). Never modified by the apps.
├── frontend/      # Next.js App Router status page (port 3000)
├── backend/       # Express API with /api/health endpoints (port 4000)
└── README.md
```

## Prerequisites

- Node.js 22+ and npm. The backend pins `engines: 22.x` because pdfjs-dist requires Node ≥22.13; older runtimes fail every PDF extraction as `unparseable`, and the backend refuses to boot on them.
- A MongoDB Atlas cluster (only needed for the readiness check; see below).
  Create the database user and IP allowlist entry in Atlas yourself — this repo
  contains no credentials and no seed data.

## Installation

```bash
cd frontend && npm install
cd ../backend && npm install
```

## Environment setup

```bash
cp frontend/.env.example frontend/.env.local
cp backend/.env.example backend/.env
```

Then edit the copies:

- `frontend/.env.local`: `NEXT_PUBLIC_API_URL` must be the backend base URL
  (default `http://localhost:4000`). Never put secrets in `NEXT_PUBLIC_*`.
- `backend/.env`: set `FRONTEND_ORIGIN` to the exact frontend origin
  (default `http://localhost:3000`). Paste your own Atlas connection string
  into `MONGODB_URI` when you want readiness to pass; leave it empty and
  `/api/health/ready` returns HTTP 503.

`.env`, `.env.local`, and `*.local` files are gitignored. Never commit them.

## Running both services (two terminals)

Terminal 1 — backend:

```bash
cd backend
npm run dev
```

Terminal 2 — frontend:

```bash
cd frontend
npm run dev
```

Local URLs:

- Frontend: http://localhost:3000
- Liveness: http://localhost:4000/api/health (200 when the process runs)
- Readiness: http://localhost:4000/api/health/ready (200 after a real MongoDB
  ping, 503 when MongoDB is unconfigured or unreachable)

## Testing health checks

```bash
# Liveness — no database needed
curl http://localhost:4000/api/health

# Readiness — 200 only after a successful MongoDB ping
curl -w '\nHTTP %{http_code}\n' http://localhost:4000/api/health/ready
```

Backend unit tests mock MongoDB (no real database required):

```bash
cd backend && npm test
```

Per-app checks:

```bash
cd frontend && npm run typecheck && npm run lint && npm run build
cd backend && npm run typecheck && npm run lint && npm test && npm run build
```

## Matters API

Matters are stored in the `matters` collection of the configured database
(one `{ createdAt: -1 }` index backs the newest-first listing).

- `GET /api/matters` → 200 with matters newest first (`[]` when empty).
- `POST /api/matters` with `{ title, description?, status? }` → 201 with the
  persisted matter. Title is required (1–120 chars after trimming),
  description is optional (≤2000 chars), status is `active` (default),
  `on_hold`, or `completed`. IDs and timestamps are server-generated;
  client-supplied ones are ignored. Invalid input → 400
  `{ error: "validation_error", issues: [...] }`.
- `GET /api/matters/:id` → 200 with the matter, 404 `{ error: "not_found" }`
  when absent, 400 `{ error: "invalid_id" }` for malformed IDs.
- When MongoDB is unconfigured or unreachable, all three endpoints return
  503 `{ error: "database_unavailable" }` without exposing internals.

```bash
curl http://localhost:4000/api/matters
curl -X POST http://localhost:4000/api/matters \
  -H 'content-type: application/json' \
  -d '{"title":"Smith merger review","status":"active"}'
```

## Documents API (PDFs in MongoDB GridFS)

PDF bytes live in MongoDB GridFS (bucket `pdfs`, i.e. `pdfs.files` and
`pdfs.chunks`); metadata lives in the `documents` collection (one
`{ matterId: 1, createdAt: -1 }` index backs per-matter listings). Each file
shares its metadata record's `_id`, so bytes and metadata stay linked with
no separate storage reference. No third-party file storage is used.

- `GET /api/matters/:id/documents` → 200 with the matter's documents, newest
  first. 400 for a malformed matter id, 404 `{ error: "matter_not_found" }`.
- `POST /api/matters/:id/documents` with the raw PDF bytes as the body,
  `Content-Type: application/pdf`, and the filename in the `X-Filename`
  header (URL-encoded) → 201 `{ document, processing }`. PDFs only:
  `.pdf` name, exact content type, 25 MiB default cap (`MAX_PDF_BYTES`),
  and a server-side `%PDF-` magic-header check. Oversize → 413
  `file_too_large`, other bad input → 400 `validation_error`. A
  successful upload persists a processing run and starts extraction
  automatically (see below); the response returns immediately without
  waiting for it.
- `GET /api/matters/:id/documents/:docId/download` → 200 streaming the PDF
  bytes as an attachment. 404 `{ error: "document_not_found" }` for missing
  or cross-matter documents.
- `DELETE /api/matters/:id/documents/:docId` → 204, cascading the
  document's findings, analysis runs, processing runs, stored bytes, and
  record. 409 `{ error: "processing_in_progress" }` while an active run
  has a fresh heartbeat, so a worker can never recreate orphaned
  findings. A storage failure returns 503 and keeps the record, so
  retrying never reports a false success.

Database failures return 503 `database_unavailable` with no internals.

```bash
MID=<matter id>
curl -X POST http://localhost:4000/api/matters/$MID/documents \
  -H 'content-type: application/pdf' \
  -H 'X-Filename: contract.pdf' \
  --data-binary @contract.pdf
curl http://localhost:4000/api/matters/$MID/documents
```

## Text extraction (Mozilla PDF.js, no OCR)

`POST /api/matters/:id/documents/:docId/extract` extracts text synchronously
and persists the result on the document record:

- Statuses: `pending` (never tried) → `processing` → `completed`, `no_text`,
  or `failed`. A concurrent request while `processing` returns 409.
- `completed` stores `extractedText` (pages joined by a form-feed
  separator), `pageCount`, and `extractedAt`. Scanned PDFs with no text
  layer return `no_text` — this is text-layer extraction only, never OCR.
- Unreadable PDFs return 422 `{ error: "extraction_failed", code }` with a
  safe code (`encrypted`, `unparseable`, or `limit_exceeded`); the record
  keeps `failed` plus the code. Limits: 200 pages, 500,000 characters.
- Retries are safe: a failed attempt never erases an earlier successful
  result, and infrastructure failures restore the previous status.
- The list endpoint includes the extraction fields, so no separate
  fetch is needed to display status and text.

```bash
curl -X POST http://localhost:4000/api/matters/$MID/documents/$DID/extract
```

## Due-diligence analysis (Meta Model API)

`POST /api/matters/:id/documents/:docId/analysis` analyzes a document's
stored extracted text with the configured model and persists evidence-backed
findings. Only documents with completed extraction are eligible.

- Categories: `change_of_control`, `missing_signatures`, `uncapped_liabilities`.
- Severity: `high` (likely material, escalate promptly), `medium`
  (potentially material or ambiguous), `low` (minor or unclear). Findings are
  issue-spotting results for human review, not legal advice.
- Every stored finding passed verification: its excerpt occurs in the
  stored text (whitespace- and case-tolerant), and its page (or explicit
  `null` when unmappable) was checked against that page's text — model
  page numbers are never trusted on their own. Unverifiable model output
  is dropped, never stored.
- Long documents are analyzed end to end in bounded paragraph-aware
  sections (12,000 chars, splits prefer clause headings, up to 200
  sections and 200 findings per run, 4 sections concurrently).
  Sections are independent: one section's failure never discards
  another's verified findings, and one malformed finding never discards
  its valid siblings. Runs that cannot cover everything are marked
  `limited` with explicit `limitations` instead of truncating silently;
  an empty result counts as clean only when every section completed.
  Tune with `ANALYSIS_SECTION_CHARS`, `ANALYSIS_MAX_SECTIONS`,
  `ANALYSIS_CONCURRENCY`, `ANALYSIS_MAX_FINDINGS`.
- Run lifecycle: `running` → `completed`, `limited`, or `failed`. One
  running run per document (409 otherwise). Failed runs never touch
  previous successful findings; deleting a document cascades its runs and
  findings.
- Other endpoints: `GET .../documents/:docId/analysis` (latest run plus
  current findings), `GET /api/matters/:id/analyses` (latest run per
  document), `GET /api/matters/:id/findings` (current findings with source
  filenames), `PATCH /api/matters/:id/findings/:findingId` with
  `{ reviewStatus: open|confirmed|dismissed }`.
- Configuration (backend only, never exposed to the browser): `META_API_KEY`,
  `META_MODEL_ID`, optional `META_BASE_URL` (https, default
  `https://api.meta.ai/v1`), `META_TIMEOUT_MS` (per-model-call budget,
  default 60000, respected as configured; long runs are bounded by the
  section/findings caps plus an overall run deadline instead),
  `META_MAX_RETRIES` (0–5, 429/5xx/timeout/network only, honors
  `Retry-After`). Only provider parameters verified for the Meta
  endpoint are sent (`model`, `messages`, `response_format`). Without
  key/model, analysis endpoints return 503 `analysis_unconfigured`.
- Slow or skipped sections surface as run error `timeout`
  ("Analysis timed out…"), distinct from `unavailable` (provider 5xx).
  Retrying resumes with a fresh budget; deterministic errors (`auth`,
  `bad_request`, `model_not_found`, `truncated`) fail fast without
  burning retries.

```bash
curl -X POST http://localhost:4000/api/matters/$MID/documents/$DID/analysis
curl http://localhost:4000/api/matters/$MID/findings
```

## Automatic processing + global progress

Uploading a PDF runs the whole pipeline without further clicks. The
upload response returns 201 as soon as the metadata record is stored —
it never waits for the multi-megabyte byte transfer, so slow uplinks
cannot push it past client or serverless timeouts. The bytes persist in
the background (`bytesStored: false` until they land), then a persisted
run in the `processing_runs` collection advances `queued → extracting →
analyzing → completed` (or `completed_with_limits`, or `failed` with a
safe error code). Analysis starts only after extraction succeeds;
textless PDFs end as `completed_with_limits`, unreadable ones
as `failed`. Retrying a failure reuses completed extraction and never
erases previous successful findings. Uploads whose bytes never arrive
(dead process, killed function) are failed as `upload_interrupted` by
the recovery sweep; byte-dependent endpoints answer 409
`upload_in_progress` (still storing) or 422 `upload_incomplete`
(interrupted: delete and re-upload).

- `POST /api/matters/:id/documents/:docId/process` starts or retries
  processing. Idempotent: an active run is returned (200) instead of
  duplicated; a stale-heartbeat run is revived; otherwise a new run is
  created (201). Unknown documents → 404.
- `GET /api/processing` (optional `?matterId=`) lists active runs plus
  runs finished in the last 24h, newest first (max 50), each with the
  matter title and filename for display. Read-only; it never drives work.
- Runs are server state: closing the tab, navigating away, or
  refreshing never interrupts them.
- Recovery is durable, not a detached callback: the upload response
  kicks the driver (via `waitUntil` on Vercel, detached locally), and a
  recovery sweep finishes whatever is left behind. Long-lived servers
  (`src/server.ts`) sweep on startup and every 60s; serverless
  deployments sweep through `GET/POST /api/processing/recover` (see the
  Vercel notes below). Heartbeats plus atomic claiming keep exactly one
  driver per run; stale runs are resumed, stale extraction locks healed,
  and runs that never progress age out as `failed/interrupted` after
  30 minutes — no run stays active forever. Run a single long-lived
  backend per database: concurrent sweepers arbitrate through atomic
  claiming, but only one sweeper should own startup claim-release.
- Every run logs `drive-started`, per-stage `stage-finished` (with
  durations, finding counts, and section coverage), and `drive-finished`
  as JSON lines carrying run/matter/doc IDs and safe error codes —
  never document text or credentials. Model calls log sanitized
  per-attempt telemetry (`scope: "meta"`): attempt, section, status,
  duration, and failure category only.
- The UI shows a compact global progress panel (bottom-right) across
  all pages: filename, matter, live stage, and a link back to the
  document row. It polls only while runs are active, survives refresh
  (state comes from the server), and completed/failed items can be
  dismissed without deleting results. Polls back off (4s to 15s) while
  runs sit unchanged, and the panel reuses page poll results instead of
  refetching the same runs. Document rows show the live stage
  with Retry on failure, and deletion is paused during active
  processing.

## Vercel deployment (two separate projects)

Deploy in this order: backend first, then the frontend, then verify and
adjust. Placeholders like `<your-backend-domain>` are yours to fill in —
never invent or commit real deployment URLs.

### 1. Backend project

- Root Directory: `backend`
- Framework/runtime: Express on Vercel's Node.js runtime. Vercel
  auto-detects the app from the default Express export in `src/app.ts`
  (zero-configuration Express support; it runs as a single serverless
  function and Express's router serves every path, so `/api/health` and
  `/api/health/ready` work with no rewrites). No `vercel.json` and no
  custom server needed.
- Production environment variables (Vercel dashboard → project Settings →
  Environment Variables):
  - `NODE_ENV=production`
  - `FRONTEND_ORIGIN=https://<your-frontend-domain>` — must exactly match
    the deployed frontend's HTTPS origin (scheme + host, no trailing
    slash). No wildcard. If you deploy the frontend first with a temporary
    value, update this afterwards.
  - `MONGODB_URI` — your production connection string (paste the real
    value only in the dashboard, never in the repo).
  - `MONGODB_DB_NAME=vdr_auditor` (or your production database name).
  - `PORT` is not needed on Vercel (functions do not listen on a port).
- `src/server.ts` is local-dev only and is not used on Vercel.
- After deploying, note the backend's public URL:
  `https://<your-backend-domain>`. Verify
  `https://<your-backend-domain>/api/health` returns HTTP 200 and
  `/api/health/ready` returns HTTP 200 (it returns 503 until MongoDB is
  reachable from Vercel — for Atlas, allowlist Vercel's access in Atlas
  network settings).

### 2. Frontend project

- Root Directory: `frontend`
- Framework: Next.js (auto-detected, native support)
- Production environment variable:
  `NEXT_PUBLIC_API_URL=https://<your-backend-domain>` — the backend's
  public URL from step 1 (no trailing slash). Never put secrets in
  `NEXT_PUBLIC_*`.
- Build: `npm run build` (default). `NEXT_PUBLIC_API_URL` is baked in at
  build time: after changing it, you must redeploy (rebuild) the frontend
  for the new value to take effect.
- After deploying, open `https://<your-frontend-domain>` and confirm the
  matters list loads. If it shows a backend error, the frontend is likely
  pointing at the wrong backend URL or the backend deployment failed — fix
  the value and redeploy.

### 3. Verify and reconcile

- The backend's `FRONTEND_ORIGIN` must equal the frontend's real origin;
  the frontend's `NEXT_PUBLIC_API_URL` must equal the backend's real URL.
  Update whichever value is stale and redeploy that project (frontend
  changes always require a rebuild).
- CORS rejects any origin other than `FRONTEND_ORIGIN`; there is no
  wildcard in production.

Notes:

- Vercel's serverless request-size limit (~4.5 MB on Hobby/Pro) applies
  before the app's own 25 MB PDF cap: larger files are rejected by the
  platform with a non-JSON 413, which the client reports as "too large
  to upload". Files under the platform limit upload normally.
- The MongoDB client is a shared lazy singleton: one client per process,
  reused across warm function invocations, and never one connection per
  request. No request depends on a permanently running process or
  in-memory session state.
- Processing completion on Vercel is best-effort after the response:
  `waitUntil` (dependency `@vercel/functions`) lets the driver advance
  only within the function's `maxDuration`, and the platform may freeze
  or recycle the instance at any time — background completion after a
  serverless response is therefore NOT guaranteed. Durable progress
  comes from the recovery endpoint: schedule `GET
  /api/processing/recover` (idempotent, claim-arbitrated, safe to call
  concurrently) on a scheduler such as Vercel Cron, e.g. every 5
  minutes via a `backend/vercel.json` `crons` entry (sub-daily
  schedules need a paid Vercel plan; otherwise use an external
  scheduler). Each invocation drives up to 25 stale runs within its own
  `maxDuration`; consider raising `maxDuration` for the backend
  function so sweeps can finish. Without any schedule, abandoned runs
  still resume through the document Retry button, but nothing advances
  them while nobody clicks. Large multi-section documents are safest
  on a long-lived host (`node dist/server.js`), which sweeps
  automatically.
- Health responses never include env values, credentials, stack traces, or
  connection strings. Liveness reports the runtime Node version so a wrong
  runtime is visible without backend access.
- `backend/vercel.json` pins extra traced files into the serverless bundle,
  and `pdfLoader.ts` imports the worker module with a literal path as a
  backstop: pdf.js loads its worker (`pdf.worker.mjs`) through a dynamic
  import that file tracing cannot see, so without them every extraction
  fails as `unparseable` in production while working locally. Keep both
  when upgrading pdfjs-dist. (Only `functions.includeFiles` is used: the
  newer-sounding top-level tracing key does not exist in Vercel's schema
  and fails the deploy.)

## Scope boundary

Not implemented: auth, billing, and deployment automation. Findings are
issue-spotting results for human review, not legal advice.
