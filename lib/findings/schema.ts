import { z } from "zod";
import { RISK_CATEGORY_IDS } from "../risks";

/** Severity and confidence are separate dimensions: a high-confidence extraction can be low severity. */
export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ReviewStatusSchema = z.enum(["open", "confirmed", "dismissed", "needs_legal_review"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const RiskCategorySchema = z.enum(RISK_CATEGORY_IDS);
export type RiskCategory = z.infer<typeof RiskCategorySchema>;

/**
 * One candidate finding as returned by an inference provider (LLM or mock).
 * `evidence` must be an exact quotation from the supplied document text.
 * `pageHint` is advisory only: the server re-resolves pages and rejects
 * quotations that do not occur in the extracted text.
 */
export const CandidateFindingSchema = z.object({
  category: RiskCategorySchema,
  severity: SeveritySchema,
  title: z.string().trim().min(1).max(200),
  explanation: z.string().trim().min(1).max(4000),
  evidence: z.string().trim().min(1).max(4000),
  pageHint: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1).optional(),
  recommendedAction: z.string().trim().min(1).max(2000),
});
export type CandidateFinding = z.infer<typeof CandidateFindingSchema>;

/** Top-level shape every inference provider must return (also used for the Baseten json_schema). */
export const InferenceResponseSchema = z.object({
  findings: z.array(CandidateFindingSchema).max(100),
});
export type InferenceResponse = z.infer<typeof InferenceResponseSchema>;

/** A verified, persisted finding. Pages were resolved server-side from extracted text. */
export const StoredFindingSchema = CandidateFindingSchema.omit({ pageHint: true }).extend({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  pageStart: z.number().int().positive().nullable(),
  pageEnd: z.number().int().positive().nullable(),
  status: ReviewStatusSchema,
  reviewerNote: z.string().max(4000).nullable(),
  modelId: z.string().max(200).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type StoredFinding = z.infer<typeof StoredFindingSchema>;

/** PATCH /api/findings/[id] body. */
export const FindingUpdateSchema = z.object({
  status: ReviewStatusSchema.optional(),
  reviewerNote: z.string().max(4000).nullable().optional(),
}).refine((v) => v.status !== undefined || v.reviewerNote !== undefined, {
  message: "Provide status and/or reviewerNote",
});
export type FindingUpdate = z.infer<typeof FindingUpdateSchema>;
