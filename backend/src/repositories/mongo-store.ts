import { randomUUID } from "node:crypto";
import { Binary, Db, MongoServerError } from "mongodb";
import type { StoredFinding } from "../../../lib/findings/schema";
import type { PageText } from "../../../lib/pdf/extract";
import {
  assertDocumentId,
  assertFindingId,
  type DocSource,
  type DocumentRecord,
  type DocumentStore,
  type FindingPatch,
} from "../../../lib/store/types";

interface DocumentDoc {
  _id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  status: DocumentRecord["status"];
  statusDetail: string | null;
  pageCount: number | null;
  findingCount: number;
  source: DocSource;
  original?: Binary;
  pages?: PageText[];
  createdAt: Date;
  updatedAt: Date;
}

interface ReviewEventDoc {
  _id: string;
  documentId: string;
  findingId?: string | null;
  action: string;
  actor: string | null;
  note: string | null;
  createdAt: Date;
}

interface FindingDoc {
  _id: string;
  documentId: string;
  category: StoredFinding["category"];
  severity: StoredFinding["severity"];
  title: string;
  explanation: string;
  evidence: string;
  pageStart: number | null;
  pageEnd: number | null;
  confidence?: number;
  recommendedAction: string;
  status: StoredFinding["status"];
  reviewerNote: string | null;
  modelId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * MongoDB-backed DocumentStore. External UUIDs are the `_id` values, so
 * Mongo internals never leak into API contracts. No multi-document
 * transactions (works on standalone and Atlas alike); write sequences are
 * ordered so a crash can only leave fewer derived rows, never partial
 * primary records. Review events keep `actor: null` — still no per-user
 * identity (see docs/security.md).
 */
export class MongoStore implements DocumentStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async createDocument(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    source: DocSource;
  }): Promise<DocumentRecord> {
    const now = new Date();
    const doc: DocumentDoc = {
      _id: randomUUID(),
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.sha256,
      status: "queued",
      statusDetail: null,
      pageCount: null,
      findingCount: 0,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.db.collection<DocumentDoc>("documents").insertOne(doc);
    } catch (err) {
      throw mapWriteError(err);
    }
    return toDocumentRecord(doc);
  }

  async getDocument(id: string): Promise<DocumentRecord | null> {
    const doc = await this.db.collection<DocumentDoc>("documents").findOne(
      { _id: assertDocumentId(id) },
      { projection: { original: 0, pages: 0 } },
    );
    return doc ? toDocumentRecord(doc) : null;
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    const docs = await this.db.collection<DocumentDoc>("documents")
      .find({}, { projection: { original: 0, pages: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map(toDocumentRecord);
  }

  async updateDocument(
    id: string,
    patch: Partial<Pick<DocumentRecord, "status" | "statusDetail" | "pageCount" | "findingCount">>,
  ): Promise<DocumentRecord | null> {
    const update: Partial<DocumentDoc> & { updatedAt: Date } = { updatedAt: new Date() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.statusDetail !== undefined) update.statusDetail = patch.statusDetail;
    if (patch.pageCount !== undefined) update.pageCount = patch.pageCount;
    if (patch.findingCount !== undefined) update.findingCount = patch.findingCount;
    const row = await this.db.collection<DocumentDoc>("documents").findOneAndUpdate(
      { _id: assertDocumentId(id) },
      { $set: update },
      { returnDocument: "after", projection: { original: 0, pages: 0 } },
    );
    return row ? toDocumentRecord(row) : null;
  }

  async saveOriginal(id: string, bytes: Uint8Array): Promise<void> {
    const row = await this.db.collection<DocumentDoc>("documents").findOneAndUpdate(
      { _id: assertDocumentId(id) },
      { $set: { original: new Binary(Buffer.from(bytes)), updatedAt: new Date() } },
    );
    if (!row) throw new Error(`Cannot save original for missing document: ${id}`);
  }

  async getOriginal(id: string): Promise<Uint8Array | null> {
    const row = await this.db.collection<DocumentDoc>("documents").findOne(
      { _id: assertDocumentId(id) },
      { projection: { original: 1 } },
    );
    if (!row?.original) return null;
    return new Uint8Array(row.original.buffer);
  }

  async savePages(id: string, pages: PageText[]): Promise<void> {
    const row = await this.db.collection<DocumentDoc>("documents").findOneAndUpdate(
      { _id: assertDocumentId(id) },
      { $set: { pages, updatedAt: new Date() } },
    );
    if (!row) throw new Error(`Cannot save pages for missing document: ${id}`);
  }

  async getPages(id: string): Promise<PageText[] | null> {
    const row = await this.db.collection<DocumentDoc>("documents").findOne(
      { _id: assertDocumentId(id) },
      { projection: { pages: 1 } },
    );
    if (!row || row.pages == null) return null;
    return parsePages(row.pages);
  }

  async saveFindings(id: string, findings: StoredFinding[]): Promise<void> {
    assertDocumentId(id);
    const collection = this.db.collection<FindingDoc>("findings");
    await collection.deleteMany({ documentId: id });
    if (findings.length > 0) {
      try {
        await collection.insertMany(
          findings.map((f) => ({
            _id: f.id,
            documentId: id,
            category: f.category,
            severity: f.severity,
            title: f.title,
            explanation: f.explanation,
            evidence: f.evidence,
            pageStart: f.pageStart,
            pageEnd: f.pageEnd,
            ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
            recommendedAction: f.recommendedAction,
            status: f.status,
            reviewerNote: f.reviewerNote,
            modelId: f.modelId,
            createdAt: new Date(f.createdAt),
            updatedAt: new Date(f.updatedAt),
          })),
          { ordered: true },
        );
      } catch (err) {
        throw mapWriteError(err);
      }
    }
    await this.db.collection<DocumentDoc>("documents").updateOne(
      { _id: id },
      { $set: { findingCount: findings.length, updatedAt: new Date() } },
    );
  }

  async getFindings(documentId: string): Promise<StoredFinding[] | null> {
    const doc = await this.db.collection<DocumentDoc>("documents").findOne(
      { _id: assertDocumentId(documentId) },
      { projection: { _id: 1 } },
    );
    if (!doc) return null;
    const rows = await this.db.collection<FindingDoc>("findings")
      .find({ documentId })
      .sort({ createdAt: 1 })
      .toArray();
    return rows.map(toStoredFinding);
  }

  async updateFinding(
    documentId: string,
    findingId: string,
    patch: FindingPatch,
  ): Promise<StoredFinding | null> {
    assertDocumentId(documentId);
    assertFindingId(findingId);
    // Document-scoped read first: another document's finding is "not found"
    // in this scope (404), never an error and never updated.
    const existing = await this.db.collection<FindingDoc>("findings").findOne({ _id: findingId });
    if (!existing || existing.documentId !== documentId) return null;
    const update: Partial<FindingDoc> & { updatedAt: Date } = { updatedAt: new Date() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.reviewerNote !== undefined) update.reviewerNote = patch.reviewerNote;
    const row = await this.db.collection<FindingDoc>("findings").findOneAndUpdate(
      { _id: findingId },
      { $set: update },
      { returnDocument: "after" },
    );
    if (!row) return null;
    await this.db.collection<ReviewEventDoc>("reviewEvents").insertOne({
      _id: randomUUID(),
      documentId,
      findingId,
      action: patch.status !== undefined ? `finding.status:${patch.status}` : "finding.note",
      actor: null,
      note: patch.reviewerNote ?? null,
      createdAt: new Date(),
    });
    return toStoredFinding(row);
  }

  async deleteDocument(id: string): Promise<boolean> {
    assertDocumentId(id);
    const [doc] = await Promise.all([
      this.db.collection<DocumentDoc>("documents").deleteOne({ _id: id }),
      this.db.collection<FindingDoc>("findings").deleteMany({ documentId: id }),
      this.db.collection("reviewEvents").deleteMany({ documentId: id }),
    ]);
    return doc.deletedCount === 1;
  }
}

function mapWriteError(err: unknown): Error {
  if (err instanceof MongoServerError && err.code === 11000) {
    return new Error("Duplicate identifier: a record with this id already exists.");
  }
  return err instanceof Error ? err : new Error("Unexpected database error.");
}

function toDocumentRecord(row: DocumentDoc): DocumentRecord {
  return {
    id: row._id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.checksumSha256,
    status: row.status,
    statusDetail: row.statusDetail,
    pageCount: row.pageCount,
    findingCount: row.findingCount,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toStoredFinding(row: FindingDoc): StoredFinding {
  return {
    category: row.category,
    severity: row.severity,
    title: row.title,
    explanation: row.explanation,
    evidence: row.evidence,
    ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
    recommendedAction: row.recommendedAction,
    id: row._id,
    documentId: row.documentId,
    pageStart: row.pageStart,
    pageEnd: row.pageEnd,
    status: row.status,
    reviewerNote: row.reviewerNote,
    modelId: row.modelId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parsePages(value: unknown): PageText[] {
  if (!Array.isArray(value)) throw new Error("Corrupt pages payload: expected an array.");
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { pageNumber?: unknown }).pageNumber !== "number" ||
      typeof (entry as { text?: unknown }).text !== "string"
    ) {
      throw new Error("Corrupt pages payload: invalid page entry.");
    }
    const typed = entry as { pageNumber: number; text: string };
    return { pageNumber: typed.pageNumber, text: typed.text };
  });
}
