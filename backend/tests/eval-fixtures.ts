/**
 * Deterministic analysis evaluation documents. Clause texts are adapted from
 * the previous implementation's eval set (vdr-auditor/evals/fixtures:
 * coc-01, sig-01, lia-01, neg-01, multi-01); category names use the current
 * schema (missing_signatures, uncapped_liabilities).
 */
export interface EvalDoc {
  id: string;
  pages: string[];
  expectedCategories: string[];
  expectedPages: Record<string, number>;
}

export const EVAL_DOCS: EvalDoc[] = [
  {
    id: "change-of-control",
    pages: [
      "MASTER SERVICES AGREEMENT\n\nThis Master Services Agreement is entered into by and between Alder Manufacturing Co. (\"Alder\") and Birchfield Labs LLC (\"Birchfield\").\n\nSection 8. Change of Control. In the event of a change of control of Birchfield, Alder may terminate this Agreement upon thirty (30) days written notice.\n\nExecuted by both parties. Signature: Dana Whitfield, CEO, Alder. Signature: Morgan Hale, Manager, Birchfield.",
    ],
    expectedCategories: ["change_of_control"],
    expectedPages: { change_of_control: 1 },
  },
  {
    id: "missing-signature",
    pages: [
      "EQUIPMENT LEASE\n\nBetween Kestrel Leasing and Larkspur Farms.\n\nSection 1. Equipment. Kestrel leases the harvester described in Schedule A to Larkspur for twelve months.",
      "IN WITNESS WHEREOF, the parties have executed this lease.\n\nKestrel Leasing\n\nSignature: __________\n\nName:\n\nTitle:\n\nDate:",
    ],
    expectedCategories: ["missing_signatures"],
    expectedPages: { missing_signatures: 2 },
  },
  {
    id: "uncapped-liability",
    pages: [
      "DATA PROCESSING ADDENDUM\n\nBetween Elmwood Systems and Fabrikam Partners.\n\nSection 4. Liability. Fabrikam's liability shall be unlimited for any breach of its data protection obligations under this addendum.\n\nSigned. Signature: Jordan Ellis, Fabrikam. Signature: Taylor Brooks, Elmwood.",
    ],
    expectedCategories: ["uncapped_liabilities"],
    expectedPages: { uncapped_liabilities: 1 },
  },
  {
    id: "clean",
    pages: [
      "SERVICES AGREEMENT\n\nBetween Union Printworks and Vale Logistics.\n\nSection 2. Services. Vale will provide warehousing services as described in Exhibit A.\n\nSection 5. Limitation of Liability. Neither party's liability shall exceed the fees paid in the twelve months before the claim.\n\nSigned. Signature: Jamie Fox, Union. Signature: Casey Bell, Vale.",
    ],
    expectedCategories: [],
    expectedPages: {},
  },
  {
    id: "multi-risk-across-pages",
    pages: [
      "DISTRIBUTION AGREEMENT\n\nBetween Orchard Supply and Pinecrest Goods.\n\nSection 5. Change of Control. If Pinecrest undergoes a change of control, Orchard may end this agreement immediately upon written notice.\n\nSignature: Riley Chen, Orchard.",
      "Section 12. Liability. Pinecrest's liability shall be unlimited for product safety claims arising under this agreement.\n\nSignature: Avery Stone, Pinecrest.",
    ],
    expectedCategories: ["change_of_control", "uncapped_liabilities"],
    expectedPages: { change_of_control: 1, uncapped_liabilities: 2 },
  },
  {
    id: "malformed-model-response",
    pages: ["RESELLER AGREEMENT\n\nBetween Northwind Traders and Southbay Goods.\n\nSection 1. Term. This agreement runs for twelve months."],
    expectedCategories: [],
    expectedPages: {},
  },
];
