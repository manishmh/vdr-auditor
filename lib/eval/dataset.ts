import { z } from "zod";
import { RiskCategorySchema, SeveritySchema } from "../../lib/findings/schema";

export const FixturePageSchema = z.object({
  pageNumber: z.number().int().positive(),
  text: z.string(),
});
export type FixturePage = z.infer<typeof FixturePageSchema>;

export const ExpectedEvidenceSchema = z.object({
  category: RiskCategorySchema,
  /** Exact passage from the fixture text, verified by the fixture self-check. */
  quote: z.string().min(1),
  pages: z.array(z.number().int().positive()).min(1),
  severity: SeveritySchema,
});
export type ExpectedEvidence = z.infer<typeof ExpectedEvidenceSchema>;

const ExpectedSchema = z.object({
  categories: z.array(RiskCategorySchema),
  /**
   * Ambiguous fixtures are still executed but excluded from aggregate detection
   * metrics; they are reported separately so reasonable uncertainty is not
   * penalized. Their categories/evidence are reference labels only.
   */
  ambiguous: z.boolean(),
  evidence: z.array(ExpectedEvidenceSchema),
  rationale: z.string().min(1),
});

export const FixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "fixture id must be lowercase slug"),
    label: z.enum(["positive", "negative", "challenging"]),
    title: z.string().min(1),
    pages: z.array(FixturePageSchema).min(1),
    expected: ExpectedSchema,
  })
  .superRefine((fixture, ctx) => {
    const categories = fixture.expected.categories;
    if (new Set(categories).size !== categories.length) {
      ctx.addIssue({ code: "custom", message: `fixture ${fixture.id}: expected categories must be unique` });
    }
    const pageNumbers = new Set(fixture.pages.map((p) => p.pageNumber));
    for (const entry of fixture.expected.evidence) {
      for (const page of entry.pages) {
        if (!pageNumbers.has(page)) {
          ctx.addIssue({ code: "custom", message: `fixture ${fixture.id}: evidence page ${page} does not exist` });
        }
      }
      if (!categories.includes(entry.category)) {
        ctx.addIssue({
          code: "custom",
          message: `fixture ${fixture.id}: evidence category ${entry.category} is not in expected categories`,
        });
      }
    }
    if (!fixture.expected.ambiguous) {
      for (const category of categories) {
        if (!fixture.expected.evidence.some((e) => e.category === category)) {
          ctx.addIssue({
            code: "custom",
            message: `fixture ${fixture.id}: expected category ${category} has no evidence entry`,
          });
        }
      }
    }
  });
export type EvalFixture = z.infer<typeof FixtureSchema>;

export const DatasetVersionSchema = z.object({ version: z.string().min(1) });

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetError";
  }
}
