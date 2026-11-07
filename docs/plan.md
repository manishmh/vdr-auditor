# Phase 1 Implementation Plan — M&A Due Diligence Data Room Auditor

Date: 2026-11-01. Status: Phase 1 in progress. Source PRD: `ma_due_diligence_data_room_auditor_prd.docx` (kept at repo root).

## Scope (Phase 1 only) — complete 2026-11-01

- [x] Inspect repo (empty except PRD), scaffold Next.js App Router + TS strict + Tailwind v4.
- [x] Env validation with Zod (`lib/config.ts`).
- [x] PDF upload API with server-side validation (extension, magic bytes, size cap).
- [x] Server-side text extraction with page boundaries (pdfjs-dist), max-page guard.
- [x] Clause-aware section splitting (`lib/text/chunk.ts`).
- [x] Validated finding schema (`lib/findings/schema.ts`) + configurable risk categories (`lib/risks.ts`).
- [x] Inference provider interface + deterministic mock provider (`lib/inference/`).
- [x] Evidence verification: quotations must occur in extracted text; pages resolved server-side; unsupported findings rejected.
- [x] Local file-backed demo store, clearly separated from future production storage (`lib/store/`).
- [x] Dashboard (upload + document list + status), document review page (findings table, filters, finding detail, status changes).
- [x] Demo-data seeding, explicitly labeled as demo.
- [x] Vitest suite: 63 tests across extraction, validation, chunking, evidence, schema, mock provider, prompts, pipeline, store, config, demo.
- [x] Prisma schema drafted as the Phase 2 persistence contract (not wired yet).
- [x] Gates green: `typecheck`, `lint`, `test`, `build`; production-build smoke test passed (seed → upload → review → patch → delete).

## Architecture

```
browser ──► Next.js pages (client components + fetch)
                │
                ▼
         API routes (app/api/*) — Zod validation at every boundary
                │
                ▼
         lib/pipeline.ts — validate → extract → chunk → analyze → verify → persist
                │                                    │
   lib/store (demo JSON files)        lib/inference (mock now, Baseten in Phase 2)
```

Uploads and derived data live under `STORAGE_DIR` (default `.data/`, gitignored),
never under `public/`. Filenames from clients are metadata only; storage paths use
generated UUIDs.

## Assumptions

1. Single-user local review in Phase 1: no auth, no multi-tenancy. Auth/encryption/retention controls are Phase 2/3 work; the app must not be presented as production-ready for live deals.
2. Text-based PDFs only. Scanned/image PDFs yield empty text and are reported as `needs_ocr` (a visible limitation, never silently "clean"). OCR is Phase 3.
3. English-language contracts for the mock provider's keyword rules. The mock is a deterministic stand-in, not a legal detector.
4. Baseten Model APIs (OpenAI-compatible, `https://inference.baseten.co/v1`) is the Phase 2 inference target; verified against official docs on 2026-11-01 (see `docs/baseten.md`). No model is pinned or hardcoded; `BASETEN_MODEL_ID` stays env-configured.
5. Modest document sizes: 20 MB / 200 pages default caps, adjustable via env.
6. The local JSON store is demo-only and single-process; concurrent writes are not handled.

## Phase 2 (complete 2026-11-01)

- Real Baseten Model APIs provider: one structured-output call per section,
  timeouts, bounded retries (429/5xx/network only), refusal/length/malformed
  handling, fatal-fast auth and unknown-model errors, no model substitution.
- Provider contract extended with per-section errors; pipeline marks documents
  `partial` when some sections fail and `failed` (never clean) when none were screened.
- Evidence rules unchanged and enforced for LLM output: Zod validation, quotation
  verification against extracted text, server-side page resolution, confidence
  bounded and rounded, unsupported candidates rejected.
- PostgreSQL + Prisma wired behind `STORAGE_BACKEND` (`prisma/migrations/*`
  committed): documents, status, pages, originals, findings, reviewer decisions,
  notes, and review events. API and UI behavior unchanged.
- Tests: 90 total, including mocked-HTTP provider tests and DB-backed store tests
  (auto-skip without `TEST_DATABASE_URL`). No live credentials needed for unit tests.

## Phase 1: live-failure diagnosis (2026-11-01)

- Run `eval-dbd7fe1002a6` failures were `neg-01` and `neg-02` (correcting the
  earlier summary, which misidentified them): both `finish_reason: length`
  cutoffs after ~57–59s on tiny single-section prompts — runaway generation
  against the documented 4096-token default cap, not timeouts or parse errors.
  Same-prompt non-determinism observed (`neg-01` completed in an earlier probe).
