import type { Db, Filter } from "mongodb";
import { ObjectId as ObjectIdValue } from "mongodb";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { AnalysisRunRecord, FindingRecord } from "../src/models/analysis.js";
import { createDocumentsFake, type DocumentsFake } from "./documents-fake.js";

export interface FakeRunsCollection {
  createIndex: Mock;
  insertOne: Mock;
  findOne: Mock;
  find: Mock;
  updateOne: Mock;
  deleteMany: Mock;
}

export interface FakeFindingsCollection {
  createIndex: Mock;
  insertOne: Mock;
  insertMany: Mock;
  findOne: Mock;
  find: Mock;
  updateOne: Mock;
  deleteMany: Mock;
}

export interface AnalysesFake extends DocumentsFake {
  runState: AnalysisRunRecord[];
  findingState: FindingRecord[];
  runs: FakeRunsCollection;
  findings: FakeFindingsCollection;
}

function matchesFilter(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, wanted] of Object.entries(filter)) {
    const actual = doc[key];
    if (isInClause(wanted)) {
      if (!wanted.$in.some((id) => idEquals(actual, id))) {
        return false;
      }
    } else if (wanted instanceof ObjectIdValue) {
      if (!idEquals(actual, wanted)) {
        return false;
      }
    } else if (isLtClause(wanted)) {
      if (
        !(actual instanceof Date) ||
        !(wanted.$lt instanceof Date) ||
        actual.getTime() >= (wanted.$lt as Date).getTime()
      ) {
        return false;
      }
    } else if (actual !== wanted) {
      return false;
    }
  }
  return true;
}

function isLtClause(value: unknown): value is { $lt: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$lt" in value &&
    Object.keys(value).length === 1
  );
}

function isInClause(value: unknown): value is { $in: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$in" in value &&
    Array.isArray((value as { $in: unknown }).$in)
  );
}

function idEquals(actual: unknown, wanted: unknown): boolean {
  return (
    actual instanceof ObjectIdValue &&
    wanted instanceof ObjectIdValue &&
    actual.equals(wanted)
  );
}

function duplicateKeyError(): unknown {
  return Object.assign(new Error("duplicate key"), { code: 11000 });
}

