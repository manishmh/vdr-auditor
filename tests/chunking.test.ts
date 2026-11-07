import { describe, expect, it } from "vitest";
import type { PageText } from "@/lib/pdf/extract";
import { splitIntoSections } from "@/lib/text/chunk";

const p = (pageNumber: number, text: string): PageText => ({ pageNumber, text });

describe("splitIntoSections", () => {
  it("keeps a small document in one section with its page range", () => {
    const sections = splitIntoSections([p(1, "First paragraph.\n\nSecond paragraph."), p(2, "Third.")]);
    expect(sections).toHaveLength(1);
    expect(sections[0].pageStart).toBe(1);
    expect(sections[0].pageEnd).toBe(2);
    expect(sections[0].text).toContain("First paragraph.");
  });

  it("splits at paragraph boundaries instead of mid-clause", () => {
    const para = (n: number) => `Clause ${n}: the parties agree to the following terms without exception.`;
    const pages = [p(1, [para(1), para(2), para(3)].join("\n\n"))];
    const sections = splitIntoSections(pages, { maxChars: 120 });
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expect(s.text).toMatch(/Clause \d:/);
      expect(s.text).not.toMatch(/Clause \d: the parties agree to the following terms without excep[^t]/);
    }
  });

  it("starts a new section at clause headings once the current section is substantial", () => {
    const intro = "Intro paragraph with enough words to pass the quarter threshold comfortably. ".repeat(10);
    const sections = splitIntoSections(
      [p(1, `${intro}\n\nSection 2. Payment Terms\n\nPayment is due in thirty days.`)],
      { maxChars: 800 },
    );
    expect(sections).toHaveLength(2);
    expect(sections[1].text).toContain("Section 2. Payment Terms");
    expect(sections[1].text).toContain("Payment is due");
  });

  it("hard-splits an oversized paragraph with overlap on the same page", () => {
    const long = `Start-${"x".repeat(500)}-Middle-${"y".repeat(500)}-End`;
    const sections = splitIntoSections([p(3, long)], { maxChars: 400, hardSplitOverlap: 50 });
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expect(s.text.length).toBeLessThanOrEqual(400);
      expect(s.pageStart).toBe(3);
      expect(s.pageEnd).toBe(3);
    }
    const joined = sections.map((s) => s.text).join("");
    expect(joined).toContain("Start-");
    expect(joined).toContain("-End");
  });

  it("returns no sections for empty input", () => {
    expect(splitIntoSections([])).toEqual([]);
    expect(splitIntoSections([p(1, "   \n  ")])).toEqual([]);
  });
});
