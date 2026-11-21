import { describe, expect, it } from "vitest";
import {
  ANALYSIS_MAX_FINDINGS_PER_RUN,
  ANALYSIS_MAX_FINDINGS_PER_SECTION,
  analyzePages,
  parseFindingsResponse,
  parseModelFinding,
  splitIntoSections,
  verifyFinding,
  type RawModelFinding,
} from "../src/ai/analysis.js";
import { MetaError } from "../src/ai/metaClient.js";

function rawFinding(overrides: Partial<RawModelFinding> = {}): RawModelFinding {
  return {
    category: "change_of_control",
    severity: "high",
    title: "Assignment requires consent",
    explanation: "The clause requires consent before assignment.",
    excerpt: "Neither party may assign without consent.",
    page: 1,
    counterEvidence: null,
    uncertainty: null,
    ...overrides,
  };
}

describe("splitIntoSections", () => {
  it("groups small pages into one section with a page range", () => {
    const sections = splitIntoSections(["aaa", "bbb", "ccc"], { maxChars: 70 });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ id: "s1", pageStart: 1, pageEnd: 3 });
    expect(sections[0]?.text).toContain("aaa");
    expect(sections[0]?.text).toContain("ccc");
  });

  it("splits over budget at paragraph boundaries", () => {
    const sections = splitIntoSections(["a".repeat(50), "b".repeat(50)], { maxChars: 60 });
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ id: "s1", pageStart: 1, pageEnd: 1 });
    expect(sections[1]).toMatchObject({ id: "s2", pageStart: 2, pageEnd: 2 });
  });

  it("prefers starting sections at clause headings", () => {
    const filler = "f".repeat(40);
    const sections = splitIntoSections(
      [`${filler}\n\n${filler}`, "Section 2. Liability.\n\nThe liability clause text here."],
      { maxChars: 200 },
    );
    expect(sections).toHaveLength(2);
    expect(sections[1]?.text).toContain("Section 2. Liability.");
  });

  it("hard-splits a giant paragraph with overlap", () => {
    const sections = splitIntoSections(["x".repeat(100)], { maxChars: 30, overlap: 5 });
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.pageStart === 1 && s.pageEnd === 1)).toBe(true);
    expect(sections[0]?.text).toHaveLength(30);
    // Overlap: the second chunk restarts inside the first chunk's tail.
    expect(sections[1]?.text).toBe("x".repeat(30));
  });

  it("skips blank paragraphs", () => {
    const sections = splitIntoSections(["\n\n   \n\nReal text here."], { maxChars: 100 });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toBe("Real text here.");
  });
});

describe("parseModelFinding", () => {
  it("accepts a valid finding", () => {
    expect(parseModelFinding(rawFinding())).toEqual(rawFinding());
  });

  it("rejects bad enums, shapes, and lengths", () => {
    expect(parseModelFinding({ ...rawFinding(), category: "other" })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), severity: "critical" })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), title: "" })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), title: "t".repeat(201) })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), explanation: "" })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), excerpt: "" })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), excerpt: "short" })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), page: 0 })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), page: 1.5 })).toBeUndefined();
    expect(parseModelFinding({ ...rawFinding(), counterEvidence: 42 })).toBeUndefined();
    expect(parseModelFinding("nope")).toBeUndefined();
    expect(parseModelFinding(null)).toBeUndefined();
  });

  it("accepts null page and notes", () => {
    const parsed = parseModelFinding(rawFinding({ page: null }));
    expect(parsed?.page).toBeNull();
  });

  it("tolerates missing note keys as null", () => {
    const { counterEvidence: _c, uncertainty: _u, ...rest } = rawFinding();
    expect(parseModelFinding(rest)).toEqual(rawFinding());
  });
});

describe("parseFindingsResponse", () => {
  it("parses a findings envelope", () => {
    const parsed = parseFindingsResponse(JSON.stringify({ findings: [rawFinding()] }));
    expect(parsed).toEqual({ items: [rawFinding()], capped: false });
  });

  it("accepts an empty findings list", () => {
    expect(parseFindingsResponse(JSON.stringify({ findings: [] }))).toEqual({
      items: [],
      capped: false,
    });
  });

  it("tolerates fenced JSON with surrounding prose", () => {
    const parsed = parseFindingsResponse(
      `Here are the results:\n\`\`\`json\n${JSON.stringify({ findings: [rawFinding()] })}\n\`\`\`\nDone.`,
    );
    expect(parsed?.items).toEqual([rawFinding()]);
  });

  it("caps oversized responses instead of failing", () => {
    const parsed = parseFindingsResponse(
      JSON.stringify({ findings: Array.from({ length: 21 }, () => rawFinding()) }),
    );
    expect(parsed?.capped).toBe(true);
    expect(parsed?.items).toHaveLength(ANALYSIS_MAX_FINDINGS_PER_SECTION);
  });

  it("rejects structurally unusable output", () => {
    expect(parseFindingsResponse("not json")).toBeUndefined();
    expect(parseFindingsResponse(JSON.stringify({}))).toBeUndefined();
    expect(parseFindingsResponse(JSON.stringify({ findings: "x" }))).toBeUndefined();
  });
});

