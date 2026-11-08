import type { Request, Response } from "express";
import { seedDemoDocument } from "../../../lib/demo";
import { getProvider, getStore } from "../context";

/** Seed the clearly-labeled synthetic demo document (idempotent). Disabled in production. */
export async function seedDemo(_req: Request, res: Response): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    res.status(403).json({ error: "Demo seeding is disabled in production." });
    return;
  }
  try {
    const outcome = await seedDemoDocument(await getStore(), getProvider());
    res.status(outcome.created ? 201 : 200).json({
      document: outcome.document,
      findings: outcome.findings,
      created: outcome.created,
    });
  } catch (err) {
    console.error(
      `[api] demo seed failed: ${err instanceof Error ? `${err.constructor.name}: ${err.message}` : "unknown error"}`,
    );
    res.status(500).json({ error: "Demo seeding failed." });
  }
}
