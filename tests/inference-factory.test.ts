import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { BasetenProvider } from "@/lib/inference/baseten";
import { getInferenceProvider } from "@/lib/inference/index";
import { MockInferenceProvider } from "@/lib/inference/mock";

describe("getInferenceProvider", () => {
  it("returns the mock provider by default", () => {
    const provider = getInferenceProvider(getConfig({} as NodeJS.ProcessEnv));
    expect(provider).toBeInstanceOf(MockInferenceProvider);
    expect(provider.modelId).toBe("mock-v1");
  });

  it("returns the Baseten provider with the configured model, never a substitute", () => {
    const config = getConfig({
      INFERENCE_PROVIDER: "baseten",
      BASETEN_API_KEY: "key",
      BASETEN_MODEL_ID: "some-org/some-model",
    } as unknown as NodeJS.ProcessEnv);
    const provider = getInferenceProvider(config);
    expect(provider).toBeInstanceOf(BasetenProvider);
    expect(provider).not.toBeInstanceOf(MockInferenceProvider);
    expect(provider.modelId).toBe("some-org/some-model");
  });
});
