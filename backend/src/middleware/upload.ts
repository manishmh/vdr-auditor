import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { getConfig } from "../../../lib/config";
import { isDeclaredBodyTooLarge, UPLOAD_LENGTH_SLACK_BYTES } from "../../../lib/pdf/validate";

/** Reject declared oversized bodies before multer buffers anything. */
export function checkDeclaredBodySize(req: Request, res: Response, next: NextFunction): void {
  const maxBytes = getConfig().MAX_UPLOAD_BYTES;
  if (isDeclaredBodyTooLarge(req.headers["content-length"] ?? null, maxBytes)) {
    res.status(413).json({
      error: `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
      reason: "too_large",
    });
    return;
  }
  next();
}

/** Single-file memory upload. Multer enforces the byte cap during parsing. */
export function uploadSingleFile() {
  const maxBytes = getConfig().MAX_UPLOAD_BYTES;
  return multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: maxBytes + UPLOAD_LENGTH_SLACK_BYTES },
  }).single("file");
}

export function isMulterError(err: unknown): err is MulterError {
  return err instanceof MulterError;
}
