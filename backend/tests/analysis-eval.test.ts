import { describe, expect, it } from "vitest";
import { analyzePages, type ModelCall } from "../src/ai/analysis.js";
import { EVAL_DOCS } from "./eval-fixtures.js";

/**
 * Deterministic rule-based stand-in for the Meta model (same idea as the
 * previous implementation's mock provider): regex clause detection with
 * excerpts quoted from the analyzed text, so the pipeline's own validation
 * and evidence verification do the real work under test.
 */
function mockModelFor(pages: string[]): ModelCall {
  const fullText = pages.join("\n\n");
  return async (messages) => {
    const sectionText = messages[1]?.content ?? "";
    const findings: Array<Record<string, unknown>> = [];
    const push = (category: string, severity: string, title: string, excerpt: string): void => {
      const page = pageContaining(pages, excerpt);
      findings.push({
        category,
        severity,
        title,
        explanation: `Detected ${category.replace(/_/g, " ")} language; reviewer must confirm.`,
        excerpt,
        page,
        counterEvidence: null,
        uncertainty: null,
      });
    };
    const coc = /[^.]*change of control[^.]*\./i.exec(sectionText);
    if (coc !== null && sentenceInFullText(fullText, coc[0])) {
      push("change_of_control", "high", "Possible change-of-control provision", coc[0].trim());
    }
    const uncapped = /[^.]*unlimited[^.]*\./i.exec(sectionText);
    if (uncapped !== null && sentenceInFullText(fullText, uncapped[0])) {
      push("uncapped_liabilities", "high", "Potentially uncapped liability", uncapped[0].trim());
    }
    const blank = /Signature:\s*_{3,}/i.exec(sectionText);
    if (blank !== null) {
      push("missing_signatures", "medium", "Signature block appears blank", blank[0]);
    }
    return JSON.stringify({ findings });
  };
}

function sentenceInFullText(fullText: string, sentence: string): boolean {
  return fullText.replace(/\s+/g, " ").toLowerCase().includes(sentence.replace(/\s+/g, " ").toLowerCase());
}

function pageContaining(pages: string[], excerpt: string): number | null {
  const needle = excerpt.replace(/\s+/g, " ").trim().toLowerCase();
  for (let i = 0; i < pages.length; i += 1) {
    if ((pages[i] ?? "").replace(/\s+/g, " ").toLowerCase().includes(needle)) {
      return i + 1;
    }
  }
  return null;
}

describe("analysis eval set", () => {
  for (const doc of EVAL_DOCS.filter((d) => d.id !== "malformed-model-response")) {
    it(`screens ${doc.id} deterministically`, async () => {
      const outcome = await analyzePages(doc.pages, mockModelFor(doc.pages));
      const categories = [...new Set(outcome.findings.map((f) => f.category))].sort();
      expect(categories).toEqual([...doc.expectedCategories].sort());
      for (const [category, page] of Object.entries(doc.expectedPages)) {
        const finding = outcome.findings.find((f) => f.category === category);
        expect(finding?.page).toBe(page);
      }
      expect(outcome.limited).toBe(false);
      expect(outcome.stats.sectionsFailed).toBe(0);
      expect(outcome.stats.sectionsSkipped).toBe(0);
      expect(outcome.stats.findingsDroppedInvalid).toBe(0);
      expect(outcome.stats.findingsDroppedUnverified).toBe(0);
      expect(outcome.pagesAnalyzed).toBe(doc.pages.length);
    });
  }

  it("fails only the affected section on a malformed model response", async () => {
    const doc = EVAL_DOCS.find((d) => d.id === "malformed-model-response");
    if (doc === undefined) {
      throw new Error("missing eval fixture");
    }
    let calls = 0;
    const outcome = await analyzePages(doc.pages, async () => {
      calls += 1;
      return "definitely not json{{{";
    });
    // One retry, then the section fails: never a silent clean bill of health.
    expect(calls).toBe(2);
    expect(outcome.findings).toEqual([]);
    expect(outcome.limited).toBe(true);
    expect(outcome.sectionErrors).toEqual([{ sectionId: "s1", code: "bad_response" }]);
    expect(outcome.stats.sectionsFailed).toBe(1);
  });
});
