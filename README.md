# VDR Auditor — Phase 1 Foundation

Clean foundation: a Next.js frontend and an Express backend, each independently
deployable to Vercel. Phase 1 covers local runs, health checks, and MongoDB
readiness only. No uploads, AI analysis, auth, or auditor features yet.

```
vdr-auditor/
├── data/          # Preserved source documents (PDFs). Never modified by the apps.
├── frontend/      # Next.js App Router status page (port 3000)
├── backend/       # Express API with /api/health endpoints (port 4000)
└── README.md
```

## Prerequisites

- Node.js 20+ and npm.
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
  header (URL-encoded) → 201 with the stored record. PDFs only: `.pdf`
  name, exact content type, 25 MiB default cap (`MAX_PDF_BYTES`), and a
  server-side `%PDF-` magic-header check. Oversize → 413 `file_too_large`,
  other bad input → 400 `validation_error`.
- `GET /api/matters/:id/documents/:docId/download` → 200 streaming the PDF
  bytes as an attachment. 404 `{ error: "document_not_found" }` for missing
  or cross-matter documents.
- `DELETE /api/matters/:id/documents/:docId` → 204, removing the stored
  bytes and the record. A storage failure returns 503 and keeps the
  record, so retrying never reports a false success.

Database failures return 503 `database_unavailable` with no internals.

```bash
MID=<matter id>
curl -X POST http://localhost:4000/api/matters/$MID/documents \
  -H 'content-type: application/pdf' \
  -H 'X-Filename: contract.pdf' \
  --data-binary @contract.pdf
curl http://localhost:4000/api/matters/$MID/documents
```

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

- The MongoDB client is a shared lazy singleton: one client per process,
  reused across warm function invocations, and never one connection per
  request. No request depends on a permanently running process or
  in-memory session state.
- Health responses never include env values, credentials, stack traces, or
  connection strings.

## Scope boundary

Not implemented: AI integration, PDF parsing/analysis, legal analysis, auth,
billing, background jobs, and deployment automation.
