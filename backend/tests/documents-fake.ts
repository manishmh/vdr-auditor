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
  deleteOne: Mock;
}

export interface DocumentsFake {
  db: Db;
  state: DocumentsFakeState;
  matters: FakeDocumentsCollection;
  documents: FakeDocumentsCollection;
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
    deleteOne: vi.fn(),
  };
}

export function createDocumentsFake(): DocumentsFake {
  const state: DocumentsFakeState = { matters: [], documents: [] };
  const matters = createCollectionSpies();
  const documents = createCollectionSpies();

  matters.findOne.mockImplementation(async (filter: Filter<MatterDocument>) => {
    return state.matters.find((m) => idEquals(m._id, filterId(filter))) ?? null;
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
    const record = filter as { matterId?: ObjectId };
    const scoped =
      record.matterId === undefined
        ? state.documents
        : state.documents.filter((d) => d.matterId.equals(record.matterId));
    return {
      sort: (spec: SortSpec) => ({
        toArray: async () => sortByCreatedAt(scoped, spec),
      }),
    };
  });
  documents.deleteOne.mockImplementation(async (filter: Filter<DocumentRecord>) => {
    const index = state.documents.findIndex((d) => idEquals(d._id, filterId(filter)));
    if (index === -1) {
      return { acknowledged: true, deletedCount: 0 };
    }
    state.documents.splice(index, 1);
    return { acknowledged: true, deletedCount: 1 };
  });

  const db = {
    collection: (name: string) => (name === "matters" ? matters : documents),
  } as unknown as Db;
  return { db, state, matters, documents };
}
