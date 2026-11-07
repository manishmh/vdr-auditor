import { promises as fs } from "node:fs";
import path from "node:path";
import type { StoredFinding } from "../findings/schema";
import { StoredFindingSchema } from "../findings/schema";
import type { PageText } from "../pdf/extract";
import {
  assertDocumentId,
  DocumentRecordSchema,
  type DocSource,
  type DocumentRecord,
  type DocumentStore,
  type FindingPatch,
} from "./types";

/**
 * DEMO-ONLY file store. Persists uploads, extracted text, and findings as
 * local JSON files for development and evaluation. Single-process, no
 * encryption, no access control. Production use requires the MongoDB store
 * plus auth, encryption, and retention controls.
 */
export class LocalFileStore implements DocumentStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private docDir(id: string): string {
    return path.join(this.root, "documents", assertDocumentId(id));
  }

  private async readJson<T>(file: string, parse: (v: unknown) => T): Promise<T | null> {
    try {
      return parse(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  }

  async createDocument(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    source: DocSource;
  }): Promise<DocumentRecord> {
    const now = new Date().toISOString();
    const record: DocumentRecord = {
      id: crypto.randomUUID(),
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      status: "queued",
      statusDetail: null,
      pageCount: null,
      findingCount: 0,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeJson(path.join(this.docDir(record.id), "meta.json"), record);
    return record;
  }

  async getDocument(id: string): Promise<DocumentRecord | null> {
    return this.readJson(path.join(this.docDir(id), "meta.json"), (v) => DocumentRecordSchema.parse(v));
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(this.root, "documents"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: DocumentRecord[] = [];
    for (const entry of entries) {
      try {
        const record = await this.getDocument(entry);
        if (record) records.push(record);
      } catch {
        continue; // Skip unreadable/corrupt entries; never fail the whole list.
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateDocument(
    id: string,
    patch: Partial<Pick<DocumentRecord, "status" | "statusDetail" | "pageCount" | "findingCount">>,
  ): Promise<DocumentRecord | null> {
    const current = await this.getDocument(id);
    if (!current) return null;
    const updated: DocumentRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.writeJson(path.join(this.docDir(id), "meta.json"), updated);
    return updated;
  }

  async saveOriginal(id: string, bytes: Uint8Array): Promise<void> {
    const dir = this.docDir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "original.pdf"), bytes);
  }

  async getOriginal(id: string): Promise<Uint8Array | null> {
    try {
      const buf = await fs.readFile(path.join(this.docDir(id), "original.pdf"));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async savePages(id: string, pages: PageText[]): Promise<void> {
    return this.writeJson(path.join(this.docDir(id), "pages.json"), pages);
  }

  async getPages(id: string): Promise<PageText[] | null> {
    return this.readJson(path.join(this.docDir(id), "pages.json"), (v) => {
      if (!Array.isArray(v)) throw new Error("Corrupt pages.json");
      return v as PageText[];
    });
  }

  async saveFindings(id: string, findings: StoredFinding[]): Promise<void> {
    return this.writeJson(path.join(this.docDir(id), "findings.json"), findings);
  }

  async getFindings(documentId: string): Promise<StoredFinding[] | null> {
    return this.readJson(path.join(this.docDir(documentId), "findings.json"), (v) =>
      zArray(v),
    );
  }

  async updateFinding(documentId: string, findingId: string, patch: FindingPatch): Promise<StoredFinding | null> {
    const findings = await this.getFindings(documentId);
    if (!findings) return null;
    const index = findings.findIndex((f) => f.id === findingId);
    if (index === -1) return null;
    const updated: StoredFinding = {
      ...findings[index],
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.reviewerNote !== undefined ? { reviewerNote: patch.reviewerNote } : {}),
      updatedAt: new Date().toISOString(),
    };
    findings[index] = StoredFindingSchema.parse(updated);
    await this.saveFindings(documentId, findings);
    return findings[index];
  }

  async deleteDocument(id: string): Promise<boolean> {
    try {
      await fs.rm(this.docDir(id), { recursive: true, force: false });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}

function zArray(v: unknown): StoredFinding[] {
  if (!Array.isArray(v)) throw new Error("Corrupt findings.json");
  return v.map((item) => StoredFindingSchema.parse(item));
}