- No cap, prompt, or retry change: evidence shows a generous cap with runaway
  outputs, and the failure handling (explicit `failed`, never clean) was already
  correct. Targeted fix instead: failure metadata (error `code`, received chars,
  failed-section token usage) now flows provider → pipeline → eval reports, plus
  a report section listing failed/partial fixture errors.
- Regression tests (mocked): cutoff diagnostics without retry, usage from failed
  responses, all-truncated → `failed`, mixed → `partial`, report error surfacing.
  Dataset v1.0.0 untouched (fingerprint-verified).

## Phase 2.5: evaluation harness (2026-11-01)

- 30 hand-authored fictional fixtures (`evals/fixtures/`, v1.0.0): 10 positive,
  10 negative, 10 challenging (7 ambiguous, reported separately, never scored).
- `npm run eval -- --mode mock|live`: runs the exact production pipeline per
  fixture in a scratch store; live mode needs `--confirm-live` + Baseten env,
  bounded concurrency, no retry on auth/model errors, no secrets or text logged.
- Reports (JSON + Markdown, deterministic run ids) in gitignored `evals/reports/`:
  per-category/micro/macro P-R-F1, FP-per-negative, evidence match, page accuracy,
  severity agreement (tolerance 1), rejection rate, counts, latency median/p95,
  token usage when reported, cost always unavailable.
- Mock results: micro P/R/F1 0.875/1.000/0.933; 2 scored FPs (negation + recital
  traps, by design); evidence/pages/severity 14/14.
- Live results (muse-spark-open-1026): micro 1.000/0.929/0.963 over 28 completed
  (2 failed on length cutoff, excluded and counted); 0 FPs; evidence 12/14.
- Synthetic scores do not predict real-world legal accuracy.

## Hackathon model configuration (2026-11-01)

- `BASETEN_MODEL_ID=meta-models/muse-spark-open-1026`, base URL unchanged.
- Muse Spark Open does not enforce `json_schema`: provider omits `response_format`
  when `BASETEN_STRUCTURED_OUTPUTS=false`, requests the JSON shape in the prompt,
  and parses `content` defensively (fences/prose tolerated, `reasoning_content`
  ignored). Zod + evidence verification stay authoritative.
- Refusals, truncation, malformed JSON, and API errors become section errors
  (`partial`/`failed`, never clean); 401/403 still fail fast without retries.

## Phase 5: Express + MongoDB migration (2026-11-02, branch `migrate/mongodb-express`)

- REST API moved from Next.js Route Handlers to Express (`backend/src`,
  Vercel entry `api/index.ts`); Next.js is UI only. Same paths, methods,
  shapes, and status codes; frontend uses `NEXT_PUBLIC_API_BASE_URL`.
- PostgreSQL/Prisma replaced by MongoDB (official driver): `documents`,
  `findings`, `reviewEvents` collections, UUID `_id`s, indexes on
  `findings(documentId)`, `reviewEvents(documentId)`,
  `documents(createdAt)`. `LocalFileStore` kept for the eval harness and
  offline dev. No production data existed, so no record migration ran.
- Phase 4 security contract preserved (see `docs/security.md`): pilot
  gate, document scoping, upload limits, fail-closed extraction,
  no-secret logging. New: single-origin CORS, per-endpoint notes on
  Vercel payload/duration limits. Full plan: `docs/migration-plan.md`.

## Phase 6: product completeness and reliability (2026-11-03)

- Audit in `docs/phase-6-audit.md` (no P0 findings). Pipeline persistence
  failures now yield explicit `failed` records with sanitized details
  instead of stuck `processing` rows; review page explains
  `queued`/`processing` states with a re-check path.
- Any API 401 re-opens the pilot-token prompt (upload, seed, review,
  delete, download). Upload caps are configurable public mirrors with a
  client-side pre-check; server still re-validates everything.
- Small hardening batch: word-breaking on long text, note `maxLength`,
  keyboard/role support on finding rows, empty-pages evidence guard,
  injection behavior tests, header badge posture. No architecture change.

## Explicitly deferred

- Phase 3: reviewer workflows hardening (assign/comments), exports (CSV/XLSX/PDF), OCR, auth, encryption, audit UI, retention jobs, object storage for originals, finding dedup across overlapping sections.
- ZIP/VDR-archive ingestion, cross-document checks, multi-deal analytics.

## Verification

`npm run typecheck`, `npm run lint`, `npm run test` (vitest, needs
`TEST_MONGODB_URI` for repository tests), `npm run config:validate`,
`npm run build`, `npm run build:api`.
Manual smoke: `npm run dev` (backend + frontend) → upload a PDF → findings
render with evidence and page refs.
