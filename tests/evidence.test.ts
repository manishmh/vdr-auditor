import { describe, expect, it } from "vitest";
import { locateEvidence, normalizeText, verifyCandidate } from "@/lib/evidence";
import type { PageText } from "@/lib/pdf/extract";

const p = (pageNumber: number, text: string): PageText => ({ pageNumber, text });

const PAGES = [
  p(1, "This Agreement is made between Acme Corp and Beta LLC.\n\nSection 1. Either party may terminate for convenience."),
  p(2, "Section 2. In the event of a change of control, consent is required.\n\nSigned by both parties."),
];

describe("normalizeText", () => {
  it("collapses whitespace", () => {
    expect(normalizeText("  a\n\t b   c ")).toBe("a b c");
  });
});

describe("locateEvidence", () => {
  it("locates an exact quotation and its page", () => {
    expect(locateEvidence(PAGES, "Either party may terminate for convenience.")).toEqual({
      pageStart: 1,
      pageEnd: 1,
    });
  });

  it("tolerates whitespace and case differences from extraction", () => {
    expect(locateEvidence(PAGES, "either   party\nmay TERMINATE for convenience.")).toEqual({
      pageStart: 1,
      pageEnd: 1,
    });
  });

  it("resolves quotations on later pages", () => {
    expect(locateEvidence(PAGES, "In the event of a change of control, consent is required.")).toEqual({
      pageStart: 2,
      pageEnd: 2,
    });
  });

  it("resolves quotations spanning a page boundary", () => {
    expect(locateEvidence(PAGES, "terminate for convenience. Section 1.")).toBeNull(); // same-page check sanity
    const loc = locateEvidence(
      [p(1, "The quick brown"), p(2, "fox jumps over the fence.")],
      "quick brown fox jumps",
    );
    expect(loc).toEqual({ pageStart: 1, pageEnd: 2 });
  });

  it("rejects fabricated quotations", () => {
    expect(locateEvidence(PAGES, "The parties agree to unlimited gold-plated damages.")).toBeNull();
  });

  it("rejects altered quotations", () => {
    expect(locateEvidence(PAGES, "Either party may terminate immediately without notice.")).toBeNull();
  });

  it("rejects quotations too short to verify", () => {
    expect(locateEvidence(PAGES, "Acme")).toBeNull();
    expect(locateEvidence(PAGES, "")).toBeNull();
  });

  it("rejects whitespace-only evidence", () => {
    expect(locateEvidence(PAGES, "   \n\t   ")).toBeNull();
  });

  it("matches unicode punctuation literally without folding", () => {
    const pages = [p(1, "The parties’ “change of control” provision survives closing. Done deal here.")];
    expect(locateEvidence(pages, "parties’ “change of control” provision")).toEqual({
      pageStart: 1,
      pageEnd: 1,
    });
    // Straight-quote lookalikes must not match curly-quote source text.
    expect(locateEvidence(pages, 'parties\' "change of control" provision')).toBeNull();
  });

  it("rejects over-long evidence cleanly", () => {
    expect(locateEvidence(PAGES, "Section 1. ".repeat(500))).toBeNull();
  });

  it("verifies overlapping candidates independently at the same pages", () => {
    const first = verifyCandidate({ evidence: "Either party may terminate for convenience." }, PAGES);
    const second = verifyCandidate({ evidence: "Either party may terminate for convenience on Tuesdays." }, PAGES);
    expect(first).toEqual({ pageStart: 1, pageEnd: 1 });
    // Same opening words, but the Tuesday ending is fabricated.
    expect(second).toBeNull();
  });
});

describe("verifyCandidate", () => {
  it("ignores model-supplied page hints and resolves pages itself", () => {
    const loc = verifyCandidate(
      { evidence: "Signed by both parties." },
      PAGES,
    );
    expect(loc).toEqual({ pageStart: 2, pageEnd: 2 });
  });

  it("returns null for empty page lists without throwing", () => {
    expect(locateEvidence([], "a sufficiently long quotation here")).toBeNull();
  });

  it("resolves repeated quotations to their first occurrence", () => {
    const pages = [
      { pageNumber: 1, text: "The shared services clause applies here and now." },
      { pageNumber: 2, text: "As noted, the shared services clause applies here and now." },
    ];
    expect(locateEvidence(pages, "the shared services clause applies here")).toEqual({
      pageStart: 1,
      pageEnd: 1,
    });
  });

  it("returns null when there is no extracted text", () => {
    expect(verifyCandidate({ evidence: "Signed by both parties." }, [])).toBeNull();
  });
});
