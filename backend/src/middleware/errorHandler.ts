import type { NextFunction, Request, Response } from "express";

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
