import type { CandidateFinding } from "../findings/schema";
import type { RiskCategoryId } from "../risks";
import type { TextSection } from "../text/chunk";

export interface AnalyzeInput {
  sections: TextSection[];
  categories: RiskCategoryId[];
  /** Display label used in errors/logs. Never document text. */
  documentLabel: string;
}

/** One document section the provider could not analyze. Never silently dropped. */
export interface SectionError {
  sectionId: string;
  message: string;
  /** Machine-readable failure code (e.g. "incomplete", "invalid_output") when known. */
  code?: string;
}

export interface AnalyzeResult {
  findings: CandidateFinding[];
  sectionErrors: SectionError[];
  /** Token usage summed across sections, when the API reports it. Absent for mock/local providers. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

/**
 * Inference provider contract. Implementations return candidate findings;
 * the pipeline Zod-validates each one and verifies its evidence against
 * extracted text before anything is persisted or shown. Sections that fail
 * (timeouts, rate limits, malformed output) are reported in sectionErrors
 * so the pipeline marks the document partial/failed instead of clean.
 */
export interface InferenceProvider {
  /** Stable identifier recorded on findings (e.g. "mock-v1", the Baseten model slug). */
  readonly modelId: string;
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
}
