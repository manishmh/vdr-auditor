import { promises as fs } from "node:fs";
import path from "node:path";
import { DatasetVersionSchema, FixtureSchema, DatasetError, type EvalFixture } from "./dataset";

export interface LoadedDataset {
  version: string;
  dir: string;
  fixtures: EvalFixture[];
}

/**
 * Load a fixture directory: version.json plus one JSON file per fixture.
 * Fixtures are validated with Zod and returned in deterministic id order.
 * Throws DatasetError for empty, missing, or malformed datasets.
 */
export async function loadDataset(dir: string): Promise<LoadedDataset> {
  const resolved = path.resolve(dir);
  let entries: string[];
  try {
    entries = await fs.readdir(resolved);
  } catch (err) {
    throw new DatasetError(`Cannot read dataset directory ${dir}: ${(err as Error).message}`);
  }
  if (!entries.includes("version.json")) {
    throw new DatasetError(`Dataset directory ${dir} is missing version.json`);
  }
  const versionRaw = await readJson(path.join(resolved, "version.json"), "version.json");
  const versionParsed = DatasetVersionSchema.safeParse(versionRaw);
  if (!versionParsed.success) {
    throw new DatasetError(`Invalid version.json: ${versionParsed.error.issues[0]?.message ?? "invalid"}`);
  }

  const fixtureFiles = entries.filter((e) => e.endsWith(".json") && e !== "version.json").sort();
  if (fixtureFiles.length === 0) {
    throw new DatasetError(`Dataset directory ${dir} contains no fixtures`);
  }
  const fixtures: EvalFixture[] = [];
  const seen = new Set<string>();
  for (const file of fixtureFiles) {
    const raw = await readJson(path.join(resolved, file), file);
    const parsed = FixtureSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DatasetError(
        `Invalid fixture ${file}: ${issue?.path.join(".") ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "invalid"}`,
      );
    }
    if (seen.has(parsed.data.id)) {
      throw new DatasetError(`Duplicate fixture id ${parsed.data.id} (${file})`);
    }
    seen.add(parsed.data.id);
    fixtures.push(parsed.data);
  }
  fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: versionParsed.data.version, dir: resolved, fixtures };
}

async function readJson(file: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    throw new DatasetError(`Cannot read ${label}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DatasetError(`Malformed JSON in ${label}`);
  }
}
