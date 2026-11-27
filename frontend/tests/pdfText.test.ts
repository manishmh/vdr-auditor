import { describe, expect, it } from "vitest";
import {
  findExcerptRanges,
  joinLayerItems,
  joinLayerItemsWithBreaks,
  storedPageToPdfPage,
} from "../lib/pdfText";

describe("storedPageToPdfPage", () => {
  it("adds the offset and clamps into the document", () => {
    expect(storedPageToPdfPage(1, 2, 10)).toBe(3);
    expect(storedPageToPdfPage(9, 2, 10)).toBe(10);
    expect(storedPageToPdfPage(3, undefined, 10)).toBe(3);
    expect(storedPageToPdfPage(3, undefined, null)).toBe(3);
  });

  it("returns null without a cited page and floors at 1", () => {
    expect(storedPageToPdfPage(null, 2, 10)).toBeNull();
    expect(storedPageToPdfPage(0, 0, 10)).toBe(1);
    expect(storedPageToPdfPage(-2, 0, null)).toBe(1);
  });
});

describe("findExcerptRanges", () => {
  it("finds an exact occurrence with original-space bounds", () => {
    const haystack = "The parties agree to the following terms and conditions.";
    const ranges = findExcerptRanges(haystack, "agree to the following terms");
    expect(ranges).toHaveLength(1);
    expect(haystack.slice(ranges[0]?.start, ranges[0]?.end)).toBe(
      "agree to the following terms",
    );
  });

  it("tolerates whitespace and case differences", () => {
    const haystack = "Section 4.\nLiability\tshall   be UNLIMITED for breach.";
    expect(findExcerptRanges(haystack, "liability shall be unlimited for breach")).toHaveLength(1);
    expect(findExcerptRanges(haystack, "  LIABILITY\nSHALL\tBE unlimited  ")).toHaveLength(1);
  });

  it("finds repeated excerpts as separate ranges", () => {
    const haystack = "consent is required here, and consent is required there.";
    const ranges = findExcerptRanges(haystack, "consent is required");
    expect(ranges).toHaveLength(2);
    expect(haystack.slice(ranges[0]?.start, ranges[0]?.end)).toBe("consent is required");
    expect(haystack.slice(ranges[1]?.start, ranges[1]?.end)).toBe("consent is required");
  });

  it("returns no ranges when the excerpt is absent or too short", () => {
    expect(findExcerptRanges("entirely unrelated content here", "missing excerpt text")).toEqual(
      [],
    );
    expect(findExcerptRanges("short match here", "short")).toEqual([]);
    expect(findExcerptRanges("", "anything at all here")).toEqual([]);
  });

  it("matches across text-layer item boundaries", () => {
    const joined = joinLayerItems(["Neither party may ", "assign this agreement ", "without consent."]);
    const ranges = findExcerptRanges(joined.text, "may assign this agreement without");
    expect(ranges).toHaveLength(1);
    const range = ranges[0] as { start: number; end: number };
    // The match spans all three items.
    expect(joined.itemAt[range.start]).toBe(0);
    expect(joined.itemAt[range.end - 1]).toBe(2);
  });

  it("maps every joined char back to its item", () => {
    const joined = joinLayerItems(["ab", "", "cde"]);
    expect(joined.text).toBe("abcde");
    expect(joined.itemAt).toEqual([0, 0, 2, 2, 2]);
  });

  it("separates end-of-line items like extraction does", () => {
    const joined = joinLayerItemsWithBreaks(
      ["FIRST OFFER", "THIS AGREEMENT is dated"],
      [true, false],
    );
    expect(joined.text).toBe("FIRST OFFER\nTHIS AGREEMENT is dated");
    // The synthetic break maps to its preceding item for contiguous ranges.
    expect(joined.itemAt.slice(10, 13)).toEqual([0, 0, 1]);
    const ranges = findExcerptRanges(joined.text, "offer this agreement");
    expect(ranges).toHaveLength(1);
  });

  it("treats missing break flags as direct concatenation", () => {
    const joined = joinLayerItemsWithBreaks(["ab", "cd"], []);
    expect(joined.text).toBe("abcd");
    expect(joined.itemAt).toEqual([0, 0, 1, 1]);
  });
});
