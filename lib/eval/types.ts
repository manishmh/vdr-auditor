import type { StoredFinding } from "../findings/schema";
import type { SectionError } from "../inference/types";

/** Execution result for one fixture: the exact production pipeline outcome plus timing. */
export interface FixtureOutcome {
  fixtureId: string;
  status: "completed" | "partial" | "failed" | "skipped";
  latencyMs: number;
  findings: StoredFinding[];
  droppedInvalid: number;
  droppedUnverified: number;
  sectionErrors: SectionError[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  /** Harness- or provider-level failure detail (failed status only). Never contract text. */
  error?: string;
}

export interface TokenUsage {
  fixturesWithUsage: number;
  promptTokens: number;
  completionTokens: number;
}
