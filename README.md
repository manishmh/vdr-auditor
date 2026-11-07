# M&A Due Diligence Data Room Auditor

AI-assisted first-pass review of contract PDFs for M&A due diligence teams.
Upload a contract, get evidence-backed candidate findings across configurable
risk categories, and confirm or dismiss each one with its source text in view.

> **Not legal advice.** This tool surfaces candidate provisions for human review.
> Every finding must be verified by a qualified reviewer. Findings labeled
> **Demo** are synthetic and never came from a real legal review.

Phase 5 status: Next.js frontend, Express REST API, MongoDB persistence,
PDF extraction, evidence verification, review UI, live Baseten inference,
and pilot access controls (see [`docs/plan.md`](docs/plan.md),
[`docs/security.md`](docs/security.md), and
[`docs/migration-plan.md`](docs/migration-plan.md)).
Controlled-pilot candidate only: a shared pilot token gates the API, but there
is no per-user auth, no verified encryption at rest, and no retention policy —
unsuitable for confidential live deals outside a controlled pilot (see below).

## Quickstart

Requirements: Node.js 22+. MongoDB only if you want the `mongodb` storage
backend (local docker is fine; Atlas in production).

```bash
npm install
cp .env.example .env   # mock + local defaults work with no extra setup
npm run dev            # backend :3001 + frontend :3000 together (use this)
```

