import { describe, expect, it, vi } from "vitest";
import nextConfig from "@/next.config";

/**
 * Regression test for the LAN/127.0.0.1 dev incident: without
 * `allowedDevOrigins` entries, Next.js serves those origins a
 * non-interactive page (blocked dev assets/HMR, no hydration), so uploads
 * and every other action silently do nothing while `GET /` returns 200.
 */
describe("next dev networking", () => {
  it("allows the supported local development origins", () => {
    const origins = nextConfig.allowedDevOrigins ?? [];
    expect(origins).toContain("127.0.0.1");
    expect(origins).toContain("172.20.10.4");
  });

  it("uses bare hostnames with no wildcards or production origins", () => {
    const origins = nextConfig.allowedDevOrigins ?? [];
    expect(origins.length).toBeGreaterThan(0);
    for (const entry of origins) {
      expect(entry).not.toContain("://");
      expect(entry).not.toContain(":");
      expect(entry).not.toContain("*");
    }
  });

  it("proxies /api/* to the local Express API only when no explicit API base is set", async () => {
    expect(typeof nextConfig.rewrites).toBe("function");
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    // Empty string is falsy: same-origin dev proxy must be active.
    const proxied = (await nextConfig.rewrites!()) as { source: string; destination: string }[];
    expect(proxied).toHaveLength(1);
    expect(proxied[0].source).toBe("/api/:path*");
    expect(proxied[0].destination).toBe("http://localhost:3001/api/:path*");

    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.com");
    const direct = (await nextConfig.rewrites!()) as unknown[];
    expect(direct).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});
