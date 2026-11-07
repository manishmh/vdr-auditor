import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_FILENAME, seedDemoDocument } from "@/lib/demo";
import { MockInferenceProvider } from "@/lib/inference/mock";
import { LocalFileStore } from "@/lib/store/local";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vdr-demo-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("seedDemoDocument", () => {
  it("seeds a labeled demo covering all three risk categories", async () => {
    const outcome = await seedDemoDocument(new LocalFileStore(dir), new MockInferenceProvider());
    expect(outcome.created).toBe(true);
    expect(outcome.document.source).toBe("demo");
    expect(outcome.document.filename).toBe(DEMO_FILENAME);
    expect(outcome.document.status).toBe("completed");
    const categories = new Set(outcome.findings.map((f) => f.category));
    expect(categories).toContain("change_of_control");
    expect(categories).toContain("uncapped_liability");
    expect(categories).toContain("missing_signature");
    for (const f of outcome.findings) {
      expect(f.pageStart).not.toBeNull();
    }
    expect(await new LocalFileStore(dir).getOriginal(outcome.document.id)).toBeNull();
  });

  it("is idempotent", async () => {
    const store = new LocalFileStore(dir);
    const provider = new MockInferenceProvider();
    const first = await seedDemoDocument(store, provider);
    const second = await seedDemoDocument(store, provider);
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(await store.listDocuments()).toHaveLength(1);
  });
});
