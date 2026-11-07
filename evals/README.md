# Evaluation harness

Reproducible measurement of whether the configured model identifies contract
risks with verifiable evidence. The harness runs the **exact production
pipeline** (`analyzeAndPersist`: inference → Zod validation → evidence
verification → persistence) over synthetic fixtures — there is no separate,
weaker eval path.

## Commands

```bash
npm run eval -- --mode mock                              # deterministic, offline
npm run eval -- --mode live --dataset evals/fixtures --confirm-live
```

- `--mode mock`: deterministic `MockInferenceProvider`, no network or credentials.
- `--mode live`: real `BasetenProvider` from `BASETEN_API_KEY` / `BASETEN_MODEL_ID`
  (+ optional `BASETEN_BASE_URL`, `BASETEN_TIMEOUT_MS`, `BASETEN_MAX_RETRIES`,
  `BASETEN_STRUCTURED_OUTPUTS`). Requires `--confirm-live`; without it the CLI
  refuses to run. Auth/permission/model errors fail fast with no retry.
- `--only <a,b>`: run a subset; others are reported as skipped.
- `--concurrency <n>`: 1–8 parallel fixtures (defaults: mock 1, live 2).
- `--out <dir>`: report directory (default `evals/reports/`, gitignored).

Exit codes: 0 = run completed and reports written (even with failed fixtures);
2 = usage/config/dataset error; 1 = harness crash.

## Dataset (`evals/fixtures/`, version in `version.json`)

30 hand-authored fictional fixtures: 10 positive, 10 negative, 10 challenging.
All parties, people, and amounts are invented. Each fixture carries ground truth
(expected categories, verbatim evidence passages with page numbers, expected
severity, rationale) that is never shown to the model. Challenging fixtures
include negation, superseded-context, illusory-cap, missing-exhibit, vague
trigger, and high-but-stated-cap cases; the genuinely uncertain ones are marked
`ambiguous: true`.

## Methodology

Methodology `2.0.0` (see [Versioning](#versioning)). All rates report
`matched/total` counts alongside the rate; any metric with a zero denominator
is reported as `null` ("n/a"), never as 100% or 0%.

- **Scored population**: completed, non-ambiguous fixtures only. Partial/failed
  runs are counted and reported but never scored — and never counted as clean.
- **Detection**: multi-label, category-set based. A category is a true positive
  when expected and detected (via ≥1 verified finding), false positive when
  detected but not expected, false negative when expected but not detected.
  Duplicate verified findings are collapsed before scoring and counted separately.
- **Evidence match, legacy containment** (unchanged since methodology 1.0.0): an
  expected passage matches when it is contained verbatim (whitespace-normalized,
  case-insensitive) in a verified finding's evidence of the same category, or
  vice versa. Limitations: over-long quotes are not penalized, and one predicted
  finding may satisfy multiple expected slots.
- **Evidence match, exact**: predicted evidence equals the ground-truth quote
  byte-for-byte, with no normalization at all.
- **Evidence match, normalized exact**: equality after conservative normalization
  only — trim outer whitespace and collapse each run of whitespace to a single
  space. Case-sensitive; no words are removed, added, or altered, so wording
  differences and negations never match.
- **Slot assignment (exact and normalized metrics)**: expected evidence slots are
  matched greedily in fixture order against deduped same-category findings in
  pipeline order. Each predicted finding is consumed by at most one slot, so one
  prediction can never satisfy two distinct ground-truth findings. Exact and
  normalized metrics run independent assignments. Findings or quotes that are
  missing or empty after normalization never match. Duplicate predictions are
  removed before assignment and counted separately.
- **Page check, legacy overlap** (unchanged since 1.0.0): passes when the
  finding's cited page range covers at least one expected page. Evaluated on
  legacy-containment matched slots.
- **Page check, strict**: the predicted range must equal the expected span
  exactly — `pageStart` equals the smallest expected page AND `pageEnd` equals
  the largest expected page. For single-page ground truth this means the range
  is exactly that page; for multi-page ground truth (e.g. pages `[1, 2]`) the
  range must be exactly `1–2`, no narrower and no wider. Evaluated only on
  normalized-exact matched slots. Missing or null page values never match.
- **Severity agreement**: ranks low < medium < high < critical agree when they
  differ by at most 1 (documented tolerance, recorded in each report).
  Evaluated on legacy-containment matched slots (unchanged since 1.0.0).
- **Unsupported candidates**: model outputs rejected by schema validation or
  evidence verification. Never counted as hits; reported via the verification
  rejection rate and per-fixture counts.
- **Ambiguous fixtures**: executed normally but excluded from aggregates and
  reported separately with reference labels and rationale, so reasonable
  uncertainty is not penalized.
- **Latency**: per-fixture milliseconds; p95 requires ≥10 observations, else null.
- **Cost**: always reported as `unavailable` (no pricing data). Token usage is
  recorded only when the API returns it.

## Versioning

- Dataset `evals/fixtures` stays at version `1.0.0`; ground truth is frozen.
- Reports carry `methodologyVersion`: `1.0.0` reports have legacy metrics only
  (containment evidence, overlap pages); `2.0.0` reports add the strict metrics
  without changing any legacy field. Legacy fields are directly comparable
  across methodology versions; strict fields exist only in `2.0.0`+ reports.
- The run id hashes dataset version, executed fixtures, mode, model, **and**
  methodology version, so v1 and v2 reports for the same run never collide.
  Old reports remain readable: unknown fields are ignored and
  `methodologyVersion` defaults to `1.0.0` when absent.

Reports (`<runId>.json` + `<runId>.md`) contain aggregates, per-fixture rows,
and ambiguous outcomes — never full contract text or credentials.

Synthetic-fixture performance does **not** predict real-world legal accuracy.