export function createAnalysesFake(): AnalysesFake {
  const base = createDocumentsFake();
  const runState: AnalysisRunRecord[] = [];
  const findingState: FindingRecord[] = [];

  const runs: FakeRunsCollection = {
    createIndex: vi.fn(async () => "index_created"),
    insertOne: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
    deleteMany: vi.fn(),
  };
  const findings: FakeFindingsCollection = {
    createIndex: vi.fn(async () => "index_created"),
    insertOne: vi.fn(),
    insertMany: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
    deleteMany: vi.fn(),
  };

  runs.insertOne.mockImplementation(async (doc: AnalysisRunRecord) => {
    if (
      doc.status === "running" &&
      runState.some((r) => r.status === "running" && r.docId.equals(doc.docId))
    ) {
      throw duplicateKeyError();
    }
    runState.push({ ...doc });
    return { acknowledged: true, insertedId: doc._id };
  });
  const sortRuns = (docs: AnalysisRunRecord[], spec: Record<string, 1 | -1>): AnalysisRunRecord[] => {
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
  };
  runs.find.mockImplementation((filter: Filter<AnalysisRunRecord>) => {
    const scoped = runState.filter((r) =>
      matchesFilter(r as unknown as Record<string, unknown>, filter as Record<string, unknown>),
    );
    return {
      sort: (spec: Record<string, 1 | -1>) => ({
        toArray: async () => sortRuns(scoped, spec),
      }),
      toArray: async () => [...scoped],
    };
  });
  runs.findOne.mockImplementation(async (filter: Filter<AnalysisRunRecord>) => {
    return (
      runState.find((r) => matchesFilter(r as unknown as Record<string, unknown>, filter as Record<string, unknown>)) ??
      null
    );
  });
  runs.updateOne.mockImplementation(
    async (filter: Filter<AnalysisRunRecord>, update: { $set?: Partial<AnalysisRunRecord> }) => {
      const run = runState.find((r) =>
        matchesFilter(r as unknown as Record<string, unknown>, filter as Record<string, unknown>),
      );
      if (run === undefined) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      Object.assign(run, update.$set ?? {});
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
  );

  findings.insertMany.mockImplementation(async (docs: FindingRecord[]) => {
    for (const doc of docs) {
      findingState.push({ ...doc });
    }
    return { acknowledged: true, insertedCount: docs.length, insertedIds: {} };
  });
  findings.findOne.mockImplementation(async (filter: Filter<FindingRecord>) => {
    return (
      findingState.find((f) =>
        matchesFilter(f as unknown as Record<string, unknown>, filter as Record<string, unknown>),
      ) ?? null
    );
  });
  findings.find.mockImplementation((filter: Filter<FindingRecord>) => {
    const scopedFindings = findingState.filter((f) =>
      matchesFilter(f as unknown as Record<string, unknown>, filter as Record<string, unknown>),
    );
    return {
      toArray: async () => [...scopedFindings],
      sort: (spec: Record<string, 1 | -1>) => ({
        toArray: async () => {
          const first = Object.entries(spec)[0] as [string, 1 | -1] | undefined;
          if (first === undefined) {
            return [...scopedFindings];
          }
          const [key, direction] = first;
          return [...scopedFindings].sort((a, b) => {
            const left = (a as unknown as Record<string, Date>)[key]?.getTime() ?? 0;
            const right = (b as unknown as Record<string, Date>)[key]?.getTime() ?? 0;
            return direction === -1 ? right - left : left - right;
          });
        },
      }),
    };
  });
  const deleteMatching = <T extends { matterId: ObjectIdValue; _id: ObjectIdValue }>(
    state: T[],
    filter: Filter<T>,
  ): number => {
    const record = filter as {
      matterId?: ObjectIdValue;
      _id?: ObjectIdValue;
      docId?: ObjectIdValue;
      runId?: ObjectIdValue;
    };
    let removed = 0;
    for (let index = state.length - 1; index >= 0; index -= 1) {
      const item = state[index] as T & { docId?: ObjectIdValue; runId?: ObjectIdValue };
      const matterOk =
        record.matterId === undefined || item.matterId.equals(record.matterId);
      const idOk = record._id === undefined || item._id.equals(record._id);
      const docOk =
        record.docId === undefined ||
        (item.docId !== undefined && item.docId.equals(record.docId));
      const runOk =
        record.runId === undefined ||
        (item.runId !== undefined && item.runId.equals(record.runId));
      if (matterOk && idOk && docOk && runOk) {
        state.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  };
  runs.deleteMany.mockImplementation(async (filter: Filter<AnalysisRunRecord>) => ({
    acknowledged: true,
    deletedCount: deleteMatching(runState, filter),
  }));
  findings.deleteMany.mockImplementation(async (filter: Filter<FindingRecord>) => ({
    acknowledged: true,
    deletedCount: deleteMatching(findingState, filter),
  }));
  findings.updateOne.mockImplementation(
    async (filter: Filter<FindingRecord>, update: { $set?: Partial<FindingRecord> }) => {
      const finding = findingState.find((f) =>
        matchesFilter(f as unknown as Record<string, unknown>, filter as Record<string, unknown>),
      );
      if (finding === undefined) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      Object.assign(finding, update.$set ?? {});
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
  );

  const baseCollection = (base.db as unknown as { collection: (name: string) => unknown }).collection;
  const db = {
    collection: (name: string) => {
      if (name === "analysis_runs") {
        return runs;
      }
      if (name === "findings") {
        return findings;
      }
      return baseCollection(name);
    },
  } as unknown as Db;
  return { ...base, db, runState, findingState, runs, findings };
}
