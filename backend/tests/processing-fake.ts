import type { Db, Filter } from "mongodb";
import { ObjectId as ObjectIdValue } from "mongodb";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { ProcessingRunRecord } from "../src/models/processing.js";
import { createAnalysesFake, type AnalysesFake } from "./analyses-fake.js";

export interface FakeProcessingRunsCollection {
  createIndex: Mock;
  insertOne: Mock;
  findOne: Mock;
  find: Mock;
  findOneAndUpdate: Mock;
  updateOne: Mock;
  deleteMany: Mock;
}

export interface ProcessingFake extends AnalysesFake {
  processingState: ProcessingRunRecord[];
  processingRuns: FakeProcessingRunsCollection;
}

function idEquals(actual: unknown, wanted: unknown): boolean {
  return (
    actual instanceof ObjectIdValue &&
    wanted instanceof ObjectIdValue &&
    actual.equals(wanted)
  );
}

function isExistsClause(value: unknown): value is { $exists: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$exists" in value &&
    typeof (value as { $exists: unknown }).$exists === "boolean" &&
    Object.keys(value).length === 1
  );
}

function fieldMatches(doc: Record<string, unknown>, key: string, wanted: unknown): boolean {
  const actual = doc[key];
  if (isExistsClause(wanted)) {
    const present = actual !== undefined;
    return wanted.$exists ? present : !present;
  }
  if (wanted instanceof ObjectIdValue) {
    return idEquals(actual, wanted);
  }
  if (typeof wanted === "object" && wanted !== null && "$in" in wanted) {
    const ids = (wanted as { $in?: unknown }).$in;
    return Array.isArray(ids) && ids.some((id) => idEquals(actual, id));
  }
  if (typeof wanted === "object" && wanted !== null && "$lt" in wanted) {
    const bound = (wanted as { $lt?: unknown }).$lt;
    return (
      actual instanceof Date && bound instanceof Date && actual.getTime() < bound.getTime()
    );
  }
  if (typeof wanted === "object" && wanted !== null && "$gte" in wanted) {
    const bound = (wanted as { $gte?: unknown }).$gte;
    return (
      actual instanceof Date && bound instanceof Date && actual.getTime() >= bound.getTime()
    );
  }
  return actual === wanted;
}

function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, wanted] of Object.entries(filter)) {
    if (key === "$or") {
      if (
        !Array.isArray(wanted) ||
        !wanted.some(
          (branch) =>
            typeof branch === "object" &&
            branch !== null &&
            matchesFilter(doc, branch as Record<string, unknown>),
        )
      ) {
        return false;
      }
      continue;
    }
    if (!fieldMatches(doc, key, wanted)) {
      return false;
    }
  }
  return true;
}

function duplicateKeyError(): unknown {
  return Object.assign(new Error("duplicate key"), { code: 11000 });
}

export function createProcessingFake(): ProcessingFake {
  const base = createAnalysesFake();
  const processingState: ProcessingRunRecord[] = [];

  const processingRuns: FakeProcessingRunsCollection = {
    createIndex: vi.fn(async () => "index_created"),
    insertOne: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    deleteMany: vi.fn(),
  };

  processingRuns.insertOne.mockImplementation(async (doc: ProcessingRunRecord) => {
    if (
      doc.active &&
      processingState.some((r) => r.active && r.docId.equals(doc.docId))
    ) {
      throw duplicateKeyError();
    }
    processingState.push({ ...doc });
    return { acknowledged: true, insertedId: doc._id };
  });
  processingRuns.findOne.mockImplementation(async (filter: Filter<ProcessingRunRecord>) => {
    return (
      processingState.find((r) =>
        matchesFilter(r as unknown as Record<string, unknown>, filter as Record<string, unknown>),
      ) ?? null
    );
  });
  processingRuns.find.mockImplementation((filter: Filter<ProcessingRunRecord>) => {
    const scoped = processingState.filter((r) =>
      matchesFilter(r as unknown as Record<string, unknown>, filter as Record<string, unknown>),
    );
    return {
      sort: (spec: Record<string, 1 | -1>) => ({
        limit: (n: number) => ({
          toArray: async () => sortByFirstKey(scoped, spec).slice(0, n),
        }),
        toArray: async () => sortByFirstKey(scoped, spec),
      }),
      toArray: async () => [...scoped],
    };
  });
  processingRuns.findOneAndUpdate.mockImplementation(
    async (
      filter: Filter<ProcessingRunRecord>,
      update: { $set?: Partial<ProcessingRunRecord> },
    ) => {
      const run = processingState.find((r) =>
        matchesFilter(r as unknown as Record<string, unknown>, filter as Record<string, unknown>),
      );
      if (run === undefined) {
        return null;
      }
      Object.assign(run, update.$set ?? {});
      return { ...run };
    },
  );
  processingRuns.updateOne.mockImplementation(
    async (filter: Filter<ProcessingRunRecord>, update: { $set?: Partial<ProcessingRunRecord> }) => {
      const run = processingState.find((r) =>
        matchesFilter(r as unknown as Record<string, unknown>, filter as Record<string, unknown>),
      );
      if (run === undefined) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      Object.assign(run, update.$set ?? {});
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
  );
  processingRuns.deleteMany.mockImplementation(async (filter: Filter<ProcessingRunRecord>) => {
    let removed = 0;
    for (let index = processingState.length - 1; index >= 0; index -= 1) {
      const item = processingState[index] as ProcessingRunRecord;
      if (matchesFilter(item as unknown as Record<string, unknown>, filter as Record<string, unknown>)) {
        processingState.splice(index, 1);
        removed += 1;
      }
    }
    return { acknowledged: true, deletedCount: removed };
  });

  const baseCollection = (base.db as unknown as { collection: (name: string) => unknown })
    .collection;
  const db = {
    collection: (name: string) => {
      if (name === "processing_runs") {
        return processingRuns;
      }
      return baseCollection(name);
    },
  } as unknown as Db;
  return { ...base, db, processingState, processingRuns };
}

function sortByFirstKey(
  docs: ProcessingRunRecord[],
  spec: Record<string, 1 | -1>,
): ProcessingRunRecord[] {
  const first = Object.entries(spec)[0] as [string, 1 | -1] | undefined;
  if (first === undefined) {
    return [...docs];
  }
  const [key, direction] = first;
  return [...docs].sort((a, b) => {
    const left = (a as unknown as Record<string, Date>)[key]?.getTime() ?? 0;
    const right = (b as unknown as Record<string, Date>)[key]?.getTime() ?? 0;
    return direction === -1 ? right - left : left - right;
  });
}
