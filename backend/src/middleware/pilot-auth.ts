import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../../../lib/config";

/**
 * Single-tenant pilot access gate (Express edition of the former Next.js
 * route guard; same contract). When PILOT_ACCESS_TOKEN is configured, every
 * protected endpoint requires `Authorization: Bearer <token>` (timing-safe,
 * header only). NOT user authentication — see docs/security.md.
 */
export function pilotAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getConfig().PILOT_ACCESS_TOKEN;
  if (!token) {
    next();
    return;
  }
  const header = req.headers.authorization;
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (presented && timingSafeCompare(presented, token)) {
    next();
    return;
  }
  console.info(`[api] unauthorized ${req.method} ${req.path}`);
  res.setHeader("WWW-Authenticate", "Bearer");
  res.setHeader("Cache-Control", "private, no-store");
  res.status(401).json({ error: "Authentication required." });
}

function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
