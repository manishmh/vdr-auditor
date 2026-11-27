import type { Collection, Db, ObjectId } from "mongodb";
import type { UpdateFilter } from "mongodb";
import {
  extractPdfText,
  type ExtractionFailureCode,
} from "./service.js";
import {
  toDocumentResponse,
  type DocumentRecord,
  type MatterDocument,
} from "../models/document.js";
import { readPdfBytes } from "../storage/gridfs.js";

export type ExtractionJobOutcome =
  | { ok: true; status: "completed" | "no_text"; document: MatterDocument }
  | {
      ok: false;
      code:
        | "not_found"
        | "in_progress"
        | "unavailable"
        | "internal"
        | ExtractionFailureCode;
    };

export function extractionFailureMessage(code: ExtractionFailureCode): string {
  switch (code) {
    case "encrypted":
      return "This PDF is password-protected and cannot be read.";
    case "limit_exceeded":
      return "This PDF exceeds extraction limits.";
    case "unparseable":
      return "This PDF could not be read.";
  }
}

/**
 * Run text extraction for one document. Shared by the HTTP endpoint and the
 * background processing driver, so both paths persist identical state.
 * Safe to retry: only a completed attempt overwrites a previous result, and
 * infrastructure failures restore the previous status.
 */
export async function runExtractionJob(
  documents: Collection<DocumentRecord>,
  db: Db,
  matterId: ObjectId,
  docId: ObjectId,
): Promise<ExtractionJobOutcome> {
  const doc = await documents.findOne({ _id: docId, matterId });
  if (doc === null) {
    return { ok: false, code: "not_found" };
  }
  const previousStatus = doc.extractionStatus ?? "pending";
  if (previousStatus === "processing") {
    return { ok: false, code: "in_progress" };
  }
  const restoreStatus = async (): Promise<void> => {
    await documents
      .updateOne(
        { _id: docId },
        { $set: { extractionStatus: previousStatus, updatedAt: new Date() } },
      )
      .catch(() => undefined);
  };
  try {
    await documents.updateOne(
      { _id: docId },
      { $set: { extractionStatus: "processing", updatedAt: new Date() } },
    );
  } catch (err: unknown) {
    console.error("extract status update failed:", err);
    return { ok: false, code: "unavailable" };
  }
  let bytes: Buffer | undefined;
  try {
    bytes = await readPdfBytes(db, docId);
  } catch (err: unknown) {
    console.error("extract GridFS read failed:", err);
    await restoreStatus();
    return { ok: false, code: "unavailable" };
  }
  if (bytes === undefined) {
    console.error("extract found record without GridFS bytes:", docId.toHexString());
    await restoreStatus();
    return { ok: false, code: "internal" };
  }
  const result = await extractPdfText(bytes);
  if (!result.ok) {
    if (previousStatus !== "completed") {
      try {
        await documents.updateOne(
          { _id: docId },
          {
            $set: {
              extractionStatus: "failed",
              extractionError: result.code,
              updatedAt: new Date(),
            },
            $unset: { extractedText: "" },
          },
        );
      } catch (err: unknown) {
        console.error("extract failure persist failed:", err);
        await restoreStatus();
        return { ok: false, code: "unavailable" };
      }
    } else {
      // A failed retry must not erase the earlier successful result.
      await restoreStatus();
    }
    return { ok: false, code: result.code };
  }
  const extractedAt = new Date();
  const outcome: UpdateFilter<DocumentRecord> =
    result.status === "no_text"
      ? {
          $set: {
            extractionStatus: "no_text" as const,
            pageCount: result.pageCount,
            extractedAt,
            updatedAt: extractedAt,
          },
          $unset: { extractedText: "", extractionError: "" } as const,
        }
      : {
          $set: {
            extractionStatus: "completed" as const,
            extractedText: result.text,
            pageCount: result.pageCount,
            pageOffset: result.pageOffset,
            extractedAt,
            updatedAt: extractedAt,
          },
          $unset: { extractionError: "" } as const,
        };
  try {
    await documents.updateOne({ _id: docId }, outcome);
  } catch (err: unknown) {
    console.error("extract result persist failed:", err);
    await restoreStatus();
    return { ok: false, code: "unavailable" };
  }
  return {
    ok: true,
    status: result.status,
    document: toDocumentResponse({
      ...doc,
      extractionStatus: result.status,
      pageCount: result.pageCount,
      pageOffset: result.status === "completed" ? result.pageOffset : doc.pageOffset,
      extractedAt,
      updatedAt: extractedAt,
      extractedText: result.status === "completed" ? result.text : undefined,
      extractionError: undefined,
    }),
  };
}
