import { describe, expect, it } from "vitest";
import { normalizeText } from "@/lib/evidence";
import { loadDataset } from "@/lib/eval/loader";

/**
 * Ground-truth self-check over the shipped dataset. Every expected quote must
 * occur verbatim (whitespace-normalized) in the claimed fixture pages, so a
 * correct model output can always verify.
 */
describe("shipped evaluation dataset", () => {
  it("contains 30 fixtures with balanced labels and full category coverage", async () => {
    const dataset = await loadDataset("evals/fixtures");
    expect(dataset.version).toBe("1.0.0");
    expect(dataset.fixtures).toHaveLength(30);
    const labels = dataset.fixtures.map((f) => f.label);
    expect(labels.filter((l) => l === "positive")).toHaveLength(10);
    expect(labels.filter((l) => l === "negative")).toHaveLength(10);
    expect(labels.filter((l) => l === "challenging")).toHaveLength(10);

    const scored = dataset.fixtures.filter((f) => !f.expected.ambiguous);
    const covered = new Set(scored.flatMap((f) => f.expected.categories));
    expect(covered).toEqual(new Set(["change_of_control", "uncapped_liability", "missing_signature"]));
  });

  it("quotes occur verbatim on the claimed pages with rationales and unique ids", async () => {
    const dataset = await loadDataset("evals/fixtures");
    const ids = new Set<string>();
    for (const fixture of dataset.fixtures) {
      expect(ids.has(fixture.id)).toBe(false);
      ids.add(fixture.id);
      expect(fixture.expected.rationale.trim().length).toBeGreaterThan(20);
      const byPage = new Map(fixture.pages.map((p) => [p.pageNumber, normalizeText(p.text).toLowerCase()]));
      for (const entry of fixture.expected.evidence) {
        const quote = normalizeText(entry.quote).toLowerCase();
        const foundOn = [...byPage.entries()].filter(([, text]) => text.includes(quote)).map(([n]) => n);
        expect(foundOn.length).toBeGreaterThan(0);
        for (const page of entry.pages) {
          expect(foundOn).toContain(page);
        }
      }
    }
  });

  it("marks genuinely uncertain cases ambiguous and keeps traps scored", async () => {
    const dataset = await loadDataset("evals/fixtures");
    const ambiguous = dataset.fixtures.filter((f) => f.expected.ambiguous).map((f) => f.id).sort();
    expect(ambiguous).toEqual([
      "ch-cap-01",
      "ch-coc-01",
      "ch-coc-02",
      "ch-lia-01",
      "ch-mix-01",
      "ch-neg-03",
      "ch-sig-01",
    ]);
    const scoredChallenging = dataset.fixtures
      .filter((f) => f.label === "challenging" && !f.expected.ambiguous)
      .map((f) => f.id)
      .sort();
    expect(scoredChallenging).toEqual(["ch-lia-02", "ch-neg-01", "ch-neg-02"]);
  });

  it("uses only fictional parties (no real-company leakage spot check)", async () => {
    const dataset = await loadDataset("evals/fixtures");
    const corpus = dataset.fixtures.map((f) => f.pages.map((p) => p.text).join("\n")).join("\n");
    for (const leaked of ["OpenAI", "Anthropic", "Google", "Microsoft", "Goldman", "SSN", "0815-"]) {
      expect(corpus).not.toContain(leaked);
    }
  });
});
