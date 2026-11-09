import { z } from "zod";
import type { ReviewStatus } from "../findings/schema";
import type { PageText } from "../pdf/extract";
import type { StoredFinding } from "../findings/schema";

export const DocStatusSchema = z.enum(["queued", "processing", "completed", "partial", "failed", "needs_ocr"]);
export type DocStatus = z.infer<typeof DocStatusSchema>;

export const DocSourceSchema = z.enum(["upload", "demo"]);
export type DocSource = z.infer<typeof DocSourceSchema>;

export const DocumentRecordSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  status: DocStatusSchema,
  statusDetail: z.string().nullable(),
  pageCount: z.number().int().positive().nullable(),
  findingCount: z.number().int().nonnegative(),
  source: DocSourceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DocumentRecord = z.infer<typeof DocumentRecordSchema>;

export interface FindingPatch {
  status?: ReviewStatus;
  reviewerNote?: string | null;
}

/** UUID gate: storage paths are derived only from validated IDs, never raw user input. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertDocumentId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`Invalid document id: ${id}`);
  return id;
}

export function assertFindingId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`Invalid finding id: ${id}`);
  return id;
}

/**
 * Persistence contract. Implemented for application runtime by the MongoDB
 * store in backend/src/repositories/mongo-store.ts; LocalFileStore
 * implements it in lib/ for isolated unit tests and the offline eval
 * harness only (never selected by runtime configuration).
 */
export interface DocumentStore {
  createDocument(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    source: DocSource;
  }): Promise<DocumentRecord>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  listDocuments(): Promise<DocumentRecord[]>;
  updateDocument(id: string, patch: Partial<Pick<DocumentRecord, "status" | "statusDetail" | "pageCount" | "findingCount">>): Promise<DocumentRecord | null>;
  saveOriginal(id: string, bytes: Uint8Array): Promise<void>;
  getOriginal(id: string): Promise<Uint8Array | null>;
  savePages(id: string, pages: PageText[]): Promise<void>;
  getPages(id: string): Promise<PageText[] | null>;
  saveFindings(id: string, findings: StoredFinding[]): Promise<void>;
  getFindings(documentId: string): Promise<StoredFinding[] | null>;
  updateFinding(documentId: string, findingId: string, patch: FindingPatch): Promise<StoredFinding | null>;
  deleteDocument(id: string): Promise<boolean>;
}
