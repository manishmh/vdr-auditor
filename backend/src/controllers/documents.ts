import type { Request, Response } from "express";
import { getConfig } from "../../../lib/config";
import { FindingUpdateSchema } from "../../../lib/findings/schema";
import { sanitizeDisplayName, UploadValidationError } from "../../../lib/pdf/validate";
import { processUpload } from "../../../lib/pipeline";
import { assertDocumentId, assertFindingId } from "../../../lib/store/types";
import { getProvider, getStore } from "../context";

/** Single route segment as a string (Express types allow string[]). */
function segment(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

export async function listDocuments(_req: Request, res: Response): Promise<void> {
  const documents = await (await getStore()).listDocuments();
  res.json({ documents });
}

export async function uploadDocument(req: Request, res: Response): Promise<void> {
  const config = getConfig();
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "Missing 'file' in form data." });
    return;
  }
  if (file.size > config.MAX_UPLOAD_BYTES) {
    res.status(413).json({
      error: `File exceeds the ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
      reason: "too_large",
    });
    return;
  }
  try {
    const outcome = await processUpload(
      await getStore(),
      getProvider(),
      { filename: file.originalname, mimeType: file.mimetype, bytes: new Uint8Array(file.buffer) },
      config,
    );
    res.status(201).json({
      document: outcome.document,
      findings: outcome.findings,
      droppedInvalid: outcome.droppedInvalid,
      droppedUnverified: outcome.droppedUnverified,
    });
  } catch (err) {
    if (err instanceof UploadValidationError) {
      res.status(err.status).json({ error: err.message, reason: err.reason });
      return;
    }
    console.error(
      `[api] upload failed: ${err instanceof Error ? `${err.constructor.name}: ${err.message}` : "unknown error"}`,
    );
    res.status(500).json({ error: "Upload failed unexpectedly." });
  }
}

export async function getDocument(req: Request, res: Response): Promise<void> {
  let id: string;
  try {
    id = assertDocumentId(segment(req.params.id));
  } catch {
    res.status(400).json({ error: "Invalid document id." });
    return;
  }
  const store = await getStore();
  const document = await store.getDocument(id);
  if (!document) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  const findings = (await store.getFindings(id)) ?? [];
  res.json({ document, findings });
}

export async function deleteDocument(req: Request, res: Response): Promise<void> {
  let id: string;
  try {
    id = assertDocumentId(segment(req.params.id));
  } catch {
    res.status(400).json({ error: "Invalid document id." });
    return;
  }
  const deleted = await (await getStore()).deleteDocument(id);
  if (!deleted) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  console.info(`[api] deleted document id=${id}`);
  res.json({ deleted: true });
}

export async function downloadOriginal(req: Request, res: Response): Promise<void> {
  let id: string;
  try {
    id = assertDocumentId(segment(req.params.id));
  } catch {
    res.status(400).json({ error: "Invalid document id." });
    return;
  }
  const store = await getStore();
  const [document, bytes] = await Promise.all([store.getDocument(id), store.getOriginal(id)]);
  if (!document || !bytes) {
    res.status(404).json({ error: "File not available." });
    return;
  }
  const body = Buffer.from(bytes);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Content-Disposition", `attachment; filename="${sanitizeDisplayName(document.filename)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).send(body);
}

export async function patchFinding(req: Request, res: Response): Promise<void> {
  let id: string;
  let findingId: string;
  try {
    id = assertDocumentId(segment(req.params.id));
    findingId = assertFindingId(segment(req.params.findingId));
  } catch {
    res.status(400).json({ error: "Invalid document or finding id." });
    return;
  }
  const parsed = FindingUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid update." });
    return;
  }
  const updated = await (await getStore()).updateFinding(id, findingId, parsed.data);
  if (!updated) {
    res.status(404).json({ error: "Finding not found." });
    return;
  }
  res.json({ finding: updated });
}
