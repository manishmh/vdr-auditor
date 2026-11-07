# Security and pilot readiness

Date: 2026-11-01, updated for the Phase 5 Express + MongoDB architecture.
Scope: M&A Due Diligence Data Room Auditor as built. This document records
the threat model, what is implemented, what is still missing, and the
prerequisites for a controlled pilot.

## Threat model

Assumptions: the pilot is single-tenant (one trusted deal team), served over
platform TLS, with `NODE_ENV=production`, `STORAGE_BACKEND=mongodb`
(MongoDB Atlas), and a configured `PILOT_ACCESS_TOKEN`. Attackers:
unauthenticated network actors, curious authenticated pilot members,
malicious or malformed PDFs, and misconfiguration by operators.

| # | Threat | Severity | Status |
|---|--------|----------|--------|
| T1 | Unauthenticated read/download/delete of any document via the API | Critical | Mitigated by the pilot gate (shared token); per-user isolation still missing |
| T2 | Cross-document finding updates (`PATCH /documents/A/findings/<of-B>`) | High | Fixed: both stores return document-scoped 404 |
| T3 | Memory exhaustion by uploading a huge body (size checked after buffering) | High | Fixed: Content-Length 413 pre-check + multer `fileSize` cap during parse |
| T4 | Degraded extraction presented as success (missing standard-font assets) | High | Fixed: fail closed with `missing_assets` → document `failed` |
| T5 | `STORAGE_DIR` under `public/` serving uploads as static files | High | Fixed: refused at config load |
| T6 | API key + document text over plaintext HTTP to inference | High | Fixed: `https:` required for `BASETEN_BASE_URL` with provider=baseten |
| T7 | Unauthenticated demo seeding polluting the pilot store | Medium | Fixed: pilot gate + disabled when `NODE_ENV=production` |
| T8 | Deal filenames leaking through retry logs | Medium | Fixed: provider label is the document id only |
| T9 | Clickjacking / MIME sniffing of the review UI and API | Medium | Mitigated: baseline security headers (no CSP yet) |
| T10 | No encryption at rest (local JSON, MongoDB BSON) | High | NOT fixed: needs Atlas storage encryption, verified — see below |
| T11 | No per-user identity, authorization, or audit actor | High | NOT fixed: needs SSO/OIDC + user-scoped stores (see below) |
| T12 | No rate limiting (upload/seed loops burn inference budget) | Medium | NOT fixed: needs platform rate limits |
| T13 | Prompt injection via contract text ("approve this contract") | Medium | Mitigated by design: untrusted-data framing + Zod + evidence verification |
| T14 | Malformed/oversized PDFs crashing extraction | Low | Mitigated: typed `PdfExtractionError` → `failed`, never clean |
| T15 | XSS via model-generated finding text | Low | Mitigated: React escaping, no `dangerouslySetInnerHTML`, no model-driven URLs |
| T16 | MongoDB operator injection via ids/filters (`{"$gt": ""}`) | Medium | Mitigated: UUID assertion on every id before any query; no raw query passthrough |
| T17 | Cross-origin API abuse from arbitrary sites | Medium | Mitigated: CORS reflects exactly one validated `FRONTEND_ORIGIN`; no credentials |
| T18 | Connection storms / leaked clients under serverless concurrency | Medium | Mitigated: one cached `MongoClient` per instance, shared pool, lazy connect |
| T19 | Vercel payload/duration limits breaking uploads or long inference | Medium | NOT auto-handled: capped + documented worker alternative (see below) |
| T20 | Stale Postgres config (`DATABASE_URL`) silently ignored after migration | Low | Fixed: explicit startup error pointing at `MONGODB_URI` |

## Implemented controls

- Pilot access gate (`backend/src/middleware/pilot-auth.ts`): `Authorization:
  Bearer` checked with `crypto.timingSafeEqual` on every Express route when
  `PILOT_ACCESS_TOKEN` is set (≥32 chars, header only, never logged).
  `getConfig()` refuses to boot production without it.
- Upload pre-check (`isDeclaredBodyTooLarge`): declared bodies over
  `MAX_UPLOAD_BYTES` + 1 MiB multipart slack get 413 before buffering; multer
  enforces the same cap during parse. Post-parse checks (size, `.pdf`
  extension, `%PDF` magic bytes) unchanged.
- Fail-closed extraction: unresolvable or missing `standard_fonts` throws
  `PdfExtractionError("missing_assets")`; the pipeline marks the document
  `failed` with an explicit message. No silent degradation path remains.
