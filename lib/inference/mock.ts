import type { CandidateFinding } from "../findings/schema";
import type { RiskCategoryId } from "../risks";
import type { TextSection } from "../text/chunk";
import type { AnalyzeInput, AnalyzeResult, InferenceProvider } from "./types";

interface Rule {
  category: RiskCategoryId;
  pattern: RegExp;
  title: string;
  severity: CandidateFinding["severity"];
  confidence: number;
  explanation: string;
  recommendedAction: string;
}

/**
 * Deterministic stand-in for the Baseten LLM (Phase 2). Rule-based, no
 * randomness, no network: same input always yields the same candidates.
 * It cannot follow instructions embedded in document text — it only matches
 * clause patterns — which also models the Phase 2 untrusted-input requirement.
 */
export class MockInferenceProvider implements InferenceProvider {
  readonly modelId = "mock-v1";

  private readonly rules: Rule[] = [
    {
      category: "change_of_control",
      pattern: /change\s+of\s+control|change\s+in\s+(?:ownership|control)|upon\s+(?:a\s+)?change\s+of\s+ownership/gi,
      title: "Possible change-of-control provision",
      severity: "high",
      confidence: 0.55,
      explanation:
        "The text contains change-of-control or change-of-ownership language that may trigger consent, notice, or termination consequences. A reviewer must confirm the trigger, the parties, and the stated consequence.",
      recommendedAction: "Have counsel confirm what triggers this clause and what consent, notice, or termination rights follow.",
    },
    {
      category: "uncapped_liability",
      pattern: /unlimited\s+liability|liability\s+(?:of\s+a\s+party\s+)?(?:is\s+|shall\s+be\s+)?unlimited|without\s+(?:any\s+)?limit(?:ation)?\s+(?:of|on)\s+liability|no\s+(?:cap|limit)(?:\s+\w+){0,6}\s+liability/gi,
      title: "Potentially uncapped liability",
      severity: "high",
      confidence: 0.5,
      explanation:
        "The text suggests liability may be unlimited or uncapped in some respect. This is a detected condition, not a conclusion that the position is wrong — a reviewer must check caps, carve-outs, and interacting clauses.",
      recommendedAction: "Confirm whether a liability cap applies, note any carve-outs, and quantify the exposure if possible.",
    },
    {
      category: "uncapped_liability",
      pattern: /indemnif\w*\s[^.]{0,120}?(?:all|any|every)\s+(?:and\s+all\s+)?(?:losses|damages|claims|liabilities)/gi,
      title: "Broad indemnity language",
      severity: "medium",
      confidence: 0.45,
      explanation:
        "The text contains broad indemnity language that may expand liability exposure depending on its scope, caps, and exclusions.",
      recommendedAction: "Review the indemnity scope, beneficiaries, caps, and exclusions with counsel.",
    },
  ];

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const wanted = new Set(input.categories);
    const findings: CandidateFinding[] = [];

    for (const section of input.sections) {
      for (const rule of this.rules) {
        if (!wanted.has(rule.category)) continue;
        rule.pattern.lastIndex = 0;
        let count = 0;
        let match: RegExpExecArray | null;
        while ((match = rule.pattern.exec(section.text)) !== null && count < 2) {
          count++;
          findings.push({
            category: rule.category,
            severity: rule.severity,
            title: rule.title,
            explanation: rule.explanation,
            evidence: extractContext(section.text, match.index, match[0].length),
            confidence: rule.confidence,
            recommendedAction: rule.recommendedAction,
          });
          if (match[0].length === 0) rule.pattern.lastIndex++;
        }
      }
    }

    if (wanted.has("missing_signature")) {
      const signatureFinding = this.checkSignatures(input.sections);
      if (signatureFinding) findings.push(signatureFinding);
    }
    return { findings, sectionErrors: [] };
  }

  private checkSignatures(sections: TextSection[]): CandidateFinding | null {
    const fullText = sections.map((s) => s.text).join("\n\n");
    const blankBlock = /(?:signature|signed?)\s*[:_x[\]()\-.\s]{0,40}?(?:_{3,}|x{3,}|\[\s*(?:signature|sign here|to be signed)\s*\])/i.exec(fullText);
    if (blankBlock) {
      return {
        category: "missing_signature",
        severity: "medium",
        title: "Signature block appears blank",
        explanation:
          "A signature block was detected but appears unsigned or incomplete. Counterparts, e-signature certificates, or separate execution records may still complete execution — verify manually.",
        evidence: extractContext(fullText, blankBlock.index, blankBlock[0].length),
        confidence: 0.5,
        recommendedAction: "Confirm execution status: check for counterparts, e-signature records, and all required parties.",
      };
    }
    const hasIndicators = /in\s+witness\s+whereof|duly\s+executed|executed\s+as\s+of|signature|\/s\//i.test(fullText);
    if (!hasIndicators) {
      const tail = fullText.trim().slice(-400);
      if (tail.length < 10) return null;
      return {
        category: "missing_signature",
        severity: "low",
        title: "No signature indicators detected",
        explanation:
          "No signature block, execution language, or signature indicators were detected. The quoted passage shows how the document ends. This is a completeness signal, not a conclusion that the agreement is invalid.",
        evidence: tail,
        confidence: 0.4,
        recommendedAction: "Verify execution separately: look for signature pages, counterparts, or e-signature records.",
      };
    }
    return null;
  }
}

/** Expand a match to nearby sentence boundaries (capped) so evidence is readable. */
function extractContext(text: string, index: number, length: number, maxChars = 600): string {
  let start = index;
  let end = index + length;
  const back = text.lastIndexOf(". ", index - 1);
  start = back === -1 ? Math.max(0, index - 120) : Math.min(back + 2, index);
  const fwd = text.indexOf(". ", end);
  end = fwd === -1 ? Math.min(text.length, end + 120) : Math.min(fwd + 1, end + 400);
  let out = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd();
  return out;
}
