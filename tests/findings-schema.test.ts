import { describe, expect, it } from "vitest";
import {
  CandidateFindingSchema,
  FindingUpdateSchema,
  InferenceResponseSchema,
  StoredFindingSchema,
} from "@/lib/findings/schema";

const VALID_CANDIDATE = {
  category: "change_of_control",
  severity: "high",
  title: "Possible change-of-control provision",
  explanation: "The text contains change-of-control language.",
  evidence: "In the event of a change of control, consent is required.",
  confidence: 0.8,
  recommendedAction: "Have counsel confirm the trigger.",
};

describe("CandidateFindingSchema", () => {
  it("accepts a valid candidate", () => {
    expect(CandidateFindingSchema.safeParse(VALID_CANDIDATE).success).toBe(true);
  });

  it("accepts an optional page hint and missing confidence", () => {
    expect(
      CandidateFindingSchema.safeParse({ ...VALID_CANDIDATE, confidence: undefined, pageHint: 3 })
        .success,
    ).toBe(true);
  });

  it("rejects unknown categories and severities", () => {
    expect(
      CandidateFindingSchema.safeParse({ ...VALID_CANDIDATE, category: "tax_fraud" }).success,
    ).toBe(false);
    expect(
      CandidateFindingSchema.safeParse({ ...VALID_CANDIDATE, severity: "extreme" }).success,
    ).toBe(false);
  });

  it("rejects out-of-range confidence and empty evidence", () => {
    expect(CandidateFindingSchema.safeParse({ ...VALID_CANDIDATE, confidence: 1.5 }).success).toBe(
      false,
    );
    expect(CandidateFindingSchema.safeParse({ ...VALID_CANDIDATE, evidence: "  " }).success).toBe(
      false,
    );
  });
});

describe("InferenceResponseSchema", () => {
  it("accepts a findings array and caps its size", () => {
    expect(InferenceResponseSchema.safeParse({ findings: [VALID_CANDIDATE] }).success).toBe(true);
    expect(
      InferenceResponseSchema.safeParse({ findings: Array(101).fill(VALID_CANDIDATE) }).success,
    ).toBe(false);
    expect(InferenceResponseSchema.safeParse({ findings: "nope" }).success).toBe(false);
  });
});

describe("StoredFindingSchema", () => {
  it("requires ids, resolved pages, and review metadata", () => {
    const stored = {
      ...VALID_CANDIDATE,
      id: "123e4567-e89b-12d3-a456-426614174000",
      documentId: "123e4567-e89b-12d3-a456-426614174001",
      pageStart: 2,
      pageEnd: 2,
      status: "open",
      reviewerNote: null,
      modelId: "mock-v1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(StoredFindingSchema.safeParse(stored).success).toBe(true);
    expect(StoredFindingSchema.safeParse({ ...stored, id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("FindingUpdateSchema", () => {
  it("accepts status and/or note updates, rejects empty ones", () => {
    expect(FindingUpdateSchema.safeParse({ status: "confirmed" }).success).toBe(true);
    expect(FindingUpdateSchema.safeParse({ reviewerNote: "checked" }).success).toBe(true);
    expect(FindingUpdateSchema.safeParse({}).success).toBe(false);
    expect(FindingUpdateSchema.safeParse({ status: "maybe" }).success).toBe(false);
  });
});
