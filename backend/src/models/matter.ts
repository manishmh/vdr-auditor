import { ObjectId } from "mongodb";

export const MATTER_STATUSES = ["active", "on_hold", "completed"] as const;
export type MatterStatus = (typeof MATTER_STATUSES)[number];

export const MATTER_TITLE_MAX_LENGTH = 120;
export const MATTER_DESCRIPTION_MAX_LENGTH = 2000;

/** Validated input for creating a matter. IDs and timestamps are server-owned. */
export interface CreateMatterInput {
  title: string;
  description?: string;
  status: MatterStatus;
}

/** Native MongoDB document shape. `_id` stays inside the backend. */
export interface MatterDocument {
  _id: ObjectId;
  title: string;
  description?: string;
  status: MatterStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** API response shape. The native ID is exposed consistently as `id`. */
export interface Matter {
  id: string;
  title: string;
  description?: string;
  status: MatterStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export type ParseResult =
  | { ok: true; value: CreateMatterInput }
  | { ok: false; issues: ValidationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is MatterStatus {
  return (
    typeof value === "string" &&
    (MATTER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Validate an untrusted request body. Unknown properties (including any
 * client-supplied `id`, `createdAt`, or `updatedAt`) are ignored: IDs and
 * timestamps are always server-generated.
 */
export function parseCreateMatter(body: unknown): ParseResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(body)) {
    return {
      ok: false,
      issues: [{ field: "body", message: "Request body must be a JSON object." }],
    };
  }

  let title = "";
  const rawTitle = body["title"];
  if (typeof rawTitle !== "string") {
    issues.push({ field: "title", message: "Title is required." });
  } else {
    title = rawTitle.trim();
    if (title === "") {
      issues.push({ field: "title", message: "Title must not be empty." });
    } else if (title.length > MATTER_TITLE_MAX_LENGTH) {
      issues.push({
        field: "title",
        message: `Title must be at most ${MATTER_TITLE_MAX_LENGTH} characters.`,
      });
    }
  }

  let description: string | undefined;
  const rawDescription = body["description"];
  if (rawDescription !== undefined) {
    if (typeof rawDescription !== "string") {
      issues.push({
        field: "description",
        message: "Description must be a string.",
      });
    } else if (rawDescription.length > MATTER_DESCRIPTION_MAX_LENGTH) {
      issues.push({
        field: "description",
        message: `Description must be at most ${MATTER_DESCRIPTION_MAX_LENGTH} characters.`,
      });
    } else {
      description = rawDescription;
    }
  }

  let status: MatterStatus = "active";
  const rawStatus = body["status"];
  if (rawStatus !== undefined) {
    if (!isStatus(rawStatus)) {
      issues.push({
        field: "status",
        message: `Status must be one of: ${MATTER_STATUSES.join(", ")}.`,
      });
    } else {
      status = rawStatus;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: { title, description, status } };
}

/**
 * Parse a route `:id` parameter into an ObjectId. Returns undefined for
 * malformed IDs so the route can answer HTTP 400.
 */
export function parseMatterId(id: string): ObjectId | undefined {
  if (!ObjectId.isValid(id)) {
    return undefined;
  }
  try {
    return new ObjectId(id);
  } catch {
    return undefined;
  }
}

export function toMatterResponse(doc: MatterDocument): Matter {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    description: doc.description,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
