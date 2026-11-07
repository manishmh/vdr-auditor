import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDataset } from "@/lib/eval/loader";

let dir: string;

const VERSION = { version: "9.9.9" };

function validFixture(id: string): object {
  return {
    id,
    label: "negative",
    title: "t",
    pages: [{ pageNumber: 1, text: "clean text" }],
    expected: { categories: [], ambiguous: false, evidence: [], rationale: "r" },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vdr-eval-dataset-"));
  await writeFile(join(dir, "version.json"), JSON.stringify(VERSION));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadDataset", () => {
  it("loads and validates fixtures in deterministic id order", async () => {
    await writeFile(join(dir, "b.json"), JSON.stringify(validFixture("b")));
    await writeFile(join(dir, "a.json"), JSON.stringify(validFixture("a")));
    const dataset = await loadDataset(dir);
    expect(dataset.version).toBe("9.9.9");
    expect(dataset.fixtures.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("rejects a missing directory", async () => {
    await expect(loadDataset(join(dir, "nope"))).rejects.toThrow(/Cannot read dataset/);
  });

  it("rejects a missing version file", async () => {
    const bare = await mkdtemp(join(tmpdir(), "vdr-eval-bare-"));
    try {
      await expect(loadDataset(bare)).rejects.toThrow(/version\.json/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("rejects an empty dataset", async () => {
    await expect(loadDataset(dir)).rejects.toThrow(/no fixtures/);
  });

  it("rejects malformed JSON", async () => {
    await writeFile(join(dir, "bad.json"), "{oops");
    await expect(loadDataset(dir)).rejects.toThrow(/Malformed JSON in bad\.json/);
  });

  it("rejects schema-invalid fixtures", async () => {
    await writeFile(join(dir, "bad.json"), JSON.stringify({ ...validFixture("x"), label: "wrong" }));
    await expect(loadDataset(dir)).rejects.toThrow(/Invalid fixture bad\.json/);
  });

  it("rejects duplicate ids, bad pages, and uncovered categories", async () => {
    await writeFile(join(dir, "a.json"), JSON.stringify(validFixture("dup")));
    await writeFile(join(dir, "b.json"), JSON.stringify(validFixture("dup")));
    await expect(loadDataset(dir)).rejects.toThrow(/Duplicate fixture id dup/);
    await rm(join(dir, "b.json"));

    const badPage = validFixture("c") as Record<string, unknown>;
    (badPage as { expected: { categories: string[]; ambiguous: boolean; evidence: object[]; rationale: string } }).expected = {
      categories: ["change_of_control"],
      ambiguous: false,
      evidence: [{ category: "change_of_control", quote: "q", pages: [7], severity: "high" }],
      rationale: "r",
    };
    await writeFile(join(dir, "c.json"), JSON.stringify(badPage));
    await expect(loadDataset(dir)).rejects.toThrow(/page 7 does not exist/);
    await rm(join(dir, "c.json"));

    const uncovered = validFixture("d") as Record<string, unknown>;
    (uncovered as { expected: { categories: string[]; ambiguous: boolean; evidence: object[]; rationale: string } }).expected = {
      categories: ["change_of_control"],
      ambiguous: false,
      evidence: [],
      rationale: "r",
    };
    await writeFile(join(dir, "d.json"), JSON.stringify(uncovered));
    await expect(loadDataset(dir)).rejects.toThrow(/has no evidence entry/);
  });

  it("ignores non-JSON files", async () => {
    await writeFile(join(dir, "a.json"), JSON.stringify(validFixture("a")));
    await writeFile(join(dir, "notes.txt"), "hello");
    await mkdir(join(dir, "subdir"));
    const dataset = await loadDataset(dir);
    expect(dataset.fixtures).toHaveLength(1);
  });
});
