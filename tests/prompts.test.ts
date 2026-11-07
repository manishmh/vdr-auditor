import { describe, expect, it } from "vitest";
import { CandidateFindingSchema } from "@/lib/findings/schema";
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
  FINDINGS_JSON_SCHEMA,
} from "@/lib/inference/prompts";

describe("analysis prompts", () => {
  it("instructs the model to ignore embedded instructions and stay grounded", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/untrusted/i);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/ignore any instructions embedded/i);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/only findings supported/i);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/JSON/);
  });

  it("adds explicit JSON instructions for models without structured outputs", () => {
    const plain = buildAnalysisUserPrompt({
      sections: [{ id: "s1", text: "Some clause text.", pageStart: 1, pageEnd: 1 }],
      categories: ["change_of_control"],
    });
    const withJson = buildAnalysisUserPrompt(
      {
        sections: [{ id: "s1", text: "Some clause text.", pageStart: 1, pageEnd: 1 }],
        categories: ["change_of_control"],
      },
      { jsonInPrompt: true },
    );
    expect(plain).not.toContain('"findings"');
    expect(withJson).toContain('"findings"');
    expect(withJson).toContain("missing_signature");
    expect(withJson).toContain('{"findings": []}');
    expect(withJson).toContain("Some clause text.");
  });

  it("builds a user prompt with categories, page ranges, and section text", () => {
    const prompt = buildAnalysisUserPrompt({
      sections: [
        { id: "s1", text: "Change of control clause text here.", pageStart: 1, pageEnd: 2 },
        { id: "s2", text: "Payment terms text here.", pageStart: 2, pageEnd: 2 },
      ],
      categories: ["change_of_control"],
    });
    expect(prompt).toContain("change_of_control");
    expect(prompt).toContain("Change of control clause text here.");
    expect(prompt).toContain("pages 1-2");
    expect(prompt).not.toContain("uncapped_liability");
  });
});

describe("FINDINGS_JSON_SCHEMA", () => {
  it("declares the finding shape the pipeline validates", () => {
    const props = FINDINGS_JSON_SCHEMA.properties.findings.items.properties;
    expect(FINDINGS_JSON_SCHEMA.required).toEqual(["findings"]);
    expect(props.category.enum).toContain("change_of_control");
    expect(props.category.enum).toContain("uncapped_liability");
    expect(props.category.enum).toContain("missing_signature");
    expect(props.severity.enum).toEqual(["critical", "high", "medium", "low"]);
    // A sample conforming to the JSON schema must also pass the Zod schema.
    expect(
      CandidateFindingSchema.safeParse({
        category: "uncapped_liability",
        severity: "medium",
        title: "t",
        explanation: "e",
        evidence: "quoted text",
        recommendedAction: "a",
      }).success,
    ).toBe(true);
  });
});
