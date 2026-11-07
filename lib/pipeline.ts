import type { AppConfig } from "./config";
import { verifyCandidate } from "./evidence";
import { CandidateFindingSchema, type StoredFinding } from "./findings/schema";
import type { InferenceProvider, SectionError } from "./inference/types";
import { countSignificantChars, extractPdfText, PdfExtractionError, type PageText } from "./pdf/extract";
import { validateUpload } from "./pdf/validate";
import { RISK_CATEGORY_IDS } from "./risks";
import type { DocumentRecord, DocumentStore } from "./store/types";
import { splitIntoSections } from "./text/chunk";

/** Below this many non-whitespace chars, the PDF is treated as scanned/unextractable. */
export const MIN_SIGNIFICANT_CHARS = 50;

/**
 * Status detail recorded when persistence itself fails. Deliberately generic:
 * driver messages may name infrastructure and must not reach user-visible
 * status. The document is honest `failed`, never clean and never stuck.
 */
export const PERSISTENCE_FAILURE_DETAIL =
  "A storage error occurred while saving results; the document was not fully analyzed.";

export interface ProcessOutcome {
  document: DocumentRecord;
  findings: StoredFinding[];
  droppedInvalid: number;
  droppedUnverified: number;
  sectionErrors: SectionError[];
  /** Token usage passthrough from the provider, when reported. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface RawUpload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * Full upload flow: validate → persist → extract → chunk → analyze →
 * validate → verify evidence → persist. Never throws for expected
 * document problems; those become `failed`/`needs_ocr` statuses.
 * Logs metadata only — never document text.
 */
export async function processUpload(
  store: DocumentStore,
  provider: InferenceProvider,
  upload: RawUpload,
  config: AppConfig,
): Promise<ProcessOutcome> {
  const validated = await validateUpload(
    { filename: upload.filename, mimeType: upload.mimeType, size: upload.bytes.length, bytes: upload.bytes },
    config.MAX_UPLOAD_BYTES,
  );
  const document = await store.createDocument({
    filename: validated.filename,
    mimeType: validated.mimeType,
    sizeBytes: validated.size,
    sha256: validated.sha256,
    source: "upload",
  });
  return withFailureRecord(store, document, async () => {
    await store.saveOriginal(document.id, upload.bytes);
    await store.updateDocument(document.id, { status: "processing" });
    console.info(`[pipeline] processing upload id=${document.id} bytes=${validated.size}`);

    let extracted;
    try {
      extracted = await extractPdfText(upload.bytes, config.MAX_PDF_PAGES);
    } catch (err) {
      const detail =
        err instanceof PdfExtractionError ? err.message : "Unexpected error while reading the PDF.";
      const failed = await store.updateDocument(document.id, { status: "failed", statusDetail: detail });
      console.info(`[pipeline] extraction failed id=${document.id} reason=${detail}`);
      return { document: failed ?? document, findings: [], droppedInvalid: 0, droppedUnverified: 0, sectionErrors: [] };
    }

    await store.savePages(document.id, extracted.pages);
    await store.updateDocument(document.id, { pageCount: extracted.pageCount });

    if (countSignificantChars(extracted.pages) < MIN_SIGNIFICANT_CHARS) {
      const detail =
        "Almost no text could be extracted — this looks like a scanned or image-based PDF. " +
        "OCR is not available in this build, so the document was not analyzed.";
      const record = await store.updateDocument(document.id, { status: "needs_ocr", statusDetail: detail });
      console.info(`[pipeline] needs_ocr id=${document.id} pages=${extracted.pageCount}`);
      return { document: record ?? document, findings: [], droppedInvalid: 0, droppedUnverified: 0, sectionErrors: [] };
    }

    return analyzeAndPersist(store, provider, document, extracted.pages, extracted.pageCount);
  });
}

/**
 * Run a post-create pipeline phase, converting any persistence failure into
 * an explicit `failed` record when the store can still write. Only when even
 * the failure record cannot be written does the original error propagate
 * (honest 500: the operation failed, nothing is misreported as analyzed).
 */
async function withFailureRecord(
  store: DocumentStore,
  document: DocumentRecord,
  task: () => Promise<ProcessOutcome>,
): Promise<ProcessOutcome> {
  try {
    return await task();
  } catch (err) {
    let failed: DocumentRecord | null = null;
    try {
      failed = await store.updateDocument(document.id, {
        status: "failed",
        statusDetail: PERSISTENCE_FAILURE_DETAIL,
      });
    } catch {
      failed = null;
    }
    if (!failed) throw err;
    console.info(`[pipeline] persistence failed id=${document.id}`);
    return { document: failed, findings: [], droppedInvalid: 0, droppedUnverified: 0, sectionErrors: [] };
  }
}

/** Shared analysis path for uploads and seeded demo pages. */
export async function analyzeAndPersist(
  store: DocumentStore,
  provider: InferenceProvider,
  document: DocumentRecord,
  pages: PageText[],
  pageCount: number,
): Promise<ProcessOutcome> {
  return withFailureRecord(store, document, async () => analyzeCreated(store, provider, document, pages, pageCount));
}

async function analyzeCreated(
  store: DocumentStore,
  provider: InferenceProvider,
  document: DocumentRecord,
  pages: PageText[],
  pageCount: number,
): Promise<ProcessOutcome> {
  const sections = splitIntoSections(pages);
  let result;
  try {
    result = await provider.analyze({
      sections,
      categories: [...RISK_CATEGORY_IDS],
      // Document id only: filenames may name the deal and must not reach logs.
      documentLabel: document.id,
    });
  } catch (err) {
    const detail = `Analysis failed: ${err instanceof Error ? err.message : "unknown provider error"}`;
    const failed = await store.updateDocument(document.id, { status: "failed", statusDetail: detail });
    console.info(`[pipeline] provider failed id=${document.id}`);
    return { document: failed ?? document, findings: [], droppedInvalid: 0, droppedUnverified: 0, sectionErrors: [] };
  }
  const { findings: candidates, sectionErrors, usage } = result;

  // Nothing was analyzed at all: failed, never clean and never partial-clean.
  if (sections.length > 0 && sectionErrors.length >= sections.length) {
    const detail =
      `Analysis failed for all ${sections.length} section(s); the document was not screened. ` +
      `First error: ${sectionErrors[0]?.message ?? "unknown error"}`;
    const failed = await store.updateDocument(document.id, { status: "failed", statusDetail: detail });
    console.info(`[pipeline] all sections failed id=${document.id} sections=${sections.length}`);
    return { document: failed ?? document, findings: [], droppedInvalid: 0, droppedUnverified: 0, sectionErrors, usage };
  }

  const findings: StoredFinding[] = [];
  let droppedInvalid = 0;
  let droppedUnverified = 0;
  for (const raw of candidates) {
    const parsed = CandidateFindingSchema.safeParse(raw);
    if (!parsed.success) {
      droppedInvalid++;
      continue;
    }
    const location = verifyCandidate(parsed.data, pages);
    if (!location) {
      droppedUnverified++;
      continue;
    }
    const now = new Date().toISOString();
    findings.push({
      ...parsed.data,
      confidence: normalizeConfidence(parsed.data.confidence),
      id: crypto.randomUUID(),
      documentId: document.id,
      pageStart: location.pageStart,
      pageEnd: location.pageEnd,
      status: "open",
      reviewerNote: null,
      modelId: provider.modelId,
      createdAt: now,
      updatedAt: now,
    });
  }

  await store.saveFindings(document.id, findings);
  const dropped = droppedInvalid + droppedUnverified;
  const incomplete = sectionErrors.length > 0 || dropped > 0;
  const notes: string[] = [];
  if (sectionErrors.length > 0) {
    notes.push(
      `${sectionErrors.length} of ${sections.length} section(s) could not be analyzed (${sectionErrors[0]?.message ?? "unknown error"}).`,
    );
  }
  if (dropped > 0) {
    notes.push(
      `${dropped} candidate(s) dropped (${droppedInvalid} invalid, ${droppedUnverified} with unverified evidence).`,
    );
  }
  const record = await store.updateDocument(document.id, {
    status: incomplete ? "partial" : "completed",
    statusDetail: incomplete ? `${findings.length} finding(s) verified. ${notes.join(" ")}` : null,
    pageCount,
    findingCount: findings.length,
  });
  console.info(
    `[pipeline] done id=${document.id} pages=${pageCount} findings=${findings.length} dropped=${dropped} sectionErrors=${sectionErrors.length}`,
  );
  return { document: record ?? document, findings, droppedInvalid, droppedUnverified, sectionErrors, usage };
}

/**
 * Model confidence is advisory only: schema-bounded (0–1) and rounded for
 * stable storage. Severity and review decisions never derive from it.
 */
function normalizeConfidence(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.round(value * 1000) / 1000;
}