- Document scoping: UUID id validation on every document route; both stores
  scope finding reads/updates to the URL document (cross-document → 404).
  Mongo queries never interpolate raw user input as operators.
- Deletion is total erasure: local store removes the whole document
  directory; MongoDB deletes the document plus its findings and review
  events (original bytes and pages live on the document). No tombstone is
  kept — see the retention trade-off below.
- Secrets handling: `BASETEN_*`, `MONGODB_URI`, and `PILOT_ACCESS_TOKEN`
  are server-only (the only `NEXT_PUBLIC_` variable is the API base URL),
  and never logged; logs carry ids, counts, and outcomes only.
- Config validation fails fast on: missing Baseten credentials, non-HTTPS
  inference URL, non-mongodb `MONGODB_URI`, missing `MONGODB_URI` for the
  mongodb backend, stale `DATABASE_URL`, `STORAGE_DIR` under `public/`,
  missing pilot token or `FRONTEND_ORIGIN` in production.
- Baseline headers: `nosniff`, strict referrer policy, `DENY` framing,
  `same-origin` opener policy, locked-down permissions policy (web);
  `nosniff` plus `private, no-store` on auth failures and downloads (API).
- Central Express error handling with the unchanged `{ error, reason? }`
  contract; unexpected failures return generic messages.
- Persistence failures are contained: any store error after document
  creation becomes an explicit `failed` record with a generic,
  infrastructure-free detail when the store can still write; only a fully
  dead store surfaces as a 500, never as a clean or stuck result.

## Still missing (do not pilot without accepting these)

1. **Per-user authentication and authorization.** The pilot token is one
   shared credential: any holder can read, download, delete, and re-review
   everything, and review events record no actor. Recommended: Auth.js with
   the team's OIDC provider, a `User` model, document ownership/membership,
   and `actor` on review events. A home-grown password system must not be
   substituted.
2. **Encryption at rest.** Originals, pages, and findings are plaintext
   BSON/JSON. Pilot mitigation: MongoDB Atlas with storage encryption at
   rest; verify in the Atlas console, do not assume. No claim of
   application-level encryption is made.
3. **Rate limiting and upload abuse controls.** Add platform rate limits on
   `POST /api/documents` and short-lived upload quotas before exposing the
   pilot beyond the trusted team.
4. **Retention policy.** Delete means immediate full erasure (good for
   confidentiality; there is no deletion audit trail and no legal-hold
   mechanism). Decide the pilot retention schedule explicitly.
5. **Content Security Policy.** Headers cover framing/sniffing, but no CSP
   is set yet; add a strict CSP before any wider rollout.
6. **Transport to browsers** is the platform's job: serve the pilot only
   behind TLS (HSTS at the edge) and never over plain HTTP.
7. **Long-running work has no worker.** Multi-section inference and large
   PDFs can exceed Vercel function duration/memory caps, and request
   bodies are capped near 4.5 MB. Pilot rule: keep `MAX_UPLOAD_BYTES` at
   ~4 MB on Vercel and piloting to small documents; anything larger needs
   a long-running API host or an async job worker (design future work, not
   implemented here). Do not raise the cap on Vercel and assume it works.

## Pilot deployment prerequisites

Two Vercel projects sharing this repo (see README for the setup):

- **api**: Framework Other, entry `api/index.ts`; env `NODE_ENV=production`,
  `STORAGE_BACKEND=mongodb`, `MONGODB_URI` (Atlas `mongodb+srv://`, TLS),
  `MONGODB_DB`, `PILOT_ACCESS_TOKEN` (`openssl rand -hex 32`, rotate by
  redeploying), `FRONTEND_ORIGIN`, `INFERENCE_PROVIDER=baseten`,
  `BASETEN_API_KEY`, `BASETEN_MODEL_ID`, `BASETEN_STRUCTURED_OUTPUTS=false`
  (Muse Spark Open), `MAX_UPLOAD_BYTES` ≤ ~4 MB, `MAX_PDF_PAGES`.
- **web**: Framework Next.js; env `NEXT_PUBLIC_API_BASE_URL` only.
- Atlas storage encryption verified; TLS + HSTS at the edge; platform
  rate limits on upload/seed endpoints.
- Confirm `GET /api/documents` without a token returns 401 and the UI
  shows the pilot-token prompt; run the deployment smoke checklist in
  the README (upload → review → download → delete).
- Brief the team: shared token (no per-user accountability), delete is
  permanent, demo seeding is disabled in production.
