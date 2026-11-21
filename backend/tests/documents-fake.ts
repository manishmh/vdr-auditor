import type { Db, Filter } from "mongodb";
import { ObjectId } from "mongodb";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { DocumentRecord } from "../src/models/document.js";
import type { MatterDocument } from "../src/models/matter.js";

export interface DocumentsFakeState {
  matters: MatterDocument[];
  documents: DocumentRecord[];
}

export interface FakeDocumentsCollection {
  createIndex: Mock;
  insertOne: Mock;
  findOne: Mock;
  find: Mock;
  updateOne: Mock;
  deleteOne: Mock;
  deleteMany: Mock;
}

export interface DocumentsFake {
  db: Db;
  state: DocumentsFakeState;
  matters: FakeDocumentsCollection;
  documents: FakeDocumentsCollection;
  blackhole: FakeDocumentsCollection;
}

type SortSpec = Record<string, 1 | -1>;

function filterId(filter: unknown): unknown {
  if (typeof filter !== "object" || filter === null) {
    return undefined;
  }
  return (filter as { _id?: unknown })._id;
}

function idEquals(docId: ObjectId, wanted: unknown): boolean {
  return wanted instanceof ObjectId && docId.equals(wanted);
}

function sortByCreatedAt(docs: DocumentRecord[], spec: SortSpec): DocumentRecord[] {
  const direction = spec["createdAt"] ?? -1;
  return [...docs].sort((a, b) =>
    direction === -1
      ? b.createdAt.getTime() - a.createdAt.getTime()
      : a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

function createCollectionSpies(): FakeDocumentsCollection {
  return {
    createIndex: vi.fn(async () => "index_created"),
    insertOne: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
  };
}

export function createDocumentsFake(): DocumentsFake {
  const state: DocumentsFakeState = { matters: [], documents: [] };
  const matters = createCollectionSpies();
  const documents = createCollectionSpies();

  matters.findOne.mockImplementation(async (filter: Filter<MatterDocument>) => {
    return state.matters.find((m) => idEquals(m._id, filterId(filter))) ?? null;
  });
  matters.deleteOne.mockImplementation(async (filter: Filter<MatterDocument>) => {
    const index = state.matters.findIndex((m) => idEquals(m._id, filterId(filter)));
    if (index === -1) {
      return { acknowledged: true, deletedCount: 0 };
    }
    state.matters.splice(index, 1);
    return { acknowledged: true, deletedCount: 1 };
  });

  documents.insertOne.mockImplementation(async (doc: DocumentRecord) => {
    state.documents.push({ ...doc });
    return { acknowledged: true, insertedId: doc._id };
  });
  documents.findOne.mockImplementation(async (filter: Filter<DocumentRecord>) => {
    const record = filter as { _id?: ObjectId; matterId?: ObjectId };
    return (
      state.documents.find(
        (d) =>
          (record._id === undefined || d._id.equals(record._id)) &&
          (record.matterId === undefined || d.matterId.equals(record.matterId)),
      ) ?? null
    );
  });
  documents.find.mockImplementation((filter: Filter<DocumentRecord>) => {
    const record = filter as { matterId?: ObjectId; _id?: { $in?: ObjectId[] } };
    let scoped = state.documents;
    if (record.matterId !== undefined) {
      scoped = scoped.filter((d) => d.matterId.equals(record.matterId));
    }
    const idClause = record._id;
    const ids =
      typeof idClause === "object" && idClause !== null && "$in" in idClause
        ? ((idClause as { $in?: ObjectId[] }).$in ?? [])
        : undefined;
    if (ids !== undefined) {
      scoped = scoped.filter((d) => ids.some((id) => d._id.equals(id)));
    }
    return {
      sort: (spec: SortSpec) => ({
        toArray: async () => sortByCreatedAt(scoped, spec),
      }),
      toArray: async () => [...scoped],
    };
  });
  documents.updateOne.mockImplementation(
    async (
      filter: Filter<DocumentRecord>,
      update: { $set?: Partial<DocumentRecord>; $unset?: Record<string, unknown> },
    ) => {
      const doc = state.documents.find((d) => idEquals(d._id, filterId(filter)));
      if (doc === undefined) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      if (update.$set !== undefined) {
        Object.assign(doc, update.$set);
      }
      if (update.$unset !== undefined) {
        const record = doc as unknown as Record<string, unknown>;
        for (const key of Object.keys(update.$unset)) {
          delete record[key];
        }
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
  );
  documents.deleteOne.mockImplementation(async (filter: Filter<DocumentRecord>) => {
    const index = state.documents.findIndex((d) => idEquals(d._id, filterId(filter)));
    if (index === -1) {
      return { acknowledged: true, deletedCount: 0 };
    }
    state.documents.splice(index, 1);
    return { acknowledged: true, deletedCount: 1 };
  });
  documents.deleteMany.mockImplementation(async (filter: Filter<DocumentRecord>) => {
    const record = filter as { _id?: ObjectId; matterId?: ObjectId };
    let removed = 0;
    for (let index = state.documents.length - 1; index >= 0; index -= 1) {
      const doc = state.documents[index] as DocumentRecord;
      const idOk = record._id === undefined || idEquals(doc._id, record._id);
      const matterOk =
        record.matterId === undefined || doc.matterId.equals(record.matterId);
      if (idOk && matterOk) {
        state.documents.splice(index, 1);
        removed += 1;
      }
    }
    return { acknowledged: true, deletedCount: removed };
  });

  const blackhole = {
    createIndex: vi.fn(async () => "index_created"),
    insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: new ObjectId() })),
    findOne: vi.fn(async () => null),
    find: vi.fn(() => ({
      sort: () => ({ toArray: async () => [] }),
      toArray: async () => [],
    })),
    updateOne: vi.fn(async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 })),
    deleteOne: vi.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    deleteMany: vi.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    findOneAndUpdate: vi.fn(async () => null),
  };
  const db = {
    collection: (name: string) => {
      if (name === "matters") {
        return matters;
      }
      if (name === "documents") {
        return documents;
      }
      return blackhole;
    },
  } as unknown as Db;
  return { db, state, matters, documents, blackhole };
}
