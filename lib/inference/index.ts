import type { AppConfig } from "../config";
import { BasetenProvider } from "./baseten";
import { MockInferenceProvider } from "./mock";
import type { InferenceProvider } from "./types";

/**
 * Resolve the configured inference provider. Server-side only.
 * Baseten credentials come exclusively from env; requesting Baseten without
 * them fails loudly in config validation — the system never silently
 * substitutes a different model or falls back to the mock.
 */
export function getInferenceProvider(config: AppConfig): InferenceProvider {
  if (config.INFERENCE_PROVIDER === "mock") return new MockInferenceProvider();
  return new BasetenProvider({
    apiKey: config.BASETEN_API_KEY as string,
    modelId: config.BASETEN_MODEL_ID as string,
    baseUrl: config.BASETEN_BASE_URL,
    timeoutMs: config.BASETEN_TIMEOUT_MS,
    maxRetries: config.BASETEN_MAX_RETRIES,
    structuredOutputs: config.BASETEN_STRUCTURED_OUTPUTS,
  });
}
