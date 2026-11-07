# Baseten Integration Notes (verified 2026-11-01, re-verified for Phase 2)

Sources: [Inference overview](https://docs.baseten.co/inference/overview),
[Model APIs](https://docs.baseten.co/inference/model-apis/overview.md),
[Structured outputs](https://docs.baseten.co/inference/structured-outputs),
[Chat Completions reference](https://docs.baseten.co/reference/inference-api/chat-completions.md)
(including its OpenAPI error table).
Re-check the live docs and the `/v1/models` catalog before changing models —
slugs and limits move (current doc examples: `moonshotai/Kimi-K3`,
`deepseek-ai/DeepSeek-V4.1-Flash-1017`).

## Decision

Phase 2 will use **Baseten Model APIs** (managed, OpenAI-compatible) rather than a
dedicated deployment: no Truss packaging, no GPU management, and synchronous
requests fall under Baseten's zero data retention policy (inputs/outputs not
stored), which suits confidential deal documents. Dedicated deployments remain an
option if a custom model or data-region pinning is required.

## Verified API facts

- Base URL: `https://inference.baseten.co/v1`
- Auth: `Authorization: Bearer $BASETEN_API_KEY` (server-side only).
- Protocol: OpenAI Chat Completions (`POST /chat/completions`), plus OpenAI
  Responses and Anthropic Messages (beta) alternatives.
- Model selection: `model` field set to the exact **model slug** from the supported-models table (docs example: `zai-org/GLM-5.3`; catalog also covers DeepSeek, Kimi, Muse Spark, and others — confirm current slugs at build time).
- Structured outputs: supported via `response_format: { type: "json_schema", ... }` by all listed language models **except Muse Spark Open** (accepts `json_schema` but does not enforce it). Prefer structured outputs over JSON mode for the finding schema.
- Context/output limits in the docs table can differ from advertised maxima — use the table values when sizing prompts.
- Read results from `choices[0].message` and check `finish_reason`; never trust model-supplied page numbers or quotations without server-side verification.

## Verified error behavior (from the OpenAPI spec + structured-outputs guide)

| Signal | Meaning | Client behavior |
| ------ | ------- | --------------- |
| 400 | Bad request (invalid parameters) | Section error, no retry |
| 401/403 | Invalid or missing API key | Fatal: abort, fail the document |
| 404 | Unknown model slug | Fatal: abort, fail; never substitute another model |
| 429 (+ `Retry-After`, `x-ratelimit-*`) | Rate limit | Bounded retry honoring `Retry-After` |
| 5xx | Server error | Bounded retry with exponential backoff |
| `message.refusal` | Model refused | Section error, no retry |
| `finish_reason: length` | Output cut off | Section error (findings would be incomplete) |
| Non-JSON / schema-invalid content | Model did not follow the schema | Retry within budget, then section error |

Timeouts and network failures retry within the same bounded budget.

## Muse Spark Open (`meta-models/muse-spark-open-1026`, hackathon model)

Verified against the [Model APIs overview](https://docs.baseten.co/inference/model-apis/overview.md)
(supported-models + feature-support tables), the
[reasoning guide](https://docs.baseten.co/inference/model-apis/reasoning), and the
[launch changelog](https://www.baseten.co/resources/changelog/muse-spark-open-and-nemotron-35-super-vl-available-on-baseten/):

- Same endpoint, auth, and Chat Completions request shape (`POST /chat/completions`,
  `Authorization: Bearer`, `model` slug). Supported sampling params include
  `temperature`, `top_p`, `top_k`, `stop`, `presence_penalty`, `frequency_penalty`.
  Do not send `n` (>1 returns 400), `logprobs` (ignored), `seed`, or `reasoning_effort`.
- **No `json_schema` structured outputs** (accepted but not enforced). The provider
  therefore omits `response_format` and requests the exact JSON shape in the prompt
  (`BASETEN_STRUCTURED_OUTPUTS=false`). The Zod schema plus evidence verification
  remain the authoritative validation — unenforced output degrades to section
  errors, never to bad findings.
- **Reasoning is always on** with no control parameter. The final answer arrives in
  `message.content`; drafts arrive in `message.reasoning_content`. The client parses
  only `content` and ignores `reasoning_content` entirely (it may contain
  half-formed quotes). Responses with reasoning but no content are section errors.
- Context window ~1M tokens; `finish_reason: length` is still treated as incomplete.
- `max_tokens` is documented (default 4096, max 262144) and intentionally unset:
  run `eval-dbd7fe1002a6` showed length cutoffs on tiny prompts whose correct
  output is far below the cap, i.e. runaway generation, not a too-small limit.
  Raising the cap would only let runaways run longer. Revisit only with usage
  data showing legitimate outputs near the cap.

## Length-cutoff diagnosis runbook

`finish_reason: length` means the model was still generating when the output cap
hit — never a clean result. Section errors now carry the failure `code`
(`incomplete`), the received content length in chars, and API-reported token
usage, surfaced in document `statusDetail` and eval reports. To diagnose: compare
`completionTokens` against the 4096 default — near-cap values on small prompts
indicate runaway generation (model-side flakiness; temperature 0 does not
guarantee determinism), while near-cap values on finding-dense sections suggest
the cap itself. Retrying cutoffs is deliberately not implemented: identical
prompts usually truncate again, doubling worst-case cost and latency.

To switch back to a structured-outputs model, set `BASETEN_MODEL_ID` to its slug
and `BASETEN_STRUCTURED_OUTPUTS=true` (the default).

## Phase 2 implementation (`lib/inference/baseten.ts`)

- Server-side only; `BASETEN_API_KEY`, `BASETEN_MODEL_ID` from env, never exposed to the client.
- One `POST /chat/completions` per document section, sequential, `temperature: 0`.
- `response_format: { type: "json_schema", json_schema: { name, strict: false, schema } }`
  using the finding schema in `lib/inference/prompts.ts`. `strict: false` keeps
  the optional `confidence` field acceptable across models; every response is
  Zod-validated server-side regardless, so a non-enforcing model degrades to
  section errors, never to bad findings.
- No hardcoded model slug or model-specific endpoint; never substitute another model on failure.
- Per-request timeout (`BASETEN_TIMEOUT_MS`) via `AbortController`; bounded retries
  (`BASETEN_MAX_RETRIES`) on 429/5xx/network/timeout/malformed/invalid-output only.
- Zod-validate every response; the pipeline additionally rejects findings whose
  evidence is absent from extracted text and resolves all pages server-side.
- Document text stays untrusted data: the system prompt instructs the model to
  ignore embedded instructions.
- Logs carry section id, latency, token usage, and finding counts — never contract text or evidence.