describe("verifyFinding", () => {
  const full = "alpha beta gamma delta";
  const pages = ["alpha beta", "gamma delta"];

  it("keeps grounded findings with valid pages", () => {
    const verified = verifyFinding(rawFinding({ excerpt: "beta gamma", page: 1 }), full, pages);
    // "beta gamma" spans the page boundary, so the page is unavailable.
    expect(verified?.page).toBeNull();
    expect(verified?.excerpt).toBe("beta gamma");
  });

  it("keeps the page when the excerpt sits on it", () => {
    const verified = verifyFinding(rawFinding({ excerpt: "alpha beta", page: 1 }), full, pages);
    expect(verified?.page).toBe(1);
  });

  it("matches case-insensitively", () => {
    const verified = verifyFinding(rawFinding({ excerpt: "ALPHA BETA", page: 1 }), full, pages);
    expect(verified?.excerpt).toBe("ALPHA BETA");
    expect(verified?.page).toBe(1);
  });

  it("drops invented excerpts", () => {
    expect(verifyFinding(rawFinding({ excerpt: "no such clause" }), full, pages)).toBeUndefined();
    expect(verifyFinding(rawFinding({ excerpt: "   " }), full, pages)).toBeUndefined();
  });

  it("marks out-of-range pages unavailable instead of guessing", () => {
    const verified = verifyFinding(rawFinding({ excerpt: "alpha", page: 9 }), full, pages);
    expect(verified?.page).toBeNull();
  });

  it("matches across whitespace differences", () => {
    const verified = verifyFinding(
      rawFinding({ excerpt: "alpha\n  beta", page: 1 }),
      "alpha beta",
      ["alpha beta"],
    );
    expect(verified?.excerpt).toBe("alpha\n  beta");
  });
});

