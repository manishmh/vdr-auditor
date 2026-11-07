# Phase 6 audit — product completeness, workflow integrity, reliability

Date: 2026-11-03. Branch: `migrate/mongodb-express`. Baseline gates before
any Phase 6 change: typecheck ✓, lint ✓ (0 warnings), tests 199/199
(22 files, 0 skipped, real MongoDB), `config:validate` ✓, `next build` ✓,
`build:api` ✓, mock eval ✓ (`eval-bcd35a12f151`, deterministic).

## Verified working (traced end to end)

- Pilot unlock → token prompt on first 401, session-scoped storage, retry.
- Dashboard list with loading/empty/error/retry; per-document status badges
  covering all six backend statuses; delete with confirmation.
- Upload with busy guard (no double-submit), pending spinner, error + retry;
  synchronous pipeline; success notice linking to the review page.
- Review page: metadata, statusDetail, failed/needs_ocr explainer panels,
  findings table with search + category/severity/status filters + clear,
  detail panel (severity, category, status, title, explanation, quoted
  evidence, page ref, action, confidence, model), review-status buttons,
  dirty-guarded note saving, honest zero-findings copy ("not a clean bill
  of health"), demo labeling.
- Download (authed blob, sanitized filename, byte-exact — tested), delete
  (confirm, total erasure incl. findings/events — tested both backends).
- Backend: pilot gate on all routes, timing-safe compare, 413 pre-check +
  parse-time caps, UUID scoping, cross-doc 404s, fail-closed extraction,
  single-origin CORS, central `{ error, reason? }` errors, generic 500s.
- Evidence: verification against extracted text, server-side page
  resolution, min-length + schema bounds, injection-bearing demo doc still
  yields findings (mock-tested), prompt untrusted-data framing (tested).

## Findings

### P0 — none open

No data-loss, auth-bypass, or evidence-fabrication defect found. The
workflow is coherent; gaps below are honest-failure and usability issues.

### P1 — fix this phase

1. **Store failures mid-pipeline leave stuck statuses.** `saveOriginal`,
   `savePages`, `saveFindings`, and status updates throw outside any
   mapping: the upload 500s and the document sits in `queued`/`processing`
   forever with no retry path. Fix: best-effort failed-marking
   (`failSafely`) so any persistence error becomes an explicit `failed`
   record when the store can still write; rethrow only when even that
   fails. Tests with a fault-injecting store.
2. **No UI state for `queued`/`processing`.** A stuck or in-flight document
   shows metadata and a badge but no explanation. Fix: explainer panel
   ("still processing or was interrupted — re-upload to retry").
3. **401s after unlock have no recovery path.** Upload/seed/patch/delete/
   download failures show raw text or alerts; the token prompt only
   appears on initial load. Fix: thread an `onUnauthorized` callback from
   Dashboard/ReviewClient into dropzone/seed/detail-save/delete/download
   so any 401 re-opens the prompt.
4. **Upload caps are hardcoded in the UI.** "20 MB max · 200 pages max" is
   a literal string, and oversized files upload fully before the server
   rejects them. Fix: `NEXT_PUBLIC_MAX_UPLOAD_MB` /
   `NEXT_PUBLIC_MAX_PDF_PAGES` (defaults 20/200) driving the label plus a
   client-side size/type pre-check with a clear message.
5. **MongoDB 16 MB document ceiling vs 20 MB default cap.** Originals ride
   on the document, so large PDFs fail inside `saveOriginal` with a raw
   driver message landing in user-visible `statusDetail`. Fix: sanitize
   persistence-failure details to a generic message, document the ceiling
   (recommend ≤ ~14 MB with the `mongodb` backend, GridFS as future work).

### P2 — fix opportunistically

6. Long unbroken strings (finding titles, evidence quotes, statusDetail)
   can overflow their containers — add `break-words`.
7. Reviewer-note textarea has no client-side `maxLength` (server caps at
   4000 → surprising 400s).
8. Finding-table rows handle Enter but not Space, and carry no button
   role for assistive tech.
9. `locateEvidence` assumes non-empty pages (only caller guards) — add a
   direct guard + test.
10. Header badge still reads "Phase 2 · Demo build" — update to the
    controlled-pilot posture.
11. No explicit behavioral test that prompt-injection document text neither
    suppresses genuine findings nor becomes a finding (demo covers it only
    implicitly).

### Accepted limitations (document, don't fix)

- Processing is synchronous: large/multi-section analyses can exceed
  Vercel function limits; re-upload is the retry path (no job queue —
  not justified at pilot scale).
- No upload idempotency key: retried POSTs create duplicate documents
  (folder `sha256` is recorded but not unique). Frontend disables
  double-submit; document the rest.
- Local-backend concurrent PATCHes to one document are last-writer-wins
  (single-process store); MongoDB is atomic per finding.
- Document list is unpaginated (projections exclude bytes/pages, fine at
  pilot scale).
- `/api/health` is intentionally unauthenticated (`{ok:true}` only).

## Implementation sequence

1. Pipeline `failSafely` + fault-injection tests (P1.1, P1.5-sanitize).
2. Queued/processing explainer panel (P1.2).
3. 401 recovery threading (P1.3).
4. Client upload caps + pre-check (P1.4) + README/docs updates (P1.5-docs).
5. P2 batch: break-words, maxLength, row keys/role, evidence guard,
   header badge, injection behavior tests.
6. Full gates + mock eval + final report.
