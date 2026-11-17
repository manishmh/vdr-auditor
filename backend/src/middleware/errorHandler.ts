import type { NextFunction, Request, Response } from "express";

function isBodyParseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "entity.parse.failed"
  );
}

/** Final error handler. Logs server-side, returns a generic JSON shape. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error("Unhandled request error:", err);
  if (res.headersSent) {
    return;
  }
  if (isBodyParseError(err)) {
    res
      .status(400)
      .json({ error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }
  res.status(500).json({ error: "internal_error" });
}

/** JSON 404 for unknown routes. */
export function notFoundHandler(
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  res.status(404).json({ error: "not_found" });
}
