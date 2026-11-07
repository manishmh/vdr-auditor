import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { UploadValidationError } from "../../../lib/pdf/validate";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found." });
}

/**
 * Central error handler. API failures keep the `{ error, reason? }`
 * contract; unexpected errors return a generic message (details stay in
 * server logs, which never carry secrets or document content).
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  // Express recognizes error middleware by its 4-arity signature; next is intentionally unused.
  void next;
  if (res.headersSent) return;
  if (err instanceof UploadValidationError) {
    res.status(err.status).json({ error: err.message, reason: err.reason });
    return;
  }
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File exceeds the size limit.", reason: "too_large" });
      return;
    }
    res.status(400).json({ error: "Request must be multipart form data with a 'file' field." });
    return;
  }
  if (isJsonParseError(err)) {
    res.status(400).json({ error: "Request body must be JSON." });
    return;
  }
  console.error(`[api] ${req.method} ${req.path} failed: ${err instanceof Error ? err.message : "unknown error"}`);
  res.status(500).json({ error: "Request failed unexpectedly." });
}

function isJsonParseError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    "status" in err &&
    ((err as { status?: unknown }).status === 400 || (err as { type?: unknown }).type === "entity.parse.failed")
  );
}
