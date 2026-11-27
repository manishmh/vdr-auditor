import { describe, expect, it } from "vitest";
import { formatDuration } from "../lib/format";

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(500)).toBe("1s");
    expect(formatDuration(48000)).toBe("48s");
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(192000)).toBe("3m 12s");
    expect(formatDuration(3720000)).toBe("1h 2m");
  });

  it("handles invalid input without throwing", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});
