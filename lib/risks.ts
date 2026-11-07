export const RISK_CATEGORIES = [
  {
    id: "change_of_control",
    label: "Change of control",
    description:
      "Clauses that may trigger termination rights, consent requirements, notice obligations, or other consequences when ownership or control changes.",
    reviewerGuidance:
      "Identify the trigger, affected party, and stated consequence. Not every change-of-control clause blocks a transaction.",
  },
  {
    id: "uncapped_liability",
    label: "Uncapped or broad liability",
    description:
      "Agreements with no apparent general liability cap, exceptions to a cap, broad indemnities, or exclusions that may materially increase exposure.",
    reviewerGuidance:
      "Record the cap amount or formula when stated, plus scope and exceptions. An uncapped position is a detected condition, not automatically a defect.",
  },
  {
    id: "missing_signature",
    label: "Missing or incomplete signature",
    description:
      "Likely missing signature blocks, incomplete execution pages, or apparent absence of a required party's signature.",
    reviewerGuidance:
      "Treat as a document-completeness signal, not a conclusion that the agreement is invalid. Counterparts, e-signature certificates, and separate execution records may need manual verification.",
  },
] as const;

export type RiskCategoryId = (typeof RISK_CATEGORIES)[number]["id"];

export const RISK_CATEGORY_IDS: readonly RiskCategoryId[] = RISK_CATEGORIES.map((c) => c.id);

export function getRiskCategory(id: string): (typeof RISK_CATEGORIES)[number] | undefined {
  return RISK_CATEGORIES.find((c) => c.id === id);
}