`npm run dev` launches both services with prefixed logs and shuts both
down on Ctrl+C; if the backend crashes it prints a loud banner instead of
leaving the frontend proxy without a server. To run each independently:
`npm run dev:api` (Express on http://localhost:3001) and `npm run dev:web`
(Next.js on http://localhost:3000). Never run the frontend alone — its
`/api/*` rewrite targets the backend, and without it every API call fails
with `ECONNREFUSED 127.0.0.1:3001`.

Local network access: `npm run dev` also serves the machine's LAN address
(shown as `Network:` in its output). That IP must be listed in
`allowedDevOrigins` in `next.config.ts` — otherwise the page loads as dead
static HTML with no hydration, HMR, or uploads. If the LAN IP changes (new
network/DHCP lease), update the entry to the current `hostname -I` address
and restart `npm run dev`. This setting is development-only; production
origin control stays in the Express CORS allowlist.

Upload any text-based PDF contract to analyze it. (The dashboard's former
"Load demo document" button was removed; the backend seed endpoint remains
for automated tests and local development only, and stays disabled in
production.)

## User workflow

1. Unlock the app with the pilot token (production) — the prompt appears
   automatically when the API requires it.
2. Review the document list; each row shows status, pages, and finding count.
3. Upload a contract PDF (PDF only, size/page caps shown on the dropzone).
   Processing is synchronous: the dropzone shows progress until analysis
   finishes, then links to the review page.
4. Open a document to review candidate findings: severity, category,
   explanation, exact evidence quote with page reference, recommended
   action, confidence, and model.
5. Set a review status (Open / Confirmed / Dismissed / Needs legal review)
   and save reviewer notes per finding.
6. Download the original PDF, or delete the document (with confirmation) —
   deletion permanently erases the upload, text, findings, and review
   history.
7. Read statuses honestly: `failed` means not analyzed (re-upload to
   retry), `needs_ocr` means a scanned PDF the build cannot read, `partial`
   means some sections failed, and zero findings means nothing was flagged —
   never a clean bill of health. A document stuck in `queued`/`processing`
   explains itself on its review page.

Known limitations: no per-user accounts (shared pilot token), no encryption
at rest to claim, no rate limiting, no retention/legal-hold controls, no
OCR, no upload idempotency (retried uploads create duplicates), and the
document list is unpaginated. See `docs/security.md`.

## Scripts

| Command             | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Start backend + frontend together (dev)      |
| `npm run dev:web`   | Start the Next.js frontend alone (dev)       |
| `npm run dev:api`   | Start the Express API alone (dev, :3001)     |
| `npm run build`     | Frontend production build                    |
| `npm run build:api` | Bundle the Express API to `backend/dist/`    |
| `npm start`         | Serve a frontend production build            |
| `npm run start:api` | Serve the bundled API                        |
| `npm run lint`      | ESLint                                       |
| `npm run typecheck` | TypeScript strict check (`tsc --noEmit`)     |
| `npm run test`      | Vitest suite (Mongo tests need `TEST_MONGODB_URI`) |
| `npm run config:validate` | Validate environment configuration    |
| `npm run eval -- --mode mock` | Offline eval over 30 synthetic fixtures |

Live-model eval: `npm run eval -- --mode live --confirm-live` (uses `BASETEN_*`
env; reports land in gitignored `evals/reports/`). Methodology in
[`evals/README.md`](evals/README.md). Synthetic scores do not predict real-world
legal accuracy.

## Environment

Every variable except the three `NEXT_PUBLIC_*` entries belongs to the
backend (or shared tooling); nothing secret may use a `NEXT_PUBLIC_` name.

| Variable              | Default                          | Purpose                                  |
| --------------------- | -------------------------------- | ---------------------------------------- |
| `INFERENCE_PROVIDER`  | `mock`                           | `mock` (deterministic) or `baseten` (live LLM) |
| `BASETEN_API_KEY`     | —                                | Server-side Baseten key (required for `baseten`) |
| `BASETEN_MODEL_ID`    | —                                | Baseten model slug, never hardcoded      |
| `BASETEN_BASE_URL`    | `https://inference.baseten.co/v1` | Model APIs endpoint                     |
| `BASETEN_TIMEOUT_MS`  | `60000`                          | Per-request timeout                      |
| `BASETEN_MAX_RETRIES` | `2`                              | Bounded retries on 429/5xx/network only  |
| `STORAGE_BACKEND`     | `local`                          | `local` (JSON files) or `mongodb`        |
| `MONGODB_URI`         | —                                | Mongo connection string (required for `mongodb`) |
| `MONGODB_DB`          | `vdr_auditor`                    | Mongo database name                      |
| `TEST_MONGODB_URI`    | —                                | Disposable DB for repository tests       |
| `MAX_UPLOAD_BYTES`    | `20971520` (20 MB)               | Upload size cap (≤ ~4 MB on Vercel)      |
| `MAX_PDF_PAGES`       | `200`                            | Page cap per document                    |
| `STORAGE_DIR`         | `.data`                          | Local storage root (gitignored)          |
| `PILOT_ACCESS_TOKEN`  | —                                | Shared API bearer credential (≥32 chars; required in prod) |
| `FRONTEND_ORIGIN`     | `http://localhost:3000` (dev)    | Allowed browser origin for CORS (required in prod) |
| `PORT`                | `3001`                           | Express API port (local)                 |
| `NEXT_PUBLIC_API_BASE_URL` | — (same-origin)             | Frontend → API base URL (public) |
| `NEXT_PUBLIC_MAX_UPLOAD_MB` | `20`                     | Client upload-cap mirror (server re-validates) |
| `NEXT_PUBLIC_MAX_PDF_PAGES` | `200`                    | Client page-cap mirror (label only) |

## MongoDB setup

```bash
docker run -d -p 127.0.0.1:27017:27017 mongo:8   # local development
# in .env:
STORAGE_BACKEND=mongodb
MONGODB_URI=mongodb://127.0.0.1:27017/vdr_auditor
npm run dev:api
```

In production use MongoDB Atlas (`mongodb+srv://…`, TLS) with storage
encryption verified. Each backend owns its records; switching backends does
not migrate data. Originals are stored as BSON Binary at pilot scale —
production should move them to encrypted object storage. Note the 16 MB
BSON document ceiling: keep `MAX_UPLOAD_BYTES` at or below ~14 MB with the
`mongodb` backend; larger files fail with an explicit storage error.

## Baseten setup

1. Create an API key in the Baseten console and pick a Model APIs slug from the
   [supported-models table](https://docs.baseten.co/inference/model-apis/overview.md#supported-models)
   (re-check the live catalog; slugs change).
2. In `.env` (gitignored, never commit):
   `INFERENCE_PROVIDER=baseten`, `BASETEN_API_KEY=…`, `BASETEN_MODEL_ID=<slug>`.
3. Requests are one call per document section with per-request timeouts and
   bounded retries. Auth/model errors fail fast; per-section failures mark the
   document `partial` (or `failed` if nothing was screened) — never clean.
   Models with structured-output support get a `json_schema` response format;
   models without (e.g. Muse Spark Open) need `BASETEN_STRUCTURED_OUTPUTS=false`,
   which requests JSON in the prompt instead. See [`docs/baseten.md`](docs/baseten.md).

To live-test one synthetic PDF (fictional content only, no credentials on the
command line):

```bash
node scripts/make-synthetic-pdf.mjs /tmp/synthetic-test.pdf
INFERENCE_PROVIDER=baseten npm run dev:api   # serves http://localhost:3001
curl -X POST -F "file=@/tmp/synthetic-test.pdf;type=application/pdf" \
  http://localhost:3001/api/documents
```

## Project structure

```
app/            Next.js App Router pages (UI only; no API routes)
components/     UI components (ui/ holds shadcn-style primitives)
backend/src/    Backend: Express API (app, routes, controllers, middleware,
                context, repositories incl. MongoDB) + server startup
api/index.js     Generated Vercel function: single-file CommonJS bundle of
                backend/src/vercel.ts (built by npm run build; gitignored —
                never put .ts under api/, Vercel would transpile it per-file)
lib/
  config.ts     Env validation (Zod)
  risks.ts      Configurable risk categories
  findings/     Validated finding schemas
  pdf/          Upload validation + text extraction (page-level)
  text/         Clause-aware section splitting
  evidence.ts   Quotation verification + page resolution
  inference/    Provider interface, mock + Baseten providers, prompt templates
  store/        Storage interface + local implementation (eval/offline)
  pipeline.ts   validate → extract → chunk → analyze → verify → persist
tests/          Vitest suite (HTTP API tests, Mongo repository tests, eval)
scripts/        dev runner, eval CLI, config check, fixture generators
docs/           Plan, security, migration, Baseten API notes
```

Frontend (`app/`, `components/`), backend (`backend/`), and shared code
(`lib/`) are explicitly separated — enforced by ESLint import rules and
`tests/architecture.test.ts`. `lib/` keeps its name deliberately: renaming
it to `shared/` would churn every import for no gain, and moving `app/` out
of the root would break the single-project Vercel deploy (Next.js serves
the UI from the repository root; see below). The boundary that matters —
no backend or server-only code in the browser bundle, no UI code in the
backend — is enforced by tooling, not just folders.

Local API proxy: the browser calls same-origin `/api/*`; in development
`next.config.ts` rewrites those to `http://localhost:3001/api/*` (the
backend). That rewrite is dev-only (gated on non-production builds). In
the single-project production deploy the browser stays on same-origin
`/api/*` and `vercel.json` routes those to the generated `api/index.js`
serverless function (a CommonJS bundle of `backend/src/vercel.ts`, which
re-exports the Express app from `backend/`) — no separate backend URL or
project required. Setting `NEXT_PUBLIC_API_BASE_URL` opts a frontend
into a split deployment instead.

## Deployment (one Vercel project + MongoDB Atlas)

One Vercel project serves this repository: the Next.js UI from `/` and the
Express API from same-origin `/api/*` (via `vercel.json` → generated
`api/index.js`, bundled from `backend/src/vercel.ts` during the build).
Not yet deployed from here — these steps are written from the implemented
code, not from a verified deploy.

**1. MongoDB Atlas.** Create a cluster and a database user with the
least privilege the app needs (read/write on the app database only — no
admin roles), and allowlist Vercel's egress (Atlas Network Access; see
Atlas docs for the current IP-range/VPC options). Note the
`mongodb+srv://` URI and verify storage encryption at rest in the Atlas
console.

**2. Import the repo.** In Vercel: Add New → Project → import this repo.
Root Directory: repository root. Framework Preset: Next.js. Build
Command is pinned by `vercel.json` to `npm run build` — do not override
it in the dashboard, or the API bundle step is skipped and `/api/*`
breaks. Output Directory: framework default.
`vercel.json` ships the pdf.js font assets with the API function
(without them, extraction fails closed by design) and routes `/api/*`
to it; no extra rewrites or config needed.

**3. Environment variables.** Project → Settings → Environment Variables,
scoped to **Production**, using `.env.prod` (repo root, placeholder-only
checklist) for the exact names: `NODE_ENV=production`,
`STORAGE_BACKEND=mongodb`, `MONGODB_URI`, `MONGODB_DB`,
`PILOT_ACCESS_TOKEN` (generate with `openssl rand -hex 32`),
`FRONTEND_ORIGIN` (this project's own public `https://…` URL),
`INFERENCE_PROVIDER=baseten`, `BASETEN_API_KEY`, `BASETEN_MODEL_ID`,
`BASETEN_STRUCTURED_OUTPUTS=false` (unless the model supports
`json_schema`), `BASETEN_BASE_URL`/`BASETEN_TIMEOUT_MS`/
`BASETEN_MAX_RETRIES` as needed, `MAX_UPLOAD_BYTES=4194304`,
`MAX_PDF_PAGES`, `NEXT_PUBLIC_MAX_UPLOAD_MB=4`,
`NEXT_PUBLIC_MAX_PDF_PAGES`. Leave `NEXT_PUBLIC_API_BASE_URL` **unset**
(same-origin API). Never put secrets in `NEXT_PUBLIC_*` names. Redeploy
after saving so the values take effect.

**4. Public URL + auth.** Note the project's public `https://…` URL and
use it as `FRONTEND_ORIGIN`. Every API route except the public
`/api/health` check requires the shared `PILOT_ACCESS_TOKEN` Bearer token;
the browser prompts for it (stored in
`sessionStorage` for that tab only). There is no per-user auth: treat the
deployment as a controlled pilot (see `docs/security.md`).

**Env files (do not confuse them).** `.env` holds local dev values
(gitignored, never commit). `.env.example` documents local defaults
(committed). `.env.prod` is a placeholder-only production name checklist
(gitignored — it must never hold values). Real production values live
**only** in the Vercel dashboard, never in the repo.

**Known serverless limits (read before piloting).** Vercel request bodies
cap near 4.5 MB — hence `MAX_UPLOAD_BYTES=4194304`; the 20 MB local
default would fail at the platform outside the API error contract. The
serverless filesystem is ephemeral — `STORAGE_BACKEND` must be `mongodb`
in production or uploads vanish between invocations. Upload analysis is
synchronous (one Baseten call per ~6000-char section, sequential, 60 s
timeout with retries each), so multi-section documents can exceed the
function duration cap (60 s on Hobby; a mid-run kill leaves the document
stuck in `queued`/`processing` with re-upload as the only retry — see
`docs/security.md` T19 for the background-worker alternative). Pilot to
small documents; the smallest adjustment when duration bites is raising
`maxDuration` for `api/index.js` (paid plans) and then a worker/queue.
Add platform rate limits on the upload/seed endpoints (the app has none;
each upload triggers paid inference calls behind one shared token).

**Post-deploy test checklist (production URL, synthetic PDF only —
never a real deal document):**

```bash
APP=https://your-project.vercel.app
TOKEN=…   # PILOT_ACCESS_TOKEN, never commit it
curl -s "$APP/api/health"                       # {"ok":true} — routing works
curl -s -o /dev/null -w "unauth list: %{http_code}\n" $APP/api/documents   # 401
curl -s "$APP/" | head -c 200                   # UI HTML, not an API error
node scripts/make-synthetic-pdf.mjs /tmp/synthetic-test.pdf
ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/synthetic-test.pdf;type=application/pdf" \
  $APP/api/documents | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).document.id))")
curl -s -o /dev/null -w "detail: %{http_code}\n" -H "Authorization: Bearer $TOKEN" $APP/api/documents/$ID
FID=$(curl -s -H "Authorization: Bearer $TOKEN" $APP/api/documents/$ID | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log((JSON.parse(s).findings[0]||{}).id))")
curl -s -o /dev/null -w "review: %{http_code}\n" -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"confirmed"}' $APP/api/documents/$ID/findings/$FID
curl -s -o /dev/null -w "download: %{http_code}\n" -H "Authorization: Bearer $TOKEN" $APP/api/documents/$ID/file
curl -s -o /dev/null -w "delete: %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" $APP/api/documents/$ID
curl -s -o /dev/null -w "seed blocked: %{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" $APP/api/demo/seed  # 403
```

## Security and limitations (read before any live deal)

- **Controlled pilot only — not suitable for general production or live deals.**
  Every API route requires the shared `PILOT_ACCESS_TOKEN` bearer credential in
  production, but there is no per-user authentication or authorization, no
  encryption at rest, no rate limiting, and no retention policy (delete is
  immediate full erasure with no audit trail). See `docs/security.md` for the
  threat model and pilot prerequisites. Review events are recorded in MongoDB
  but not yet surfaced.
- Uploads are validated server-side (extension, PDF magic bytes, size cap).
  Local-backend files live outside `public/` under generated IDs; MongoDB
  originals live as BSON Binary. Client filenames are metadata only.
- Baseten credentials live exclusively in server-side env and are sent only as
  an `Authorization` header. Logs never include API keys, contract text, or
  finding evidence — only IDs, sizes, counts, latency, and outcomes. Note that
  `baseten` mode sends document text to the Baseten API (zero-retention on
  synchronous Model API requests per Baseten's docs — confirm current policy
  before any sensitive use).
- Text-based PDFs only. Scanned PDFs extract little or no text and are reported
  as `needs_ocr`, never as clean.
- Delete a document (dashboard → document → Delete, or `DELETE /api/documents/[id]`)
  to remove its upload, extracted text, findings, and review events.
- Do not upload confidential live-deal documents to this build.