describe("analyzePages", () => {
  const findingJson = (excerpt: string, page: number | null = 1): string =>
    JSON.stringify({
      findings: [rawFinding({ excerpt, page })],
    });

  it("analyzes sections and merges duplicates conservatively", async () => {
    const calls: string[][] = [];
    const outcome = await analyzePages(
      ["Neither party may assign without consent.", "Unrelated filler text here."],
      async (messages) => {
        calls.push(messages.map((m) => m.content));
        return findingJson("Neither party may assign without consent.", 1);
      },
      { sectionChars: 60 },
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.limited).toBe(false);
    expect(outcome.limitations).toEqual([]);
    expect(outcome.stats.findingsKept).toBe(1);
    expect(outcome.stats.sectionsFailed).toBe(0);
  });

  it("drops unverifiable findings while keeping the rest", async () => {
    const outcome = await analyzePages(["Real clause about assignment consent."], async () =>
      JSON.stringify({
        findings: [
          rawFinding({ excerpt: "Real clause about assignment consent.", page: 1 }),
          rawFinding({ excerpt: "Invented quotation never present.", page: 1 }),
        ],
      }),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.stats.findingsDroppedUnverified).toBe(1);
    expect(outcome.stats.findingsDroppedInvalid).toBe(0);
  });

  it("keeps valid findings when a sibling finding is malformed", async () => {
    const outcome = await analyzePages(["Real clause about assignment consent."], async () =>
      JSON.stringify({
        findings: [
          rawFinding({ excerpt: "Real clause about assignment consent.", page: 1 }),
          { ...rawFinding(), severity: "bogus" },
          "not an object",
        ],
      }),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.stats.findingsDroppedInvalid).toBe(2);
    // Rejected candidates are disclosed, so the run is limited, not clean.
    expect(outcome.limited).toBe(true);
    expect(outcome.limitations.join(" ")).toContain("2 candidate");
  });

  it("isolates section failures and keeps other sections' findings", async () => {
    const outcome = await analyzePages(
      ["a".repeat(50), "b".repeat(50)],
      async (_messages, meta) => {
        if (meta.sectionIndex === 0) {
          throw new MetaError("timeout", "slow");
        }
        return JSON.stringify({ findings: [] });
      },
      { sectionChars: 60 },
    );
    expect(outcome.stats.sectionsFailed).toBe(1);
    expect(outcome.stats.sectionsAnalyzed).toBe(1);
    expect(outcome.sectionErrors).toEqual([{ sectionId: "s1", code: "timeout" }]);
    expect(outcome.limited).toBe(true);
    expect(outcome.limitations.join(" ")).toContain("s1");
  });

  it("retries unusable output once, then fails only that section", async () => {
    let calls = 0;
    const outcome = await analyzePages(["a".repeat(50), "b".repeat(50)], async () => {
      calls += 1;
      return calls <= 2 ? "definitely not json{{" : JSON.stringify({ findings: [] });
    }, { sectionChars: 60 });
    expect(calls).toBe(3);
    expect(outcome.stats.sectionsFailed).toBe(1);
    expect(outcome.stats.sectionsAnalyzed).toBe(1);
    expect(outcome.sectionErrors).toEqual([{ sectionId: "s1", code: "bad_response" }]);
  });

  it("does not retry truncated sections", async () => {
    let calls = 0;
    const outcome = await analyzePages(["a".repeat(50), "b".repeat(50)], async () => {
      calls += 1;
      if (calls === 1) {
        throw new MetaError("truncated", "cut off");
      }
      return JSON.stringify({ findings: [] });
    }, { sectionChars: 60 });
    expect(calls).toBe(2);
    expect(outcome.sectionErrors).toEqual([{ sectionId: "s1", code: "truncated" }]);
    expect(outcome.limited).toBe(true);
  });

  it("stops remaining sections on fatal provider errors", async () => {
    let calls = 0;
    const outcome = await analyzePages(["a".repeat(40), "b".repeat(40), "c".repeat(40)], async () => {
      calls += 1;
      throw new MetaError("auth", "bad key", 401);
    }, { sectionChars: 50 });
    expect(calls).toBe(1);
    expect(outcome.fatal).toBe("auth");
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.stats.sectionsSkipped).toBe(2);
  });

  it("keeps earlier findings when a later section fails fatally", async () => {
    let calls = 0;
    const outcome = await analyzePages(["a".repeat(50), "b".repeat(50)], async () => {
      calls += 1;
      if (calls === 1) {
        return findingJson("a".repeat(50), 1);
      }
      throw new MetaError("bad_request", "rejected", 400);
    }, { sectionChars: 60 });
    expect(calls).toBe(2);
    expect(outcome.fatal).toBe("bad_request");
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.limited).toBe(true);
  });

  it("caps sections and reports the remainder", async () => {
    let calls = 0;
    const outcome = await analyzePages(["p1", "p2", "p3", "p4"], async () => {
      calls += 1;
      return JSON.stringify({ findings: [] });
    }, { sectionChars: 5, maxSections: 2 });
    expect(calls).toBe(2);
    expect(outcome.limited).toBe(true);
    expect(outcome.stats.sectionsSkipped).toBe(2);
    expect(outcome.limitations.join(" ")).toContain("2 of 4 sections");
  });

  it("caps total findings and stops analyzing", async () => {
    const pages = Array.from({ length: 12 }, (_, page) =>
      Array.from({ length: 10 }, (_, k) => `Distinct clause number ${page * 10 + k} here.`).join(" "),
    );
    let calls = 0;
    const outcome = await analyzePages(
      pages,
      async () => {
        const base = calls * ANALYSIS_MAX_FINDINGS_PER_SECTION;
        calls += 1;
        return JSON.stringify({
          findings: Array.from({ length: ANALYSIS_MAX_FINDINGS_PER_SECTION }, (_, i) =>
            rawFinding({ excerpt: `Distinct clause number ${base + i} here.`, page: null }),
          ),
        });
      },
      { sectionChars: 400 },
    );
    expect(outcome.findings).toHaveLength(ANALYSIS_MAX_FINDINGS_PER_RUN);
    expect(outcome.limited).toBe(true);
    expect(outcome.limitations.join(" ")).toContain("Finding limit");
    expect(outcome.stats.sectionsSkipped).toBeGreaterThan(0);
    expect(calls).toBeLessThan(12);
  });

  it("skips unstarted sections once the deadline passes", async () => {
    let calls = 0;
    const outcome = await analyzePages(["text one here", "text two here"], async () => {
      calls += 1;
      return JSON.stringify({ findings: [] });
    }, { deadlineMs: 1000, now: () => 2000 });
    expect(calls).toBe(0);
    expect(outcome.stats.sectionsSkipped).toBeGreaterThan(0);
    expect(outcome.limited).toBe(true);
    expect(outcome.limitations.join(" ")).toContain("deadline");
  });

  it("treats empty output as clean only after every section completes", async () => {
    const outcome = await analyzePages(["plain text with nothing notable"], async () =>
      JSON.stringify({ findings: [] }),
    );
    expect(outcome.findings).toEqual([]);
    expect(outcome.limited).toBe(false);
    expect(outcome.stats.sectionsFailed).toBe(0);
    expect(outcome.stats.sectionsSkipped).toBe(0);
  });

  it("reports cumulative progress as sections settle", async () => {
    const seen: Array<{ sectionsDone: number; sectionsTotal: number }> = [];
    await analyzePages(
      ["a".repeat(50), "b".repeat(50)],
      async () => JSON.stringify({ findings: [] }),
      {
        sectionChars: 60,
        onProgress: (progress) =>
          seen.push({
            sectionsDone: progress.sectionsDone,
            sectionsTotal: progress.sectionsTotal,
          }),
      },
    );
    expect(seen).toEqual([
      { sectionsDone: 0, sectionsTotal: 2 },
      { sectionsDone: 1, sectionsTotal: 2 },
      { sectionsDone: 2, sectionsTotal: 2 },
    ]);
  });

  it("merges duplicate findings across sections", async () => {
    const outcome = await analyzePages(
      ["Shared clause text here.", "Shared clause text here."],
      async () => findingJson("Shared clause text here.", null),
      { sectionChars: 30 },
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.stats.duplicatesMerged).toBeGreaterThanOrEqual(1);
  });
});
