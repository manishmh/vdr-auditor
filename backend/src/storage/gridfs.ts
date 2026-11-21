import { GridFSBucket, type Db, type ObjectId } from "mongodb";
import { PDF_CONTENT_TYPE } from "../models/document.js";

/** GridFS bucket for PDF bytes (`pdfs.files` / `pdfs.chunks`). */
export const PDF_BUCKET_NAME = "pdfs";

function pdfBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: PDF_BUCKET_NAME });
}

/**
 * Store PDF bytes under `fileId`. Resolves only after the upload stream
 * finishes; the driver discards partial chunks when the stream errors, so a
 * rejection never leaves a half-written file behind.
 */
export async function storePdf(
  db: Db,
  fileId: ObjectId,
  filename: string,
  bytes: Buffer,
  matterIdHex: string,
): Promise<void> {
  const stream = pdfBucket(db).openUploadStreamWithId(fileId, filename, {
    metadata: { matterId: matterIdHex, contentType: PDF_CONTENT_TYPE },
  });
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.once("finish", () => resolve());
    stream.end(bytes);
  });
}

/**
 * Open a readable stream for stored PDF bytes. Missing files surface as a
 * stream error for the caller to handle.
 */
export function openPdfDownload(db: Db, fileId: ObjectId): NodeJS.ReadableStream {
  return pdfBucket(db).openDownloadStream(fileId);
}

function isFileNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const record = err as { code?: unknown; message?: unknown };
  return (
    record.code === "ENOENT" ||
    (typeof record.message === "string" &&
      record.message.startsWith("FileNotFound:"))
  );
}

/**
 * Read stored PDF bytes into memory, or undefined when the file is absent.
 * Other storage errors propagate to the caller.
 */
export async function readPdfBytes(
  db: Db,
  fileId: ObjectId,
): Promise<Buffer | undefined> {
  const stream = pdfBucket(db).openDownloadStream(fileId);
  return new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.once("error", (err: unknown) => {
      if (isFileNotFoundError(err)) {
        resolve(undefined);
      } else {
        reject(err instanceof Error ? err : new Error("GridFS read failed"));
      }
    });
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    stream.once("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Delete stored PDF bytes. Tolerates an already-absent file so that a
 * retried delete heals instead of failing forever.
 */
export async function deletePdf(db: Db, fileId: ObjectId): Promise<void> {
  const bucket = pdfBucket(db);
  const existing = await bucket.find({ _id: fileId }).limit(1).toArray();
  if (existing.length === 0) {
    return;
  }
  await bucket.delete(fileId);
}
