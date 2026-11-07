import type { CandidateFinding } from "./findings/schema";
import type { PageText } from "./pdf/extract";

/** Minimum normalized evidence length. Shorter quotations are rejected as unverifiable. */
export const MIN_EVIDENCE_CHARS = 10;

/** Collapse whitespace for tolerant matching across extraction artifacts. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface EvidenceLocation {
  pageStart: number;
  pageEnd: number;
}

/**
 * Locate a quotation in the extracted document text. Matching is
 * whitespace-tolerant and case-insensitive; the location may span pages.
 * Returns null when the quotation does not occur (fabricated or altered).
 */
export function locateEvidence(pages: PageText[], evidence: string): EvidenceLocation | null {
  if (pages.length === 0) return null;
  const needle = normalizeText(evidence).toLowerCase();
  if (needle.length < MIN_EVIDENCE_CHARS) return null;

  const normalized = pages.map((p) => normalizeText(p.text).toLowerCase());
  const joined = normalized.join(" ");
  const index = joined.indexOf(needle);
  if (index === -1) return null;

  const offsets: number[] = [];
  let cursor = 0;
  for (const text of normalized) {
    offsets.push(cursor);
    cursor += text.length + 1;
  }
  const pageAt = (pos: number): number => {
    let page = pages[pages.length - 1].pageNumber;
    for (let i = 0; i < offsets.length; i++) {
      if (pos < offsets[i] + normalized[i].length) {
        page = pages[i].pageNumber;
        break;
      }
    }
    return page;
  };
  return { pageStart: pageAt(index), pageEnd: pageAt(index + needle.length - 1) };
}

/**
 * Verify one candidate finding against extracted text. Model-supplied page
 * hints are ignored; pages are resolved here. Returns the location or null
 * when the evidence is unsupported.
 */
export function verifyCandidate(
  candidate: Pick<CandidateFinding, "evidence">,
  pages: PageText[],
): EvidenceLocation | null {
  if (pages.length === 0) return null;
  return locateEvidence(pages, candidate.evidence);
}
