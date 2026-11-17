import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  parseCreateMatter,
  parseMatterId,
  toMatterResponse,
  type MatterDocument,
} from "../src/models/matter.js";

describe("parseCreateMatter", () => {
  it("accepts a minimal payload and defaults status to active", () => {
    const result = parseCreateMatter({ title: "Smith merger review" });
    expect(result).toEqual({
      ok: true,
      value: { title: "Smith merger review", description: undefined, status: "active" },
    });
  });

  it("accepts a full payload with each status value", () => {
    for (const status of ["active", "on_hold", "completed"] as const) {
      const result = parseCreateMatter({
        title: "T",
        description: "Diligence checklist",
        status,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe(status);
        expect(result.value.description).toBe("Diligence checklist");
      }
    }
  });

  it("trims the title", () => {
    const result = parseCreateMatter({ title: "  padded  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("padded");
    }
  });

  it("accepts boundary lengths", () => {
    const result = parseCreateMatter({
      title: "t".repeat(120),
      description: "d".repeat(2000),
    });
    expect(result.ok).toBe(true);
  });

  it("ignores client-supplied ids, timestamps, and unknown fields", () => {
    const result = parseCreateMatter({
      title: "T",
      id: "64f1a2b3c4d5e6f7890abcde",
      createdAt: "2001-01-01T00:00:00.000Z",
      updatedAt: "2002-02-02T00:00:00.000Z",
      admin: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        title: "T",
        description: undefined,
        status: "active",
      });
    }
  });

  it("rejects a non-object body", () => {
    for (const body of [null, undefined, "nope", 42, ["title"]]) {
      const result = parseCreateMatter(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([
          { field: "body", message: "Request body must be a JSON object." },
        ]);
      }
    }
  });

  it("rejects a missing, non-string, or blank title", () => {
    for (const title of [undefined, null, 42, "", "   "]) {
      const result = parseCreateMatter({ title });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.field === "title")).toBe(true);
      }
    }
  });

  it("rejects an over-long title", () => {
    const result = parseCreateMatter({ title: "t".repeat(121) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { field: "title", message: "Title must be at most 120 characters." },
      ]);
    }
  });

  it("rejects a non-string or over-long description", () => {
    const nonString = parseCreateMatter({ title: "T", description: 42 });
    expect(nonString.ok).toBe(false);
    const overLong = parseCreateMatter({ title: "T", description: "d".repeat(2001) });
    expect(overLong.ok).toBe(false);
    if (!overLong.ok) {
      expect(overLong.issues).toEqual([
        {
          field: "description",
          message: "Description must be at most 2000 characters.",
        },
      ]);
    }
  });

  it("rejects an unknown status", () => {
    const result = parseCreateMatter({ title: "T", status: "archived" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          field: "status",
          message: "Status must be one of: active, on_hold, completed.",
        },
      ]);
    }
  });

  it("reports every invalid field at once", () => {
    const result = parseCreateMatter({ title: "", status: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.issues.map((i) => i.field).sort();
      expect(fields).toEqual(["status", "title"]);
    }
  });
});

describe("parseMatterId", () => {
  it("parses a valid 24-hex id", () => {
    const parsed = parseMatterId("64f1a2b3c4d5e6f7890abcde");
    expect(parsed).toBeInstanceOf(ObjectId);
    expect(parsed?.toHexString()).toBe("64f1a2b3c4d5e6f7890abcde");
  });

  it("returns undefined for malformed ids", () => {
    for (const id of ["", "not-an-id", "64f1a2b3c4d5e6f7890abcdeg", "x".repeat(24)]) {
      expect(parseMatterId(id)).toBeUndefined();
    }
  });
});

describe("toMatterResponse", () => {
  it("exposes the native id as a hex string and dates as ISO strings", () => {
    const doc: MatterDocument = {
      _id: new ObjectId("64f1a2b3c4d5e6f7890abcde"),
      title: "T",
      status: "on_hold",
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      updatedAt: new Date("2026-01-03T04:05:06.000Z"),
    };
    expect(toMatterResponse(doc)).toEqual({
      id: "64f1a2b3c4d5e6f7890abcde",
      title: "T",
      description: undefined,
      status: "on_hold",
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-03T04:05:06.000Z",
    });
    expect(toMatterResponse(doc)).not.toHaveProperty("_id");
  });
});
